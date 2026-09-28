import {
  adviceNotificationSummary,
  dateInShanghai,
  isHoliday,
  isWeekend,
  nextCronOccurrence,
  notificationText,
  notificationTime,
  type Report,
  type ReportBlock,
  ReportSchema,
  ReportScopeSchema,
  StrategyRecommendationBatchSummarySchema,
  type StrategySchedule,
  type ToolResult,
} from '@luoome/core';
import { z } from 'zod';

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
  supplement: z.boolean().optional(),
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

const priorDayReviewSection = async (
  date: string,
  accountId: string,
  now: Date,
  ctx: WorkflowContext,
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
  const gaps = [
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
        title: `${plan.stockName ?? plan.stockId} · ${plan.action} · v${plan.version}`,
        detail: `${plan.status} · ${notificationTime(plan.createdAt)}（北京时间）`,
        entityKind: 'trading-plan',
        entityId: `${plan.id}:v${plan.version}`,
      })),
    },
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
const tradingPlansSection = async (
  scope: ClosingInput['scope'],
  now: Date,
  ctx: WorkflowContext,
  planBatchStatus?: ClosingInput['planBatchStatus'],
): Promise<ReportSectionPiece> => {
  const result = await ctx.tools.list_trading_plans.execute({
    ...(scope.kind === 'account' ? { accountId: scope.accountId } : {}),
    limit: 500,
  });
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
  const latest = new Map<string, (typeof result.data.plans)[number]>();
  for (const plan of result.data.plans) {
    const current = latest.get(plan.id);
    if (
      current === undefined ||
      plan.version > current.version ||
      (plan.version === current.version && plan.createdAt > current.createdAt)
    ) {
      latest.set(plan.id, plan);
    }
  }
  const plans = [...latest.values()].sort(
    (left, right) => left.stockId.localeCompare(right.stockId) || right.version - left.version,
  );
  const evidence = [
    localEvidence('trading-plans:0', 'trading-plans', now, 'tool:list_trading_plans'),
  ];
  const missingDimensions =
    planBatchStatus === undefined || planBatchStatus === 'complete'
      ? []
      : [
          missing(
            'trading-plans.daily-cycle',
            planBatchStatus === 'blocked'
              ? '账户持仓与候选计划批次未完成'
              : '账户持仓与候选计划批次部分完成',
            planBatchStatus === 'blocked' ? 'plan-batch-blocked' : 'plan-batch-partial',
          ),
        ];
  return {
    evidence,
    section: {
      key: 'trading-plans',
      title: '交易计划',
      required: true,
      status: missingDimensions.length === 0 ? 'complete' : 'partial',
      dataAsOf: now,
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'account', label: '账户' },
            { key: 'stock', label: '股票' },
            { key: 'action', label: '动作' },
            { key: 'status', label: '状态' },
            { key: 'version', label: '计划版本' },
            { key: 'entryRange', label: '入场区间' },
            { key: 'entryConditions', label: '入场条件' },
            { key: 'exitConditions', label: '退出条件' },
            { key: 'currentPct', label: '当前仓位%' },
            { key: 'targetPct', label: '目标仓位%' },
            { key: 'holdingDays', label: '预计持有交易日' },
            { key: 'risk', label: '风险' },
            { key: 'counterEvidence', label: '反证' },
            { key: 'unknowns', label: '未知 / 前置条件' },
            { key: 'validUntil', label: '有效期至' },
          ],
          rows: plans.map((plan) => ({
            account: plan.accountId,
            stock: plan.stockName ?? plan.stockId,
            action: plan.action,
            status: plan.status,
            version: `v${plan.version}`,
            entryRange:
              plan.entryPriceLow === undefined || plan.entryPriceHigh === undefined
                ? '未提供'
                : `${plan.entryPriceLow}-${plan.entryPriceHigh}`,
            entryConditions:
              plan.entryConditions.map((condition) => condition.description).join('；') || '无',
            exitConditions: plan.exit.conditions.join('；') || '未记录',
            currentPct: plan.position.currentPct,
            targetPct: plan.position.targetPct,
            holdingDays: `${plan.holding.minTradingDays}-${plan.holding.maxTradingDays}`,
            risk: plan.explanation.risks.join('；') || '未记录',
            counterEvidence: plan.explanation.counterEvidence.join('；') || '未记录',
            unknowns:
              [...plan.explanation.unknowns, ...plan.position.prerequisiteActions].join('；') ||
              '无',
            validUntil: plan.validUntil.toISOString(),
          })),
        },
        ...(plans.length === 0
          ? []
          : [
              {
                kind: 'list' as const,
                items: plans.map((plan) => ({
                  title: `${plan.stockName ?? plan.stockId} · ${plan.action} · v${plan.version}`,
                  detail: `入场 ${plan.entryPriceLow ?? '未提供'}-${plan.entryPriceHigh ?? '未提供'} · 目标 ${plan.position.targetPct === null ? '不可用' : `${plan.position.targetPct}%`} · ${plan.status}`,
                  entityKind: 'trading-plan' as const,
                  entityId: `${plan.id}:v${plan.version}`,
                })),
              },
            ]),
        ...(plans.length === 0
          ? [
              {
                kind: 'text' as const,
                tone: 'warning' as const,
                text: '账户事实、持仓复核或候选分析尚未形成可呈现的结构化计划；请区分研究未完成与没有合格机会。',
              },
            ]
          : []),
      ],
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions,
    },
  };
};

const planActionFingerprint = (report: Report): string => {
  const table = report.sections
    .find((section) => section.key === 'trading-plans')
    ?.blocks.find((block) => block.kind === 'table');
  if (table?.kind !== 'table') return '';
  return JSON.stringify(
    table.rows.map((row) => [
      row.account,
      row.stock,
      row.action,
      row.status,
      row.entryRange,
      row.entryConditions,
      row.exitConditions,
      row.targetPct,
    ]),
  );
};

const shouldNotifyClosingSupplement = (previous: Report, next: Report): boolean => {
  const previousMissing = previous.sections
    .filter((section) => section.required)
    .flatMap((section) => section.missingDimensions.map((gap) => gap.dimension));
  const currentMissing = new Set(next.missingDimensions.map((gap) => gap.dimension));
  return (
    previousMissing.some((dimension) => !currentMissing.has(dimension)) ||
    planActionFingerprint(previous) !== planActionFingerprint(next)
  );
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
  const result = await executeReportWorkflow(
    {
      workflowName: 'closing-report',
      kind: 'closing',
      template: 'closing-v1',
      mode: input.mode,
      ...(input.supplement === undefined ? {} : { supplement: input.supplement }),
      shouldNotifySupplement: shouldNotifyClosingSupplement,
      notify: input.notify ?? input.mode === 'scheduled',
      scope: input.scope,
      periodStart: date,
      periodEnd: date,
      title: `${date} 收盘复盘`,
      inputSummary: { marketDate: date, notify: input.notify ?? input.mode === 'scheduled' },
      buildSections: async (generatedAt) => {
        const sentiment = await ctx.tools.get_ashare_sentiment.execute({ date });
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
            tradingPlansSection(input.scope, generatedAt, ctx, input.planBatchStatus),
            input.scope.kind === 'account'
              ? priorDayReviewSection(date, input.scope.accountId, generatedAt, ctx)
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
