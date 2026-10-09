import { createHash } from 'node:crypto';

import {
  adviceNotificationSummary,
  dateInShanghai,
  isHoliday,
  isWeekend,
  nextCronOccurrence,
  notificationText,
  notificationTime,
  type ReportBlock,
  ReportSchema,
  ReportScopeSchema,
  StrategyRecommendationBatchSummarySchema,
  type StrategySchedule,
  type ToolResult,
  type TradingPlan,
  type TradingPlanMonitoring,
  type TradingPlanReview,
  TradingPlanReviewSchema,
  tradingPlanVersionId,
} from '@luoome/core';
import { z } from 'zod';
import { currentStrategyFingerprint, getAccountPlanBatchStatus } from './account-plan-batch.js';
import { defineWorkflow, type WorkflowContext } from './define-workflow.js';
import { executeReportWorkflow, type ReportSectionPiece } from './internal/report-runner.js';
import {
  DAY_MS,
  localEvidence,
  marketPulse,
  missing,
  portfolioSection,
  previousTradingDay,
  shanghaiDate,
  unavailableSection,
} from './opening-report.js';

export const ClosingReportInput = z.object({
  date: z.string().date().optional(),
  scope: ReportScopeSchema.default({ kind: 'all-accounts' }),
  notify: z.boolean().optional(),
  mode: z.enum(['manual', 'scheduled']).default('manual'),
  planBatchStatus: z.enum(['complete', 'partial', 'blocked']).optional(),
});

export const ClosingReportOutput = z.object({
  report: ReportSchema,
  created: z.boolean(),
  workflowRunId: z.string(),
  notified: z.boolean(),
});

type ClosingInput = z.output<typeof ClosingReportInput>;
type ClosingOutput = z.output<typeof ClosingReportOutput>;

const nextTradingDay = (date: string): string => {
  const current = shanghaiDate(date);
  for (let offset = 1; offset <= 15; offset++) {
    const candidate = new Date(current.getTime() + offset * DAY_MS);
    if (!isWeekend(candidate) && !isHoliday(candidate)) return dateInShanghai(candidate);
  }
  throw new Error(`无法解析 ${date} 的下一 A 股交易日`);
};

const accountPerformance = async (
  input: ClosingInput,
  now: Date,
  ctx: WorkflowContext,
): Promise<ReportSectionPiece> => {
  const piece = await portfolioSection(input.scope, now, ctx, input.date);
  return {
    evidence: piece.evidence.map((item) => ({
      ...item,
      id: item.id.replace('overnight-portfolio', 'account-performance'),
      dimension: item.dimension.replace('overnight-portfolio', 'account-performance'),
    })),
    section: {
      ...piece.section,
      key: 'account-performance',
      title: '账户当日估值变化',
      evidenceIds: piece.section.evidenceIds.map((id) =>
        id.replace('overnight-portfolio', 'account-performance'),
      ),
      missingDimensions: piece.section.missingDimensions.map((item) => ({
        ...item,
        dimension: item.dimension.replace('overnight-portfolio', 'account-performance'),
      })),
    },
  };
};

const triggersSection = async (
  date: string,
  now: Date,
  ctx: WorkflowContext,
  scope: ClosingInput['scope'],
) => {
  const since = new Date(`${date}T00:00:00+08:00`);
  const until = new Date(since.getTime() + DAY_MS - 1);
  const result = await ctx.tools.list_watch_triggers.execute({ since, until, limit: 500 });
  if (!result.ok) {
    return unavailableSection(
      'important-triggers',
      '重要预警',
      true,
      now,
      'watch-triggers',
      result.error.kind,
    );
  }
  const triggers =
    scope.kind === 'account'
      ? result.data.triggers.filter(
          (trigger) => trigger.poolId === `trading-plan-watch:${scope.accountId}`,
        )
      : result.data.triggers;
  const evidence = [
    localEvidence('important-triggers:0', 'important-triggers', now, 'local/watch-triggers'),
  ];
  return {
    evidence,
    section: {
      key: 'important-triggers',
      title: '重要预警',
      required: true,
      status: 'complete' as const,
      dataAsOf: now,
      blocks: [
        {
          kind: 'list' as const,
          items: triggers.map((trigger) => ({
            title: `${trigger.stockId} · ${trigger.ruleKind}`,
            detail: `${trigger.priority} · ${trigger.deliveryStatus}`,
            notificationSummary: `${trigger.priority === 'urgent' ? '紧急' : trigger.priority === 'important' ? '重要' : '提醒'} · ${trigger.deliveryStatus === 'sent' ? '渠道已受理，设备状态未知' : trigger.deliveryStatus === 'failed' ? '投递失败' : trigger.deliveryStatus === 'fallback-log' ? '仅记日志' : '尚未投递'}\n${notificationText(trigger.reason, 90) || '请核对原始触发条件'} · ${notificationTime(trigger.createdAt)}（北京时间）`,
            entityKind: 'watch-trigger' as const,
            entityId: trigger.id,
          })),
        },
      ],
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions: [],
    },
  };
};

type PlanReviewAudit = {
  reviews: Array<TradingPlanReview & { accountId: string }>;
  available: boolean;
  issue?: { reason: string; errorKind: string };
};

const planReviewAudit = async (
  since: Date,
  until: Date,
  scope: ClosingInput['scope'],
  ctx: WorkflowContext,
): Promise<PlanReviewAudit> => {
  const result = await ctx.tools.list_workflow_runs.execute({
    workflowName: 'trading-plan-daily-cycle',
    since,
    includeWatch: false,
    limit: 200,
  });
  if (!result.ok)
    return {
      reviews: [],
      available: false,
      issue: {
        reason: '计划复核审计读取失败，不能确认维持或新增数量',
        errorKind: result.error.kind,
      },
    };
  const reviews: PlanReviewAudit['reviews'] = [];
  let invalid = false;
  for (const run of result.data.runs) {
    if (run.startedAt > until) continue;
    const accountId = run.inputSummary?.accountId;
    if (typeof accountId !== 'string') {
      invalid = true;
      continue;
    }
    if (scope.kind === 'account' && accountId !== scope.accountId) continue;
    if (!Array.isArray(run.summary?.reviews)) {
      invalid = true;
      continue;
    }
    for (const value of run.summary.reviews) {
      const parsed = TradingPlanReviewSchema.safeParse(value);
      if (!parsed.success) {
        invalid = true;
        continue;
      }
      if (parsed.data.reviewedAt < since || parsed.data.reviewedAt > until) continue;
      reviews.push({ ...parsed.data, accountId });
    }
  }
  return {
    reviews,
    available: true,
    ...(result.data.runs.length >= 200
      ? { issue: { reason: '计划复核审计达到 200 条读取上限，统计可能不完整', errorKind: 'limit' } }
      : invalid
        ? {
            issue: {
              reason: '部分计划复核审计缺少账户或明细，统计可能不完整',
              errorKind: 'incomplete-audit',
            },
          }
        : {}),
  };
};

