import {
  dateInShanghai,
  isHoliday,
  isWeekend,
  type ReportBlock,
  ReportSchema,
  ReportScopeSchema,
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
            title: advice.subjectId,
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
 * 「策略行动」：当日策略建议按方向分组，buy 优先为「值得买入」，逐条给出操作建议
 * （现价 + 理由 + 风险 + 有效期）。decision 值仅以文本展示，block 不含决策字段 key
 * （report 不变量约束），entityKind='advice' 链接回 Advice 本体。
 */
const strategyActionsSection = async (
  date: string,
  now: Date,
  ctx: WorkflowContext,
): Promise<ReportSectionPiece> => {
  const dayStart = new Date(`${date}T00:00:00+08:00`);
  const [strategies, runs, advices] = await Promise.all([
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
  const buyAdvices = dayAdvices.filter((advice) => advice.decision === 'buy');
  const watchAdvices = dayAdvices.filter((advice) => advice.decision === 'watch');
  const avoidAdvices = dayAdvices.filter(
    (advice) => advice.decision === 'sell' || advice.decision === 'avoid',
  );
  const adviceActionDetail = (advice: (typeof dayAdvices)[number]): string => {
    const quote = advice.basedOn.quotes?.[advice.subjectId];
    const parts: string[] = [];
    if (quote !== undefined) parts.push(`现价 ${quote.close}`);
    const pricePlan: string[] = [];
    if (advice.entryPrice !== undefined) pricePlan.push(`买点 ${advice.entryPrice}`);
    if (advice.targetPrice !== undefined) pricePlan.push(`卖点 ${advice.targetPrice}`);
    if (advice.stopLoss !== undefined) pricePlan.push(`止损 ${advice.stopLoss}`);
    if (pricePlan.length > 0) parts.push(pricePlan.join(' / '));
    parts.push(advice.reasoning.premise);
    if (advice.risks.length > 0) parts.push(`风险：${advice.risks.join('；')}`);
    parts.push(`有效期至 ${dateInShanghai(advice.validUntil)}`);
    return parts.join(' · ');
  };
  const adviceItem = (advice: (typeof dayAdvices)[number]) => ({
    title: advice.stockName ?? advice.subjectId,
    detail: `${adviceDecisionLabel(advice.decision)} · ${adviceActionDetail(advice)}`,
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
      ],
      rows: strategies.data.strategies.map((strategy) => {
        const run = latestRunByStrategy.get(strategy.id);
        return {
          strategy: strategy.name,
          selectedCount: summaryCount(run, 'selectedCount'),
          signalCount: summaryCount(run, 'signalCount'),
        };
      }),
    },
    {
      kind: 'text',
      tone: 'factual',
      text:
        buyAdvices.length === 0
          ? `${date} 无值得买入的策略标的。`
          : `值得买入（${buyAdvices.length}）：`,
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
  return {
    evidence,
    section: {
      key: 'strategy-actions',
      title: '策略行动',
      required: false,
      status: 'complete' as const,
      dataAsOf: now,
      blocks,
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
        const [performance, triggers, adviceExpiry, strategyActions, nextEvents] =
          await Promise.all([
            accountPerformance(input, generatedAt, ctx),
            triggersSection(date, generatedAt, ctx),
            adviceExpirySection(date, generatedAt, ctx),
            strategyActionsSection(date, generatedAt, ctx),
            nextEventsSection(date, generatedAt, ctx),
          ]);
        return [market, performance, triggers, adviceExpiry, strategyActions, nextEvents];
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
