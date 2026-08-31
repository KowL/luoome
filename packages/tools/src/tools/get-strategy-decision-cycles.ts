import {
  ACTIVE_SIGNAL_OBSERVATION_HORIZONS,
  ActiveSignalObservationHorizonSchema,
  type Advice,
  AdviceSchema,
  isPublishableOperationalRun,
  type SignalObservation,
  SignalObservationSchema,
  type StrategyResult,
  StrategyResultSchema,
  type StrategyRun,
  StrategyRunSchema,
  StrategySignalSchema,
  type ToolContext,
  type Trade,
  TradeSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

const HorizonStatusSchema = z.enum(['pending', 'complete', 'unavailable']);

const ObservationProgressSchema = z.object({
  horizon: ActiveSignalObservationHorizonSchema,
  status: HorizonStatusSchema,
  observationIds: z.array(z.string().min(1)),
  factIds: z.array(z.string().min(1)),
  completeCount: z.number().int().nonnegative(),
  pendingCount: z.number().int().nonnegative(),
  unavailableCount: z.number().int().nonnegative(),
  dueAt: z.coerce.date().optional(),
  observedAt: z.coerce.date().optional(),
  benchmarkStatus: z.enum(['complete', 'unavailable']),
  unavailableReasons: z.array(z.string().min(1)),
});

const TradeLinkSchema = z.object({
  tradeId: z.string().min(1),
  adviceId: z.string().min(1),
  relation: z.enum(['trade.adviceId', 'advice.outcome.tradeIds']),
});

const ExcludedRunSchema = z.object({
  runId: z.string().min(1),
  reason: z.string().min(1),
});

export const GetStrategyDecisionCyclesInput = z.object({
  strategyId: z.string().min(1),
  accountId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  stockId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

const StrategyCandidateCycleSchema = z.object({
  strategyId: z.string().min(1),
  strategyVersionId: z.string().min(1),
  runId: z.string().min(1),
  stockId: z.string().min(1),
  run: StrategyRunSchema,
  result: StrategyResultSchema,
  signals: z.array(StrategySignalSchema),
  signalFactIds: z.array(
    z.object({
      signalId: z.string().min(1),
      factIds: z.array(z.string().min(1)),
    }),
  ),
  observations: z.array(SignalObservationSchema),
  observationProgress: z.array(ObservationProgressSchema),
  advices: z.array(AdviceSchema),
  trades: z.array(TradeSchema),
  tradeLinks: z.array(TradeLinkSchema),
  evidenceIds: z.array(z.string().min(1)),
  unknowns: z.array(z.string().min(1)),
  limitations: z.array(z.string().min(1)),
  factsAsOf: z.coerce.date(),
});

export const GetStrategyDecisionCyclesOutput = z.object({
  accountId: z.string().min(1),
  strategyId: z.string().min(1),
  total: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(200),
  cycles: z.array(StrategyCandidateCycleSchema),
  excludedRuns: z.array(ExcludedRunSchema),
  evidenceIds: z.array(z.string().min(1)),
  unknowns: z.array(z.string().min(1)),
  limitations: z.array(z.string().min(1)),
  factsAsOf: z.coerce.date(),
});

type ObservationProgress = z.infer<typeof ObservationProgressSchema>;
type TradeLink = z.infer<typeof TradeLinkSchema>;
type StrategyCandidateCycle = z.infer<typeof StrategyCandidateCycleSchema>;

const HORIZONS = ACTIVE_SIGNAL_OBSERVATION_HORIZONS;

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function maxDate(values: Array<Date | undefined>): Date | undefined {
  const present = values.filter((value): value is Date => value instanceof Date);
  if (present.length === 0) return undefined;
  return new Date(Math.max(...present.map((value) => value.getTime())));
}

function minDate(values: Array<Date | undefined>): Date | undefined {
  const present = values.filter((value): value is Date => value instanceof Date);
  if (present.length === 0) return undefined;
  return new Date(Math.min(...present.map((value) => value.getTime())));
}

function observationsForProgress(
  observations: SignalObservation[],
  horizon: (typeof HORIZONS)[number],
): { progress: ObservationProgress; unknowns: string[] } {
  const rows = observations.filter((observation) => observation.horizon === horizon);
  const completeCount = rows.filter((observation) => observation.status === 'complete').length;
  const pendingCount = rows.filter((observation) => observation.status === 'pending').length;
  const unavailableCount = rows.filter(
    (observation) => observation.status === 'unavailable',
  ).length;
  const status =
    rows.length === 0
      ? 'unavailable'
      : completeCount === rows.length
        ? 'complete'
        : unavailableCount === rows.length
          ? 'unavailable'
          : 'pending';
  const benchmarkStatus =
    rows.length > 0 && rows.every((observation) => observation.benchmarkStatus === 'complete')
      ? 'complete'
      : 'unavailable';
  const unavailableReasons = unique(
    rows
      .map((observation) => observation.unavailableReason)
      .filter((reason): reason is string => Boolean(reason)),
  );
  if (rows.length === 0) unavailableReasons.push('尚无该 horizon 的 SignalObservation 记录。');

  const unknowns: string[] = [];
  if (pendingCount > 0)
    unknowns.push(`${horizon} 仍有 ${pendingCount} 条 SignalObservation 待完成。`);
  if (unavailableCount > 0)
    unknowns.push(`${horizon} 有 ${unavailableCount} 条 SignalObservation 不可用。`);
  if (benchmarkStatus === 'unavailable') {
    unknowns.push(`${horizon} benchmark 状态为 unavailable，未用 0 填充。`);
  }

  return {
    progress: {
      horizon,
      status,
      observationIds: rows.map((observation) => observation.id),
      factIds: rows.map((observation) => observation.id),
      completeCount,
      pendingCount,
      unavailableCount,
      dueAt: minDate(rows.map((observation) => observation.dueAt)),
      observedAt: maxDate(rows.map((observation) => observation.observedAt)),
      benchmarkStatus,
      unavailableReasons: unique(unavailableReasons),
    },
    unknowns,
  };
}

function adviceMatchesCycle(
  advice: Advice,
  strategyId: string,
  runId: string,
  stockId: string,
): boolean {
  const strategy = advice.basedOn?.strategy;
  return (
    strategy?.strategyId === strategyId && strategy.runId === runId && strategy.stockId === stockId
  );
}

function explicitTradeRelations(
  advice: Advice[],
  trades: Trade[],
  stockId: string,
  strategyVersionId: string,
): { trades: Trade[]; tradeLinks: TradeLink[]; unknowns: string[] } {
  const links: TradeLink[] = [];
  const linkedTradeIds = new Set<string>();
  const unknowns: string[] = [];
  const tradesById = new Map(trades.map((trade) => [trade.id, trade]));

  for (const adviceRow of advice) {
    if (adviceRow.basedOn?.strategy?.stockId !== stockId) continue;
    const outcomeTradeIds = adviceRow.outcome?.tradeIds ?? [];
    for (const trade of trades) {
      if (trade.adviceId === adviceRow.id) {
        if (trade.stockId !== stockId) {
          unknowns.push(`Advice ${adviceRow.id} 的 Trade ${trade.id} 股票不匹配，未纳入本周期。`);
          continue;
        }
        linkedTradeIds.add(trade.id);
        links.push({ tradeId: trade.id, adviceId: adviceRow.id, relation: 'trade.adviceId' });
      }
      if (trade.stockId === stockId && outcomeTradeIds.includes(trade.id)) {
        linkedTradeIds.add(trade.id);
        links.push({
          tradeId: trade.id,
          adviceId: adviceRow.id,
          relation: 'advice.outcome.tradeIds',
        });
      }
    }
    for (const tradeId of outcomeTradeIds) {
      const trade = tradesById.get(tradeId);
      if (!trade) {
        unknowns.push(
          `Advice ${adviceRow.id} 显式引用的 Trade ${tradeId} 不在当前账户可用范围内。`,
        );
      } else if (trade.stockId !== stockId) {
        unknowns.push(`Advice ${adviceRow.id} 引用的 Trade ${tradeId} 股票不匹配，未纳入本周期。`);
      }
    }
    if (!adviceRow.outcome) unknowns.push(`Advice ${adviceRow.id} 尚未回填 AdviceOutcome。`);
  }

  if (
    trades.some(
      (trade) =>
        trade.stockId === stockId &&
        trade.strategyVersionId === strategyVersionId &&
        !linkedTradeIds.has(trade.id),
    )
  ) {
    unknowns.push(
      '存在仅带 strategyVersionId、没有 Advice 显式关联的 Trade；未推断其所属 run/周期。',
    );
  }

  return {
    trades: trades.filter((trade) => linkedTradeIds.has(trade.id)),
    tradeLinks: links,
    unknowns: unique(unknowns),
  };
}

const hasAcceptedRun = (run: StrategyRun): boolean => {
  const summary = run.summary;
  if (summary === undefined || typeof summary !== 'object' || summary === null) return true;
  if (!('acceptance' in summary)) return true;
  const acceptance = summary.acceptance;
  return (
    typeof acceptance === 'object' &&
    acceptance !== null &&
    'decision' in acceptance &&
    acceptance.decision === 'accepted'
  );
};

function runExclusionReason(run: StrategyRun): string {
  if (run.mode === 'replay' || run.mode === 'backtest')
    return `${run.mode} 运行不属于生产 operational run，不进入生产闭环。`;
  if (run.scope !== 'operational')
    return '非 operational 运行（包含 evaluation/replay 等）不进入生产闭环。';
  if (run.publication?.status !== 'published') return '运行未 published，不进入生产闭环。';
  if (!hasAcceptedRun(run)) return '运行 acceptance decision 不是 accepted，不进入生产闭环。';
  if (run.status !== 'complete') return `运行状态为 ${run.status}，不是可发布的 operational run。`;
  return '运行不满足生产闭环门禁。';
}

const isProductionCycleRun = (run: StrategyRun): boolean =>
  (run.mode === 'scan' || run.mode === 'scheduled') &&
  isPublishableOperationalRun(run) &&
  hasAcceptedRun(run);

async function loadCycle(
  ctx: ToolContext,
  run: StrategyRun,
  result: StrategyResult,
  accountTrades: Trade[],
  advicesForStock: Advice[],
  factsAsOf: Date,
): Promise<StrategyCandidateCycle> {
  const signals = (await ctx.repos.strategyRun.signalsByRun(run.id)).filter(
    (signal) => signal.stockId === result.stockId,
  );
  const signalIds = signals.map((signal) => signal.id);
  const observations = signalIds.length
    ? await ctx.repos.signalObservation.list({
        sourceKind: 'strategy-signal',
        sourceIds: signalIds,
        horizons: HORIZONS,
        limit: 5000,
      })
    : [];
  const cycleObservations = observations.filter((observation) =>
    signalIds.includes(observation.sourceId),
  );
  const progressRows = HORIZONS.map((horizon) =>
    observationsForProgress(cycleObservations, horizon),
  );
  const advices = advicesForStock.filter((advice) =>
    adviceMatchesCycle(advice, run.strategyId, run.id, result.stockId),
  );
  const tradeRelations = explicitTradeRelations(
    advices,
    accountTrades,
    result.stockId,
    run.strategyVersionId,
  );
  const unknowns = [...progressRows.flatMap((row) => row.unknowns), ...tradeRelations.unknowns];
  if (advices.length === 0) {
    unknowns.push('本周期尚无匹配的 Strategy Advice；可能未启用推荐策略或尚未到生成阶段。');
  }
  const limitations = [
    '周期由 strategyId + runId + stockId 派生，不新增持久化闭环实体。',
    'SignalObservation 是信号后的确定性事实观察，不是回测，也不包含成交、费用或滑点假设。',
    'Trade 只按 Advice ID 或 AdviceOutcome.tradeIds 显式归因；不会从 strategyVersionId、日期或股票推断周期。',
    'replay、evaluation、withheld 与 non-publishing 运行不会进入生产闭环或触发 Advice。',
  ];
  const evidenceIds = unique([
    run.id,
    run.strategyVersionId,
    ...result.evidence,
    ...signals.flatMap((signal) => [signal.id, ...signal.evidence]),
    ...cycleObservations.map((observation) => observation.id),
    ...advices.map((advice) => advice.id),
    ...tradeRelations.trades.map((trade) => trade.id),
  ]);

  return {
    strategyId: run.strategyId,
    strategyVersionId: run.strategyVersionId,
    runId: run.id,
    stockId: result.stockId,
    run,
    result,
    signals,
    signalFactIds: signals.map((signal) => ({
      signalId: signal.id,
      factIds: unique([signal.id, ...signal.evidence]),
    })),
    observations: cycleObservations,
    observationProgress: progressRows.map((row) => row.progress),
    advices: AdviceSchema.array().parse(advices),
    trades: tradeRelations.trades,
    tradeLinks: tradeRelations.tradeLinks,
    evidenceIds,
    unknowns: unique(unknowns),
    limitations,
    factsAsOf,
  };
}

export const getStrategyDecisionCyclesTool = defineTool({
  name: 'get_strategy_decision_cycles',
  description:
    '读取按 strategyId + runId + stockId 派生的策略候选决策周期，串联结果、信号、事实观察、Advice 和仅有显式 ID 关系的当前账户 Trade。',
  sideEffect: 'read',
  input: GetStrategyDecisionCyclesInput,
  output: GetStrategyDecisionCyclesOutput,
  handler: async (input, ctx) => {
    const strategy = await ctx.repos.strategy.findById(input.strategyId);
    if (!strategy) return errNotFound('strategy', input.strategyId);
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    const account = await ctx.repos.account.findById(accountId);
    if (!account) return errNotFound('account', accountId);

    const excludedRuns: Array<z.infer<typeof ExcludedRunSchema>> = [];
    let runs: StrategyRun[];
    if (input.runId) {
      const run = await ctx.repos.strategyRun.findRunById(input.runId);
      if (!run) return errNotFound('strategyRun', input.runId);
      if (run.strategyId !== input.strategyId) {
        return errInvalidInput('runId 不属于 strategyId 指定的策略。');
      }
      if (!isProductionCycleRun(run)) {
        excludedRuns.push({ runId: run.id, reason: runExclusionReason(run) });
        runs = [];
      } else {
        runs = [run];
      }
    } else {
      const listedRuns = await ctx.repos.strategyRun.listRuns({
        strategyId: input.strategyId,
        limit: Math.min(500, Math.max(input.limit * 4, 50)),
      });
      runs = [];
      for (const run of listedRuns) {
        if (isProductionCycleRun(run)) runs.push(run);
        else excludedRuns.push({ runId: run.id, reason: runExclusionReason(run) });
      }
    }

    const accountTrades = await ctx.repos.trade.listByAccount(accountId);
    const adviceByStock = new Map<string, Advice[]>();
    const cycles: StrategyCandidateCycle[] = [];
    const factsAsOf = ctx.clock();

    for (const run of runs) {
      if (cycles.length >= input.limit) break;
      const results = await ctx.repos.strategyRun.listResults(run.id);
      const selectedResults = results.filter(
        (result) => result.selected && (!input.stockId || result.stockId === input.stockId),
      );
      for (const result of selectedResults) {
        if (cycles.length >= input.limit) break;
        const stockId = result.stockId;
        if (!adviceByStock.has(stockId)) {
          const rows = await ctx.repos.advice.query({
            subjectKind: 'stock',
            subjectId: stockId,
            includeExpired: true,
            limit: 5000,
          });
          adviceByStock.set(stockId, [...rows]);
        }
        cycles.push(
          await loadCycle(
            ctx,
            run,
            result,
            accountTrades,
            adviceByStock.get(stockId) ?? [],
            factsAsOf,
          ),
        );
      }
    }

    const unknowns = unique([
      ...excludedRuns.map((run) => `${run.runId}：${run.reason}`),
      ...cycles.flatMap((cycle) => cycle.unknowns),
    ]);
    const limitations = unique([
      '只返回 published operational StrategyRun 的生产候选周期；replay/evaluation/withheld/non-publishing 被排除。',
      '周期以 strategyId + runId + stockId 派生；没有独立闭环持久化实体。',
      'Trade 归因需要 Advice ID 或 AdviceOutcome.tradeIds 的显式关系；仅有 strategyVersionId 不足以归入周期。',
      ...cycles.flatMap((cycle) => cycle.limitations),
    ]);
    const evidenceIds = unique([
      ...cycles.flatMap((cycle) => cycle.evidenceIds),
      ...excludedRuns.map((run) => run.runId),
    ]);

    return {
      accountId,
      strategyId: input.strategyId,
      total: cycles.length,
      limit: input.limit,
      cycles,
      excludedRuns,
      evidenceIds,
      unknowns,
      limitations,
      factsAsOf,
    };
  },
});