const reviewMetrics = (audit: PlanReviewAudit, reviews: PlanReviewAudit['reviews']) => {
  const versions = (outcome: TradingPlanReview['outcome']) =>
    new Set(
      reviews
        .filter((review) => review.outcome === outcome)
        .map((review) => `${review.accountId}:${review.versionId}`),
    );
  const created = versions('created');
  const retained = (outcome: TradingPlanReview['outcome']) =>
    [...versions(outcome)].filter((id) => !created.has(id)).length;
  return [
    { key: 'reviewCreated', label: '已记录新增版本', value: audit.available ? created.size : null },
    {
      key: 'reviewMaintained',
      label: '已记录维持原版',
      value: audit.available ? retained('maintained') : null,
    },
    {
      key: 'reviewUnchangedDraft',
      label: '已记录重复草案复核',
      value: audit.available ? retained('unchanged-draft') : null,
    },
  ];
};

const priorDayReviewSection = async (
  date: string,
  accountId: string,
  now: Date,
  ctx: WorkflowContext,
  audit: PlanReviewAudit,
): Promise<ReportSectionPiece> => {
  const priorDate = previousTradingDay(date);
  const since = new Date(`${priorDate}T00:00:00+08:00`);
  const until = new Date(since.getTime() + DAY_MS - 1);
  const [plans, triggers, trades] = await Promise.all([
    ctx.tools.list_trading_plans.execute({
      accountId,
      createdSince: since,
      createdUntil: until,
      limit: 500,
    }),
    ctx.tools.list_watch_triggers.execute({
      poolId: `trading-plan-watch:${accountId}`,
      since,
      until,
      limit: 500,
    }),
    ctx.tools.list_trades.execute({ accountId, since, until, limit: 500 }),
  ]);
  const changedPlans = plans.ok ? plans.data.plans : [];
  const reviews = audit.reviews.filter(
    (review) => review.reviewedAt >= since && review.reviewedAt <= until,
  );
  const createdVersions = new Set(
    reviews.filter((review) => review.outcome === 'created').map((review) => review.versionId),
  );
  const retained = new Map<string, (typeof reviews)[number]>();
  for (const review of reviews) {
    if (review.outcome === 'created' || createdVersions.has(review.versionId)) continue;
    const previous = retained.get(review.versionId);
    if (previous === undefined || review.reviewedAt > previous.reviewedAt)
      retained.set(review.versionId, review);
  }
  const gaps = [
    ...(audit.issue === undefined
      ? []
      : [missing('prior-day-review.reviews', audit.issue.reason, audit.issue.errorKind)]),
    ...(!plans.ok
      ? [missing('prior-day-review.plans', '前一交易日计划版本读取失败', plans.error.kind)]
      : plans.data.plans.length >= 500
        ? [
            missing(
              'prior-day-review.plans',
              '计划版本读取达到 500 条，变更统计可能不完整',
              'limit',
            ),
          ]
        : []),
    ...(!triggers.ok
      ? [missing('prior-day-review.triggers', '前一交易日提醒读取失败', triggers.error.kind)]
      : triggers.data.total > triggers.data.triggers.length
        ? [missing('prior-day-review.triggers', '提醒明细超过读取上限', 'limit')]
        : []),
    ...(!trades.ok
      ? [missing('prior-day-review.trades', '前一交易日交易记录读取失败', trades.error.kind)]
      : trades.data.total > trades.data.trades.length
        ? [missing('prior-day-review.trades', '交易明细超过读取上限', 'limit')]
        : []),
  ];
  const evidence = [
    ...(audit.available
      ? [
          localEvidence(
            'prior-day-review:reviews',
            'prior-day-review',
            now,
            'tool:list_workflow_runs',
          ),
        ]
      : []),
    ...(plans.ok
      ? [
          localEvidence(
            'prior-day-review:plans',
            'prior-day-review',
            now,
            'tool:list_trading_plans',
          ),
        ]
      : []),
    ...(triggers.ok
      ? [
          localEvidence(
            'prior-day-review:triggers',
            'prior-day-review',
            now,
            'tool:list_watch_triggers',
          ),
        ]
      : []),
    ...(trades.ok
      ? [localEvidence('prior-day-review:trades', 'prior-day-review', now, 'tool:list_trades')]
      : []),
  ];
  const blocks: ReportBlock[] = [
    {
      kind: 'metrics',
      items: [
        {
          key: 'planVersions',
          label: '前一交易日新增计划版本',
          value: plans.ok ? changedPlans.length : null,
        },
        ...reviewMetrics(audit, reviews),
        {
          key: 'triggerCount',
          label: '前一交易日提醒',
          value: triggers.ok ? triggers.data.total : null,
        },
        {
          key: 'registeredTrades',
          label: '前一交易日已登记交易',
          value: trades.ok ? trades.data.total : null,
        },
      ],
    },
    {
      kind: 'text',
      tone: 'warning',
      text: `${priorDate} 的提醒与已登记交易分别列示；同股票、同日期不能证明提醒被执行。没有已登记交易不等于实际没有交易，未平仓或未回填结果的盈亏保持未知。信号后续表现另见复盘页的观察统计。`,
    },
    {
      kind: 'list',
      items: changedPlans.slice(0, 20).map((plan) => ({
        title: `${plan.stockName ?? plan.stockId} · ${PLAN_ACTION_LABELS[plan.action]} · v${plan.version}`,
        detail: `${PLAN_RECORD_LABELS[plan.status]} · ${notificationTime(plan.createdAt)}（北京时间）`,
        entityKind: 'trading-plan',
        entityId: `${plan.id}:v${plan.version}`,
      })),
    },
    ...([...retained.values()].length === 0
      ? []
      : [
          {
            kind: 'text' as const,
            tone: 'factual' as const,
            text: `前一交易日复核后沿用的版本（${retained.size} 项${retained.size > 20 ? '，展示最近 20 项' : ''}；没有新增版本也属于已复核）：`,
          },
          {
            kind: 'list' as const,
            items: [...retained.values()]
              .sort((a, b) => b.reviewedAt.getTime() - a.reviewedAt.getTime())
              .slice(0, 20)
              .map((review) => ({
                title: `${review.stockId} · ${review.outcome === 'maintained' ? '维持原计划' : '草案仍待补全'}`,
                detail: `${notificationTime(review.reviewedAt)}（北京时间）${review.reasons.length === 0 ? '' : ` · ${review.reasons.join('；')}`}`,
                entityKind: 'trading-plan' as const,
                entityId: review.versionId,
              })),
          },
        ]),
    {
      kind: 'list',
      items: triggers.ok
        ? triggers.data.triggers.slice(0, 20).map((trigger) => ({
            title: `${trigger.stockName ?? trigger.stockId} · ${trigger.ruleKind}`,
            detail: `${notificationTime(trigger.createdAt)}（北京时间） · ${trigger.deliveryStatus === 'sent' ? '渠道已受理，设备状态未知' : trigger.deliveryStatus === 'failed' ? '投递失败' : trigger.deliveryStatus === 'fallback-log' ? '仅记日志' : trigger.deliveryStatus === 'not-requested' ? '未请求通知' : '尚未完成投递'}`,
            entityKind: 'watch-trigger' as const,
            entityId: trigger.id,
          }))
        : [],
    },
    {
      kind: 'table',
      columns: [
        { key: 'id', label: '交易 ID' },
        { key: 'stock', label: '股票' },
        { key: 'side', label: '方向' },
        { key: 'quantity', label: '数量' },
        { key: 'price', label: '成交价' },
        { key: 'executedAt', label: '成交时间' },
        { key: 'adviceId', label: '显式关联 Advice' },
      ],
      rows: trades.ok
        ? trades.data.trades.slice(0, 20).map((trade) => ({
            id: trade.id,
            stock: trade.stockId,
            side: trade.side === 'buy' ? '买入' : '卖出',
            quantity: trade.quantity,
            price: trade.price,
            executedAt: `${notificationTime(trade.executedAt)}（北京时间）`,
            adviceId: trade.adviceId ?? '未关联',
          }))
        : [],
    },
  ];
  return {
    evidence,
    section: {
      key: 'prior-day-review',
      title: `${priorDate} 计划、提醒与实际执行`,
      required: true,
      status: gaps.length === 0 ? 'complete' : 'partial',
      dataAsOf: now,
      blocks,
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions: gaps,
    },
  };
};

