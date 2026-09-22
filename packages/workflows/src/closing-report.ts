import {
  adviceNotificationSummary,
  dateInShanghai,
  isHoliday,
  isWeekend,
  notificationText,
  notificationTime,
  type ReportBlock,
  ReportSchema,
  ReportScopeSchema,
  StrategyRecommendationBatchSummarySchema,
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
  shanghaiDate,
  unavailableSection,
} from './opening-report.js';

export const ClosingReportInput = z.object({
  date: z.string().date().optional(),
  scope: ReportScopeSchema.default({ kind: 'all-accounts' }),
  notify: z.boolean().optional(),
  mode: z.enum(['manual', 'scheduled']).default('manual'),
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

const triggersSection = async (date: string, now: Date, ctx: WorkflowContext) => {
  const since = new Date(`${date}T00:00:00+08:00`);
  const result = await ctx.tools.list_watch_triggers.execute({ since, limit: 500 });
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
          items: result.data.triggers.map((trigger) => ({
            title: `${trigger.stockId} · ${trigger.ruleKind}`,
            detail: `${trigger.priority} · ${trigger.deliveryStatus}`,
            notificationSummary: `${trigger.priority === 'urgent' ? '紧急' : trigger.priority === 'important' ? '重要' : '提醒'} · ${trigger.deliveryStatus === 'sent' ? '已送达' : trigger.deliveryStatus === 'failed' ? '投递失败' : trigger.deliveryStatus === 'fallback-log' ? '仅记日志' : '尚未送达'}\n${notificationText(trigger.reason, 90) || '请核对原始触发条件'} · ${notificationTime(trigger.createdAt)}（北京时间）`,
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

const adviceExpirySection = async (date: string, now: Date, ctx: WorkflowContext) => {
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
  const expiring = result.data.advices.filter(
    (advice) => dateInShanghai(advice.validUntil) === date,
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

/**
 * 「策略行动」：当日策略建议按方向分组，呈现 AI 判断与未分析候选事实
 * （现价 + 理由 + 风险 + 有效期）。decision 值仅以文本展示，block 不含决策字段 key
 * （report 不变量约束），entityKind='advice' 链接回 Advice 本体。
 */
const strategyActionsSection = async (
  date: string,
  now: Date,
  ctx: WorkflowContext,
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
      false,
      now,
      'strategy-actions.strategies',
      strategies.error.kind,
    );
  }
  if (!runs.ok) {
    return unavailableSection(
      'strategy-actions',
      '策略行动',
      false,
      now,
      'strategy-actions.runs',
      runs.error.kind,
    );
  }
  if (!advices.ok) {
    return unavailableSection(
      'strategy-actions',
      '策略行动',
      false,
      now,
      'strategy-actions.advice',
      advices.error.kind,
    );
  }

  const dayRuns = runs.data.runs.filter((run) => dateInShanghai(run.dataAsOf) === date);
  const latestRunByStrategy = new Map<string, (typeof dayRuns)[number]>();
  for (const run of dayRuns) {
    if (!latestRunByStrategy.has(run.strategyId)) latestRunByStrategy.set(run.strategyId, run);
  }
  const dayAdvices = advices.data.advices.filter(
    (advice) => dateInShanghai(advice.createdAt) === date,
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
      analysisByStrategy.set(strategy.id, '今日未运行');
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
      required: false,
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
  return {
    evidence,
    section: {
      key: 'trading-plans',
      title: '交易计划',
      required: true,
      status: 'complete',
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
      missingDimensions: [],
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
        const [performance, triggers, adviceExpiry, strategyActions, plans, nextEvents] =
          await Promise.all([
            accountPerformance(input, generatedAt, ctx),
            triggersSection(date, generatedAt, ctx),
            adviceExpirySection(date, generatedAt, ctx),
            strategyActionsSection(date, generatedAt, ctx),
            tradingPlansSection(input.scope, generatedAt, ctx),
            nextEventsSection(date, generatedAt, ctx),
          ]);
        return [market, performance, triggers, adviceExpiry, strategyActions, plans, nextEvents];
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