const adviceExpirySection = async (
  date: string,
  now: Date,
  ctx: WorkflowContext,
  scope: ClosingInput['scope'],
) => {
  const result = await ctx.tools.get_advice.execute({ includeExpired: true, limit: 500 });
  if (!result.ok) {
    return unavailableSection(
      'advice-expiry',
      '建议有效期',
      true,
      now,
      'advice',
      result.error.kind,
    );
  }
  const holdings =
    scope.kind === 'account'
      ? await ctx.tools.list_holdings.execute({ accountId: scope.accountId, status: 'all' })
      : undefined;
  if (holdings !== undefined && !holdings.ok)
    return unavailableSection(
      'advice-expiry',
      '建议有效期',
      true,
      now,
      'advice-expiry.holdings',
      holdings.error.kind,
    );
  const holdingIds = new Set(
    holdings?.ok ? holdings.data.holdings.map((item) => item.holding.id) : [],
  );
  const expiring = result.data.advices.filter(
    (advice) =>
      dateInShanghai(advice.validUntil) === date &&
      (scope.kind === 'all-accounts' ||
        advice.basedOn.strategy?.accountId === scope.accountId ||
        (advice.subjectKind === 'position' && holdingIds.has(advice.subjectId))),
  );
  const evidence = [localEvidence('advice-expiry:0', 'advice-expiry', now, 'local/advice')];
  return {
    evidence,
    section: {
      key: 'advice-expiry',
      title: '建议有效期',
      required: true,
      status: 'complete' as const,
      dataAsOf: now,
      blocks: [
        {
          kind: 'list' as const,
          items: expiring.map((advice) => ({
            title:
              advice.stockName ?? (advice.subjectKind === 'stock' ? advice.subjectId : '持仓建议'),
            detail: `有效期至 ${dateInShanghai(advice.validUntil)}`,
            entityKind: 'advice' as const,
            entityId: advice.id,
          })),
        },
      ],
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions: [],
    },
  };
};

const nextEventsSection = async (date: string, now: Date, ctx: WorkflowContext) => {
  const nextDate = nextTradingDay(date);
  const from = new Date(`${nextDate}T00:00:00+08:00`);
  const to = new Date(from.getTime() + DAY_MS - 1);
  const result = await ctx.tools.list_stock_events.execute({
    from,
    to,
    status: 'scheduled',
    importance: 'important',
    limit: 500,
  });
  if (!result.ok) {
    return unavailableSection(
      'next-events',
      '下一交易日事件',
      true,
      now,
      'stock-events',
      result.error.kind,
    );
  }
  const stale = result.data.events.filter((event) => event.stale);
  const evidence = [localEvidence('next-events:0', 'next-events', now, 'local/stock-events')];
  return {
    evidence,
    section: {
      key: 'next-events',
      title: '下一交易日事件',
      required: true,
      status: stale.length === 0 ? ('complete' as const) : ('partial' as const),
      dataAsOf: now,
      blocks: [
        {
          kind: 'list' as const,
          items: result.data.events.map((event) => ({
            title: event.title,
            detail: event.stockId,
            entityKind: 'stock-event' as const,
            entityId: event.id,
          })),
        },
      ],
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions:
        stale.length === 0
          ? []
          : [missing('next-events.freshness', `${stale.length} 条事件已标记 stale`, 'stale')],
    },
  };
};

const STRATEGY_ADVICE_SOURCE_TOOL = 'analyze_strategy_candidate';

const adviceDecisionLabel = (decision: string): string => {
  switch (decision) {
    case 'buy':
      return '买入';
    case 'sell':
      return '卖出';
    case 'hold':
      return '持有';
    case 'watch':
      return '观察';
    case 'avoid':
      return '回避';
    default:
      return decision;
  }
};

export const scheduledRunExpectedAt = (
  schedule: StrategySchedule,
  date: string,
): Date | undefined => {
  if (!schedule.enabled) return undefined;
  const dayStart = new Date(`${date}T00:00:00+08:00`);
  if (isWeekend(dayStart) || isHoliday(dayStart)) return undefined;
  const expectedAt = nextCronOccurrence(
    schedule.cron,
    schedule.timezone,
    new Date(dayStart.getTime() - 60_000),
  );
  return dateInShanghai(expectedAt) === date && expectedAt >= schedule.createdAt
    ? expectedAt
    : undefined;
};

export const closingReportStrategiesReady = async (
  date: string,
  now: Date,
  ctx: WorkflowContext,
): Promise<boolean> => {
  const strategies = await ctx.tools.list_strategies.execute({ filter: { status: 'active' } });
  if (!strategies.ok) return false;
  const schedules = await Promise.all(
    strategies.data.strategies.map((strategy) =>
      ctx.tools.get_strategy_schedule.execute({ strategyId: strategy.id }),
    ),
  );
  if (schedules.some((result) => !result.ok)) return false;
  const expected = strategies.data.strategies.flatMap((strategy, index) => {
    const schedule = schedules[index];
    if (!schedule?.ok || schedule.data.schedule === null) return [];
    const expectedAt = scheduledRunExpectedAt(schedule.data.schedule, date);
    return expectedAt === undefined
      ? []
      : [{ strategyId: strategy.id, expectedAt, schedule: schedule.data.schedule }];
  });
  if (expected.length === 0) return now >= new Date(`${date}T18:00:00+08:00`);
  if (
    expected.some(
      (item) =>
        item.expectedAt > now ||
        item.schedule.nextRunAt === undefined ||
        item.schedule.nextRunAt <= now ||
        item.schedule.lastRunId === undefined,
    )
  )
    return false;
  const since = new Date(`${date}T00:00:00+08:00`);
  const runs = await ctx.tools.list_strategy_runs.execute({
    scope: 'operational',
    publication: 'published',
    since,
    until: new Date(since.getTime() + 24 * 60 * 60_000 - 1),
    limit: 500,
  });
  if (!runs.ok || runs.data.runs.length === 500) return false;
  const published = new Set(
    runs.data.runs.filter((run) => dateInShanghai(run.startedAt) === date).map((run) => run.id),
  );
  return expected.every(
    (item) => item.schedule.lastRunId !== undefined && published.has(item.schedule.lastRunId),
  );
};

/**
 * 「策略行动」：当日策略建议按方向分组，呈现 AI 判断与未分析候选事实
 * （现价 + 理由 + 风险 + 有效期）。decision 值仅以文本展示，block 不含决策字段 key
 * （report 不变量约束），entityKind='advice' 链接回 Advice 本体。
 */
const strategyActionsSection = async (
  date: string,
  now: Date,
  ctx: WorkflowContext,
  scope: ClosingInput['scope'],
): Promise<ReportSectionPiece> => {
  const dayStart = new Date(`${date}T00:00:00+08:00`);
  const [strategies, runs, advices, batches] = await Promise.all([
    ctx.tools.list_strategies.execute({ filter: { status: 'active' } }),
    ctx.tools.list_strategy_runs.execute({
      scope: 'operational',
      publication: 'published',
      since: dayStart,
      limit: 500,
    }),
    ctx.tools.get_advice.execute({
      sourceTool: STRATEGY_ADVICE_SOURCE_TOOL,
      since: dayStart,
      until: new Date(dayStart.getTime() + DAY_MS - 1),
      includeExpired: true,
      limit: 500,
    }),
    ctx.tools.list_workflow_runs.execute({
      workflowName: 'strategy-recommendations',
      since: dayStart,
      limit: 200,
      includeWatch: false,
    }),
  ]);
  if (!strategies.ok) {
    return unavailableSection(
      'strategy-actions',
      '策略行动',
      true,
      now,
      'strategy-actions.strategies',
      strategies.error.kind,
    );
  }
  if (!runs.ok) {
    return unavailableSection(
      'strategy-actions',
      '策略行动',
      true,
      now,
      'strategy-actions.runs',
      runs.error.kind,
    );
  }
  if (!advices.ok) {
    return unavailableSection(
      'strategy-actions',
      '策略行动',
      true,
      now,
      'strategy-actions.advice',
      advices.error.kind,
    );
  }

  const dayRuns = runs.data.runs.filter((run) => dateInShanghai(run.startedAt) === date);
  const latestRunByStrategy = new Map<string, (typeof dayRuns)[number]>();
  for (const run of dayRuns) {
    if (!latestRunByStrategy.has(run.strategyId)) latestRunByStrategy.set(run.strategyId, run);
  }
  const dayAdvices = advices.data.advices.filter(
    (advice) =>
      dateInShanghai(advice.createdAt) === date &&
      (scope.kind === 'all-accounts' || advice.basedOn.strategy?.accountId === scope.accountId),
  );
  const summaryCount = (
    run: (typeof dayRuns)[number] | undefined,
    key: 'selectedCount' | 'signalCount',
  ) => {
    const value = run?.summary?.[key];
    return typeof value === 'number' ? value : null;
  };
  const batchByRun = new Map<string, z.infer<typeof StrategyRecommendationBatchSummarySchema>>();
  const gaps = [];
  if (!batches.ok)
    gaps.push(
      missing('strategy-actions.analysis-status', '建议批次审计不可用', batches.error.kind),
    );
  else
    for (const batch of batches.data.runs) {
      if (dateInShanghai(batch.startedAt) !== date) continue;
      const parsed = StrategyRecommendationBatchSummarySchema.safeParse(batch.summary);
      if (parsed.success && !batchByRun.has(parsed.data.runId))
        batchByRun.set(parsed.data.runId, parsed.data);
    }
  const analysisByStrategy = new Map<string, string>();
  const pendingItems: { title: string; detail: string; entityKind: 'stock'; entityId: string }[] =
    [];
  for (const strategy of strategies.data.strategies) {
    const run = latestRunByStrategy.get(strategy.id);
    if (run === undefined) {
      const schedule = await ctx.tools.get_strategy_schedule.execute({ strategyId: strategy.id });
      const expectedAt = schedule.ok
        ? schedule.data.schedule === null
          ? undefined
          : scheduledRunExpectedAt(schedule.data.schedule, date)
        : undefined;
      if (!schedule.ok) {
        analysisByStrategy.set(strategy.id, '调度状态不可用');
        gaps.push(
          missing(
            `strategy-actions.run.${strategy.id}`,
            '无法判断预期策略是否完成',
            schedule.error.kind,
          ),
        );
      } else if (expectedAt !== undefined) {
        const pending = expectedAt > now;
        analysisByStrategy.set(strategy.id, pending ? '今日正式运行待开始' : '今日正式运行未完成');
        gaps.push(
          missing(
            `strategy-actions.run.${strategy.id}`,
            pending ? '预期策略今日尚未到运行时间' : '预期策略今日没有已发布正式运行',
            pending ? 'run-pending' : 'run-missing',
          ),
        );
      } else {
        analysisByStrategy.set(
          strategy.id,
          schedule.data.schedule?.enabled === true
            ? '今日尚无预期正式运行'
            : '今日未运行；自动调度未开启',
        );
      }
      continue;
    }
    const batch = batchByRun.get(run.id);
    const adviceCount = dayAdvices.filter(
      (advice) => advice.basedOn.strategy?.strategyId === strategy.id,
    ).length;
    if (batch !== undefined) {
      const skipped = batch.preflight?.skipped ?? batch.skippedCooldown;
      const unavailable = batch.preflight?.unavailable ?? 0;
      analysisByStrategy.set(
        strategy.id,
        [
          `最近批次生成 ${batch.adviceCount} 条`,
          ...(skipped > 0 ? [`预检跳过 ${skipped} 条`] : []),
          ...(unavailable > 0 ? [`数据待补齐 ${unavailable} 条`] : []),
          ...(batch.generationFailed > 0 ? [`生成失败 ${batch.generationFailed} 条`] : []),
        ].join('；'),
      );
      if (batch.generationFailed > 0 || unavailable > 0)
        gaps.push(
          missing(
            `strategy-actions.analysis.${strategy.id}`,
            `${batch.generationFailed} 条生成失败，${unavailable} 条数据不可用`,
            'analysis-incomplete',
          ),
        );
    } else if (adviceCount > 0) {
      analysisByStrategy.set(strategy.id, `已有 ${adviceCount} 条建议；无批次审计`);
    } else {
      const schedule = await ctx.tools.get_strategy_schedule.execute({ strategyId: strategy.id });
      const enabled = schedule.ok && schedule.data.schedule?.recommendationPolicy?.enabled === true;
      analysisByStrategy.set(
        strategy.id,
        enabled ? '尚未分析完成' : schedule.ok ? '自动分析未开启；候选未分析' : '分析配置不可用',
      );
      if (enabled || !schedule.ok)
        gaps.push(
          missing(
            `strategy-actions.analysis.${strategy.id}`,
            enabled ? '存在正式运行，尚无分析结果' : '分析配置不可用',
            'analysis-unavailable',
          ),
        );
    }
    const detail = await ctx.tools.get_strategy_run.execute({ runId: run.id });
    if (!detail.ok) {
      gaps.push(
        missing(`strategy-actions.candidates.${strategy.id}`, '候选事实不可用', detail.error.kind),
      );
      continue;
    }
    const named = new Map(detail.data.stocks.map((stock) => [stock.stockId, stock.stockName]));
    for (const result of detail.data.results.filter((result) => result.selected)) {
      if (
        dayAdvices.some(
          (advice) =>
            advice.subjectId === result.stockId && advice.basedOn.strategy?.runId === run.id,
        )
      )
        continue;
      const preflight = batch?.preflight?.details.find((item) => item.stockId === result.stockId);
      pendingItems.push({
        title: named.get(result.stockId) ?? result.stockId,
        detail: `${strategy.name} · ${preflight?.status === 'skipped' ? `预检跳过：${preflight.reasons.map((reason) => reason.code).join('、')}` : preflight?.status === 'unavailable' ? '数据不可用，未分析' : '未分析或分析未完成'} · 规则分 ${result.score ?? '未知'}`,
        entityKind: 'stock',
        entityId: result.stockId,
      });
    }
  }
  const buyAdvices = dayAdvices.filter((advice) => advice.decision === 'buy');
  const watchAdvices = dayAdvices.filter((advice) => advice.decision === 'watch');
  const holdAdvices = dayAdvices.filter((advice) => advice.decision === 'hold');
  const avoidAdvices = dayAdvices.filter(
    (advice) => advice.decision === 'sell' || advice.decision === 'avoid',
  );
  const adviceActionDetail = (advice: (typeof dayAdvices)[number]): string => {
    const quote = advice.basedOn.quotes?.[advice.subjectId];
    const parts: string[] = [];
    if (quote !== undefined)
      parts.push(`参考价 ${quote.close}（行情时间 ${quote.observedAt.toISOString()}）`);
    const pricePlan: string[] = [];
    if (advice.entryPrice !== undefined) pricePlan.push(`买点 ${advice.entryPrice}`);
    if (advice.targetPrice !== undefined) pricePlan.push(`卖点 ${advice.targetPrice}`);
    if (advice.stopLoss !== undefined) pricePlan.push(`止损 ${advice.stopLoss}`);
    if (pricePlan.length > 0) parts.push(pricePlan.join(' / '));
    parts.push(advice.reasoning.premise);
    parts.push(`反证：${advice.reasoning.counterEvidence.join('；') || '历史建议未记录'}`);
    if (advice.risks.length > 0) parts.push(`风险：${advice.risks.join('；')}`);
    parts.push(
      `有效期至 ${advice.validUntil.toISOString()}${advice.validUntil <= now ? '（已过期）' : ''}`,
    );
    parts.push(advice.disclaimers.join('；'));
    return parts.join(' · ');
  };
  const adviceItem = (advice: (typeof dayAdvices)[number]) => ({
    title: advice.stockName ?? advice.subjectId,
    detail: `${adviceDecisionLabel(advice.decision)} · ${adviceActionDetail(advice)}`,
    notificationSummary: adviceNotificationSummary(advice),
    entityKind: 'advice' as const,
    entityId: advice.id,
  });
  const evidence = [
    localEvidence('strategy-actions:runs', 'strategy-actions.runs', now, 'tool:list_strategy_runs'),
    localEvidence('strategy-actions:advice', 'strategy-actions.advice', now, 'tool:get_advice'),
  ];
  const blocks: ReportBlock[] = [
    {
      kind: 'table',
      columns: [
        { key: 'strategy', label: '策略' },
        { key: 'selectedCount', label: '入选数' },
        { key: 'signalCount', label: '信号数' },
        { key: 'analysis', label: '分析状态' },
      ],
      rows: strategies.data.strategies.map((strategy) => {
        const run = latestRunByStrategy.get(strategy.id);
        return {
          strategy: strategy.name,
          selectedCount: run === undefined ? '未运行' : summaryCount(run, 'selectedCount'),
          signalCount: run === undefined ? '未运行' : summaryCount(run, 'signalCount'),
          analysis: analysisByStrategy.get(strategy.id) ?? '分析状态不可用',
        };
      }),
    },
    {
      kind: 'text',
      tone: 'factual',
      text:
        buyAdvices.length === 0
          ? dayAdvices.length === 0
            ? `${date} 今日尚无策略建议；未分析不代表不存在机会。`
            : `${date} 已有分析中暂无买入判断。`
          : `AI 买入判断（${buyAdvices.length}，请核对条件与风险）：`,
    },
  ];
  if (buyAdvices.length > 0) {
    blocks.push({ kind: 'list', items: buyAdvices.map(adviceItem) });
  }
  if (watchAdvices.length > 0) {
    blocks.push({ kind: 'text', tone: 'factual', text: `观察中（${watchAdvices.length}）：` });
    blocks.push({ kind: 'list', items: watchAdvices.map(adviceItem) });
  }
  if (avoidAdvices.length > 0) {
    blocks.push({ kind: 'text', tone: 'factual', text: `回避（${avoidAdvices.length}）：` });
    blocks.push({ kind: 'list', items: avoidAdvices.map(adviceItem) });
  }
  if (holdAdvices.length > 0)
    blocks.push(
      { kind: 'text', tone: 'factual', text: `持有判断（${holdAdvices.length}）：` },
      { kind: 'list', items: holdAdvices.map(adviceItem) },
    );
  if (pendingItems.length > 0)
    blocks.push(
      { kind: 'text', tone: 'factual', text: `候选事实（${pendingItems.length} 条尚无建议）：` },
      { kind: 'list', items: pendingItems },
    );
  return {
    evidence,
    section: {
      key: 'strategy-actions',
      title: '策略行动',
      required: true,
      status: gaps.length > 0 ? ('partial' as const) : ('complete' as const),
      dataAsOf: now,
      blocks,
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions: gaps,
    },
  };
};

/**
 * 交易计划是盘后报告与盘中监控共用的结构化来源；报告只投影计划，不从 Markdown 反解析执行条件。
 */
const PLAN_ACTION_LABELS: Record<TradingPlan['action'], string> = {
  observe: '观察',
  enter: '建仓',
  add: '加仓',
  hold: '持有',
  reduce: '减仓',
  exit: '退出',
  avoid: '回避',
};
const PLAN_RECORD_LABELS: Record<TradingPlan['status'], string> = {
  active: '生效',
  draft: '草案',
  superseded: '已替代',
  revoked: '已撤销',
  expired: '已过期',
};
const PLAN_MONITOR_LABELS: Record<TradingPlanMonitoring['status'], string> = {
  ready: '可监控',
  draft: '待补全',
  'no-conditions': '待补全',
  unavailable: '等待数据',
  scheduled: '待生效',
  'account-changed': '已失效',
  expired: '已过期',
  inactive: '已退役',
};
const PLAN_TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const planTime = (date: Date) => PLAN_TIME_FORMAT.format(date);

const planReference = (plan: TradingPlan, monitoring: TradingPlanMonitoring) => ({
  title: `${plan.stockName ?? plan.stockId} · ${PLAN_ACTION_LABELS[plan.action]} · v${plan.version}`,
  detail: [
    PLAN_MONITOR_LABELS[monitoring.status],
    `条件：${plan.entryConditions.map((item) => item.description).join('；') || (['hold', 'reduce', 'exit', 'avoid'].includes(plan.action) ? '无建仓动作' : '待补全具体条件')}`,
    `止损 / 止盈：${plan.exit.stopLoss ?? '未提供'} / ${plan.exit.takeProfit ?? '未提供'}`,
    `退出：${plan.exit.conditions.join('；') || '未记录'}${plan.exit.unavailableReason === undefined ? '' : `（${plan.exit.unavailableReason}）`}`,
    `最近复核：${monitoring.lastReviewedAt === undefined ? '暂无记录' : planTime(monitoring.lastReviewedAt)}`,
    `下次复核：${planTime(monitoring.nextReviewAt)}`,
    `有效至：${planTime(monitoring.expiresAt)}`,
    `反证：${plan.explanation.counterEvidence.join('；') || '未记录'}`,
    `风险：${plan.explanation.risks.join('；') || '未记录'}`,
    `前置条件：${[...plan.explanation.unknowns, ...plan.position.prerequisiteActions].join('；') || '无'}`,
    `信心评分：${plan.confidence}（非收益概率）`,
    `下一步：${monitoring.nextStep}`,
  ].join(' · '),
  entityKind: 'trading-plan' as const,
  entityId: tradingPlanVersionId(plan),
});

const tradingPlansSection = async (
  date: string,
  scope: ClosingInput['scope'],
  now: Date,
  ctx: WorkflowContext,
  audit: PlanReviewAudit,
  planBatchStatus?: ClosingInput['planBatchStatus'],
): Promise<ReportSectionPiece> => {
  const since = new Date(`${date}T00:00:00+08:00`);
  const until = new Date(Math.min(now.getTime(), since.getTime() + DAY_MS - 1));
  const [result, accounts] = await Promise.all([
    ctx.tools.list_trading_plans.execute({
      ...(scope.kind === 'account' ? { accountId: scope.accountId } : {}),
      currentOnly: true,
      includeMonitoring: true,
      createdUntil: until,
      limit: 500,
    }),
    ctx.tools.list_accounts.execute({}),
  ]);
  if (!result.ok) {
    return unavailableSection(
      'trading-plans',
      '交易计划',
      true,
      now,
      'trading-plans',
      result.error.kind,
    );
  }
  const { views, monitoring } = result.data;
  if (views === undefined || monitoring === undefined)
    throw new Error('交易计划查询未返回监控投影');
  const byVersion = new Map(result.data.plans.map((plan) => [tradingPlanVersionId(plan), plan]));
  const monitoringByVersion = new Map(monitoring.map((item) => [item.versionId, item]));
  const projection = (versionId: string) => {
    const plan = byVersion.get(versionId);
    const qualification = monitoringByVersion.get(versionId);
    if (plan === undefined || qualification === undefined) throw new Error('交易计划投影引用缺失');
    return { plan, monitoring: qualification };
  };
  const rows = views.map((view) => projection(view.versionId));
  const revisions = views.flatMap((view) =>
    view.draftVersionId === undefined ? [] : [projection(view.draftVersionId)],
  );
  const current = rows.filter(
    (row) => !['expired', 'account-changed', 'inactive'].includes(row.monitoring.status),
  );
  const stopped = rows.filter((row) =>
    ['expired', 'account-changed', 'inactive'].includes(row.monitoring.status),
  );
  const priority: Record<TradingPlanMonitoring['status'], number> = {
    draft: 0,
    'no-conditions': 0,
    unavailable: 1,
    scheduled: 2,
    ready: 3,
    expired: 4,
    'account-changed': 4,
    inactive: 4,
  };
  current.sort(
    (a, b) =>
      priority[a.monitoring.status] - priority[b.monitoring.status] ||
      a.monitoring.expiresAt.getTime() - b.monitoring.expiresAt.getTime() ||
      a.plan.stockId.localeCompare(b.plan.stockId),
  );
  const presented = current.slice(0, 20);
  const names = new Map(
    accounts.ok ? accounts.data.accounts.map((account) => [account.id, account.name]) : [],
  );
  const reviews = audit.reviews.filter(
    (review) => review.reviewedAt >= since && review.reviewedAt <= until,
  );
  const pendingDrafts = new Set(
    [...current, ...revisions]
      .filter((row) => row.plan.status === 'draft')
      .map((row) => tradingPlanVersionId(row.plan)),
  );
  const count = (...statuses: TradingPlanMonitoring['status'][]) =>
    rows.filter((row) => statuses.includes(row.monitoring.status)).length;
  const inputFingerprint = createHash('sha256')
    .update(
      JSON.stringify(
        [...rows, ...revisions]
          .map(({ plan, monitoring }) => [tradingPlanVersionId(plan), monitoring.status] as const)
          .sort((a, b) => a[0].localeCompare(b[0])),
      ),
    )
    .digest('hex');
  const evidence = [
    localEvidence('trading-plans:0', 'trading-plans', now, 'tool:list_trading_plans'),
    ...(audit.available
      ? [localEvidence('trading-plans:reviews', 'trading-plans', now, 'tool:list_workflow_runs')]
      : []),
    ...(accounts.ok
      ? [localEvidence('trading-plans:accounts', 'trading-plans', now, 'tool:list_accounts')]
      : []),
  ];
  const missingDimensions = [
    ...(planBatchStatus === undefined || planBatchStatus === 'complete'
      ? []
      : [
          missing(
            'trading-plans.daily-cycle',
            planBatchStatus === 'blocked'
              ? '账户持仓与候选计划批次未完成'
              : '账户持仓与候选计划批次部分完成',
            planBatchStatus === 'blocked' ? 'plan-batch-blocked' : 'plan-batch-partial',
          ),
        ]),
    ...(pendingDrafts.size === 0
      ? []
      : [
          missing(
            'trading-plans.drafts',
            `${pendingDrafts.size} 份草案或修订尚未发布，需补齐前提`,
            'drafts-pending',
          ),
        ]),
    ...(audit.issue === undefined
      ? []
      : [missing('trading-plans.reviews', audit.issue.reason, audit.issue.errorKind)]),
    ...(accounts.ok
      ? []
      : [
          missing(
            'trading-plans.accounts',
            '账户名称读取失败，暂以账户身份显示',
            accounts.error.kind,
          ),
        ]),
    ...(views.length < 500
      ? []
      : [missing('trading-plans.limit', '计划读取达到 500 项上限，状态统计可能不完整', 'limit')]),
  ];
  return {
    evidence,
    section: {
      key: 'trading-plans',
      title: '交易计划',
      required: true,
      status: missingDimensions.length === 0 ? 'complete' : 'partial',
      dataAsOf: now,
      inputFingerprint,
      blocks: [
        {
          kind: 'metrics',
          items: [
            { key: 'ready', label: '可监控', value: count('ready') },
            { key: 'pending', label: '待补全', value: count('draft', 'no-conditions') },
            { key: 'unavailable', label: '等待数据', value: count('unavailable') },
            { key: 'scheduled', label: '待生效', value: count('scheduled') },
            { key: 'revisionDrafts', label: '未发布修订', value: revisions.length },
            { key: 'expired', label: '已过期', value: count('expired') },
            {
              key: 'invalidated',
              label: '已失效 / 退役',
              value: count('account-changed', 'inactive'),
            },
          ],
        },
        {
          kind: 'text',
          tone: 'factual',
          text: `${date} 复核记录（按确切版本去重，本日新增版本的重复复核不另计为维持）：`,
        },
        { kind: 'metrics', items: reviewMetrics(audit, reviews) },
        {
          kind: 'text',
          tone: 'factual',
          text: `${reviews.length === 0 ? '目标日尚无可用的计划复核明细，不能据此确认全部计划已复核。' : '新增版本包括草案修订；沿用旧版本也属于已复核。'} 计划版本截至 ${planTime(until)}（北京时间），资格按报告生成时的账户事实和有效期核验；可监控不代表已运行、已送达或已成交。`,
        },
        {
          kind: 'text',
          tone: 'factual',
          text: `下一交易日跟踪清单（${current.length} 项${current.length > presented.length ? `，按待补全、等待数据与到期时间优先展示 ${presented.length} 项，其余见预警页` : ''}）：`,
        },
        {
          kind: 'table',
          columns: [
            ...(scope.kind === 'all-accounts' ? [{ key: 'account', label: '账户' }] : []),
            { key: 'stockLabel', label: '股票 / 版本' },
            { key: 'actionLabel', label: '动作' },
            { key: 'eligibility', label: '当前资格' },
            { key: 'entryRange', label: '入场区间' },
            { key: 'targetLabel', label: '目标仓位' },
            { key: 'nextStep', label: '下一步' },
            { key: 'validUntil', label: '有效期至（北京时间）' },
          ],
          rows: presented.map(({ plan, monitoring }) => ({
            account: names.get(plan.accountId) ?? plan.accountId,
            accountId: plan.accountId,
            stock: plan.stockName ?? plan.stockId,
            stockLabel: `${plan.stockName ?? plan.stockId} · v${plan.version}`,
            action: plan.action,
            actionLabel: PLAN_ACTION_LABELS[plan.action],
            status: plan.status,
            monitoringStatus: monitoring.status,
            eligibility: PLAN_MONITOR_LABELS[monitoring.status],
            nextStep: monitoring.nextStep,
            version: `v${plan.version}`,
            entryRange:
              plan.entryPriceLow === undefined || plan.entryPriceHigh === undefined
                ? ['hold', 'reduce', 'exit', 'avoid'].includes(plan.action)
                  ? '无建仓动作'
                  : '待补全'
                : `${plan.entryPriceLow}-${plan.entryPriceHigh}`,
            entryConditions:
              plan.entryConditions.map((condition) => condition.description).join('；') || '无',
            exitConditions: plan.exit.conditions.join('；') || '未记录',
            currentPct: plan.position.currentPct,
            targetPct: plan.position.targetPct,
            targetLabel:
              plan.position.targetPct === null
                ? '不可用'
                : plan.action === 'observe' && plan.position.targetPct === 0
                  ? '未设置条件仓位'
                  : `${plan.position.targetPct}%`,
            holdingDays: `${plan.holding.minTradingDays}-${plan.holding.maxTradingDays}`,
            risk: plan.explanation.risks.join('；') || '未记录',
            counterEvidence: plan.explanation.counterEvidence.join('；') || '未记录',
            unknowns:
              [...plan.explanation.unknowns, ...plan.position.prerequisiteActions].join('；') ||
              '无',
            validUntil: planTime(monitoring.expiresAt),
          })),
        },
        ...(presented.length === 0
          ? []
          : [
              {
                kind: 'list' as const,
                items: presented.map(({ plan, monitoring }) => planReference(plan, monitoring)),
              },
            ]),
        ...(revisions.length === 0
          ? []
          : [
              {
                kind: 'text' as const,
                tone: 'warning' as const,
                text: `未发布的修订草案（${revisions.length} 项${revisions.length > 20 ? '，展示前 20 项，其余见预警页' : ''}）：原生效版本仍有效时继续保留，草案不会替代它。`,
              },
              {
                kind: 'list' as const,
                items: revisions.slice(0, 20).map(({ plan, monitoring }) => ({
                  title: `${plan.stockName ?? plan.stockId} · 修订草案 v${plan.version}`,
                  detail: `${monitoring.nextStep} · 截止 ${planTime(monitoring.expiresAt)}（北京时间）`,
                  entityKind: 'trading-plan' as const,
                  entityId: tradingPlanVersionId(plan),
                })),
              },
            ]),
        ...(stopped.length === 0
          ? []
          : [
              {
                kind: 'text' as const,
                tone: 'factual' as const,
                text: `退出当前跟踪的记录（${stopped.length} 项${stopped.length > 10 ? '，展示最近 10 项' : ''}）：保留历史，补齐前提后重新复核，不自动续期。`,
              },
              {
                kind: 'list' as const,
                items: stopped
                  .sort((a, b) => b.plan.createdAt.getTime() - a.plan.createdAt.getTime())
                  .slice(0, 10)
                  .map(({ plan, monitoring }) => ({
                    title: `${plan.stockName ?? plan.stockId} · ${PLAN_MONITOR_LABELS[monitoring.status]} · v${plan.version}`,
                    detail: `${monitoring.reason} · 有效至 ${planTime(monitoring.expiresAt)}（北京时间） · 下一步：${monitoring.nextStep}`,
                    entityKind: 'trading-plan' as const,
                    entityId: tradingPlanVersionId(plan),
                  })),
              },
            ]),
        ...(current.length === 0
          ? [
              {
                kind: 'text' as const,
                tone: 'warning' as const,
                text: '目前没有仍需跟踪的当前计划；请结合草案、过期、失效与复核记录区分研究未完成和没有合格机会。',
              },
            ]
          : []),
      ],
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions,
    },
  };
};

const runClosingReport = async (
  input: ClosingInput,
  ctx: WorkflowContext,
): Promise<ClosingOutput | ToolResult<never>> => {
  const date = input.date ?? dateInShanghai(ctx.clock());
  const requested = shanghaiDate(date);
  if (isWeekend(requested) || isHoliday(requested)) {
    return {
      ok: false,
      error: { kind: 'invalid_input', message: `${date} 不是 A 股交易日`, issues: [] },
    };
  }
  if (date === dateInShanghai(ctx.clock()) && input.planBatchStatus === undefined) {
    const existing = await ctx.tools.get_report.execute({
      kind: 'closing',
      scope: input.scope,
      periodEnd: date,
    });
    if (!existing.ok && existing.error.kind !== 'not_found') return existing;
    if (!existing.ok) {
      let ready = await closingReportStrategiesReady(date, ctx.clock(), ctx);
      if (ready) {
        const fingerprint = await currentStrategyFingerprint(date, ctx);
        let accountIds: string[];
        if (input.scope.kind === 'account') accountIds = [input.scope.accountId];
        else {
          const accounts = await ctx.tools.list_accounts.execute({});
          if (!accounts.ok) return accounts;
          accountIds = accounts.data.accounts.map((account) => account.id);
        }
        for (const accountId of accountIds) {
          const facts = await ctx.tools.get_account_facts.execute({ accountId });
          if (!facts.ok) return facts;
          const status = await getAccountPlanBatchStatus(
            accountId,
            date,
            fingerprint,
            facts.data.facts.digest,
            ctx,
          );
          if (status === 'blocked') {
            ready = false;
            break;
          }
        }
      }
      if (!ready)
        return {
          ok: false,
          error: {
            kind: 'invalid_input',
            message: '当日策略或账户交易计划尚未完成，完成后再统一生成收盘复盘',
            issues: [],
          },
        };
    }
  }
  const result = await executeReportWorkflow(
    {
      workflowName: 'closing-report',
      kind: 'closing',
      template: 'closing-v1',
      mode: input.mode,
      notify: input.notify ?? input.mode === 'scheduled',
      scope: input.scope,
      periodStart: date,
      periodEnd: date,
      title: `${date} 收盘复盘`,
      inputSummary: { marketDate: date, notify: input.notify ?? input.mode === 'scheduled' },
      buildSections: async (generatedAt) => {
        const since = new Date(
          `${input.scope.kind === 'account' ? previousTradingDay(date) : date}T00:00:00+08:00`,
        );
        const until = new Date(
          Math.min(generatedAt.getTime(), new Date(`${date}T23:59:59.999+08:00`).getTime()),
        );
        const [sentiment, audit] = await Promise.all([
          ctx.tools.get_ashare_sentiment.execute({ date }),
          planReviewAudit(since, until, input.scope, ctx),
        ]);
        const market = sentiment.ok
          ? marketPulse(sentiment.data.snapshot)
          : unavailableSection(
              'market-pulse',
              '市场脉搏',
              true,
              generatedAt,
              'ashare-sentiment',
              sentiment.error.kind,
            );
        const [performance, triggers, adviceExpiry, strategyActions, plans, priorDay, nextEvents] =
          await Promise.all([
            accountPerformance(input, generatedAt, ctx),
            triggersSection(date, generatedAt, ctx, input.scope),
            adviceExpirySection(date, generatedAt, ctx, input.scope),
            strategyActionsSection(date, generatedAt, ctx, input.scope),
            tradingPlansSection(date, input.scope, generatedAt, ctx, audit, input.planBatchStatus),
            input.scope.kind === 'account'
              ? priorDayReviewSection(date, input.scope.accountId, generatedAt, ctx, audit)
              : Promise.resolve(null),
            nextEventsSection(date, generatedAt, ctx),
          ]);
        return [
          market,
          performance,
          triggers,
          adviceExpiry,
          strategyActions,
          plans,
          ...(priorDay === null ? [] : [priorDay]),
          nextEvents,
        ];
      },
    },
    ctx,
  );
  return 'ok' in result ? result : ClosingReportOutput.parse(result);
};

export const closingReportWorkflow = defineWorkflow<ClosingInput, ClosingOutput>({
  name: 'closing-report',
  description: '生成并幂等保存指定交易日的结构化收盘复盘',
  input: ClosingReportInput,
  steps: [(prev, ctx) => runClosingReport(prev as ClosingInput, ctx)],
});
