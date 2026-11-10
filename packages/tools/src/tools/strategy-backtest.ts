import {
  CURRENT_STRATEGY_EVALUATOR_IDENTITY,
  type DailyBar,
  readStrategyRunSnapshot,
  runStrictBacktest,
  STRATEGY_EVALUATOR_CODE_HASH,
  STRATEGY_EVALUATOR_VERSION,
  type StrategyResult,
  type StrategyRun,
  type StrictBacktestGateAudit,
  type StrictBacktestGateItem,
  type StrictBacktestMarketFact,
  StrictBacktestMarketFactSchema,
  StrictBacktestRunSchema,
  type StrictBacktestSpecV2,
  StrictBacktestSpecV2Schema,
  strategyRunUsesEvaluator,
  strictBacktestHash,
  strictBacktestSpecHash,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

const BacktestCostsInput = z.object({
  commissionBps: z.number().nonnegative().max(100),
  minimumCommission: z.number().nonnegative(),
  sellStampDutyBps: z.number().nonnegative().max(100),
  buySlippageBps: z.number().nonnegative().max(500),
  sellSlippageBps: z.number().nonnegative().max(500),
});

export const CreateStrictStrategyBacktestInput = z.object({
  strategyId: z.string().min(1),
  strategyVersionId: z.string().min(1),
  from: z.coerce.date(),
  to: z.coerce.date(),
  initialCash: z.number().positive().default(1_000_000),
  benchmarkStockId: z.string().min(1).default('000300.SH'),
  benchmarkDatasetVersion: z.string().min(1).default('000300.SH:qfq:daily:v1'),
  lotSize: z.number().int().positive().default(100),
  maxPositions: z.number().int().min(1).max(100).default(20),
  costs: BacktestCostsInput,
});
export const CreateStrictStrategyBacktestOutput = z.object({
  run: StrictBacktestRunSchema,
});

export const GetStrictStrategyBacktestInput = z.object({ backtestRunId: z.string().min(1) });
export const GetStrictStrategyBacktestOutput = z.object({
  run: StrictBacktestRunSchema.nullable(),
});

export const ListStrictStrategyBacktestsInput = z.object({
  strategyId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export const ListStrictStrategyBacktestsOutput = z.object({
  runs: z.array(StrictBacktestRunSchema),
});

export const ExecuteStrictStrategyBacktestInput = z.object({
  backtestRunId: z.string().min(1),
});
export const ExecuteStrictStrategyBacktestOutput = z.object({ run: StrictBacktestRunSchema });

const gate = (
  key: StrictBacktestGateItem['key'],
  status: StrictBacktestGateItem['status'],
  reason: string,
  evidenceRefs: readonly string[],
): StrictBacktestGateItem => ({ key, status, reason, evidenceRefs: [...evidenceRefs] });

const gateAudit = (
  items: readonly StrictBacktestGateItem[],
  assessedAt: Date,
): StrictBacktestGateAudit => ({
  status: items.every((item) => item.status === 'complete')
    ? 'complete'
    : items.every((item) => item.status === 'unavailable')
      ? 'unavailable'
      : 'partial',
  items: [...items],
  assessedAt,
});

export const orderStrictBacktestTargetStockIds = (results: readonly StrategyResult[]): string[] =>
  results
    .filter((result) => result.selected)
    .sort(
      (left, right) =>
        (left.rank ?? Number.POSITIVE_INFINITY) - (right.rank ?? Number.POSITIVE_INFINITY) ||
        left.stockId.localeCompare(right.stockId),
    )
    .map((result) => result.stockId);

interface AssembledBacktest {
  readonly gateAudit: StrictBacktestGateAudit;
  readonly inputFingerprint: string;
  readonly targets: readonly { date: Date; stockIds: readonly string[] }[];
  readonly marketFacts: readonly StrictBacktestMarketFact[];
  readonly benchmarkFacts: readonly StrictBacktestMarketFact[];
}

const buildMarketFact = (bar: DailyBar, datasetVersion: string): StrictBacktestMarketFact => {
  const contentHash = strictBacktestHash({
    stockId: bar.stockId,
    date: bar.date,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    source: bar.source,
  });
  return StrictBacktestMarketFactSchema.parse({
    stockId: bar.stockId,
    date: bar.date,
    rawOpen: bar.open,
    rawHigh: bar.high,
    rawLow: bar.low,
    rawClose: bar.close,
    sessionStatus: 'open',
    buyAllowed: true,
    sellAllowed: true,
    buyRestriction: 'none',
    sellRestriction: 'none',
    // qfq 日线已把公司行动计入价格；不再依赖 strategy_backtest_market_facts 拷贝表。
    corporateActionsStatus: 'complete',
    corporateActions: [],
    source: `${bar.source}:${datasetVersion}`,
    recordedAt: bar.date,
    contentHash,
  });
};

const assembleBacktest = async (
  spec: StrictBacktestSpecV2,
  ctx: ToolContext,
): Promise<AssembledBacktest> => {
  const candidates = await ctx.repos.strategyRun.listRuns({
    strategyId: spec.strategyId,
    since: spec.from,
    until: spec.to,
    limit: 500,
  });
  const byDate = new Map<string, StrategyRun>();
  for (const run of candidates) {
    if (run.strategyVersionId !== spec.strategyVersionId) continue;
    if (run.status !== 'complete' && run.status !== 'partial') continue;
    const snapshot = readStrategyRunSnapshot(run.inputSnapshot);
    if (snapshot.scope === 'evaluation' || snapshot.scope === undefined) continue;
    const key = run.dataAsOf.toISOString();
    const previous = byDate.get(key);
    if (previous === undefined || run.startedAt.getTime() > previous.startedAt.getTime()) {
      byDate.set(key, run);
    }
  }
  const days = [...byDate.values()].sort(
    (left, right) =>
      left.dataAsOf.getTime() - right.dataAsOf.getTime() || left.id.localeCompare(right.id),
  );

  const resultsByDay = new Map<string, readonly StrategyResult[]>();
  for (const day of days) {
    resultsByDay.set(day.dataAsOf.toISOString(), await ctx.repos.strategyRun.listResults(day.id));
  }

  const universeComplete =
    days.length >= 2 &&
    days.every((day) => {
      const snapshot = readStrategyRunSnapshot(day.inputSnapshot);
      return snapshot.universeKind === 'full' && snapshot.stockIds.length > 0;
    });
  const evaluatorComplete =
    days.length >= 2 &&
    days.every((day) =>
      strategyRunUsesEvaluator(day.inputSnapshot, {
        version: STRATEGY_EVALUATOR_VERSION,
        codeIdentity: STRATEGY_EVALUATOR_CODE_HASH,
      }),
    );

  const executionDays = days.slice(1);
  const targets = executionDays.map((day, index) => {
    const selectionDay = days[index];
    const results =
      selectionDay === undefined
        ? []
        : (resultsByDay.get(selectionDay.dataAsOf.toISOString()) ?? []);
    return {
      date: day.dataAsOf,
      stockIds: orderStrictBacktestTargetStockIds(results),
    };
  });
  const targetStockIds = [...new Set(targets.flatMap((target) => target.stockIds))].sort();

  const barsByStock = new Map<string, readonly DailyBar[]>();
  for (const stockId of targetStockIds) {
    barsByStock.set(stockId, await ctx.repos.dailyBar.findInRange(stockId, spec.from, spec.to));
  }
  const latestBarOnOrBefore = (stockId: string, date: Date): DailyBar | undefined => {
    const bars = barsByStock.get(stockId) ?? [];
    let found: DailyBar | undefined;
    for (const bar of bars) {
      if (bar.date.getTime() <= date.getTime()) found = bar;
    }
    return found;
  };

  const marketFacts: StrictBacktestMarketFact[] = [];
  for (const day of executionDays) {
    for (const stockId of targetStockIds) {
      const bar = latestBarOnOrBefore(stockId, day.dataAsOf);
      if (bar !== undefined) marketFacts.push(buildMarketFact(bar, 'qfq:daily:v1'));
    }
  }
  const requiredMarketKeys = executionDays.flatMap((day) =>
    targetStockIds.map((stockId) => `${stockId}\0${day.dataAsOf.toISOString()}`),
  );
  const coveredMarketKeys = new Set(
    marketFacts.map((fact) => `${fact.stockId}\0${fact.date.toISOString()}`),
  );
  const tradabilityComplete = requiredMarketKeys.every((key) => coveredMarketKeys.has(key));

  const benchmarkBars = await ctx.repos.dailyBar.findInRange(
    spec.benchmark.stockId,
    spec.from,
    spec.to,
  );
  const benchmarkFacts: StrictBacktestMarketFact[] = [];
  for (const day of executionDays) {
    const bar = benchmarkBars
      .filter((candidate) => candidate.date.getTime() <= day.dataAsOf.getTime())
      .at(-1);
    if (bar !== undefined) {
      benchmarkFacts.push(buildMarketFact(bar, spec.benchmark.datasetVersion));
    }
  }
  const benchmarkComplete = benchmarkFacts.length === executionDays.length;

  const items = [
    gate(
      'pit-universe',
      universeComplete ? 'complete' : days.length === 0 ? 'unavailable' : 'partial',
      universeComplete
        ? 'StrategyRun 历史覆盖完整 PIT universe'
        : '区间内缺少完整 PIT universe 的 operational StrategyRun',
      days.map((day) => `strategy-run:${day.id}`),
    ),
    gate(
      'daily-bar-revisions',
      tradabilityComplete ? 'complete' : marketFacts.length === 0 ? 'unavailable' : 'partial',
      tradabilityComplete
        ? '本地 qfq 日线覆盖全部执行日与目标股票'
        : '至少一个执行日缺少目标股票的本地 qfq 日线',
      marketFacts.map(
        (fact) => `market-fact:${fact.stockId}:${fact.date.toISOString()}:${fact.contentHash}`,
      ),
    ),
    gate('fees', 'complete', '费用模型与参数已固化进不可变 spec', [`fees:${spec.fees.model}`]),
    gate('slippage', 'complete', '滑点模型与参数已固化进不可变 spec', [
      `slippage:${spec.slippage.model}`,
    ]),
    gate(
      'tradability',
      tradabilityComplete
        ? 'complete'
        : targetStockIds.length === 0
          ? 'complete'
          : marketFacts.length === 0
            ? 'unavailable'
            : 'partial',
      tradabilityComplete
        ? '全部执行日具备 qfq 日线，按次日开盘成交'
        : '缺少停牌/退市导致的日线缺口',
      marketFacts.map(
        (fact) => `market-fact:${fact.stockId}:${fact.date.toISOString()}:${fact.contentHash}`,
      ),
    ),
    gate(
      'corporate-actions',
      marketFacts.length === 0 ? 'unavailable' : 'complete',
      marketFacts.length === 0
        ? '没有市场事实，无法确认公司行动处理'
        : 'qfq 日线已包含公司行动调整，公式化回测不再单独叠加',
      marketFacts.map((fact) => `corporate-actions:${fact.stockId}:${fact.date.toISOString()}`),
    ),
    gate(
      'benchmark',
      benchmarkComplete ? 'complete' : benchmarkFacts.length === 0 ? 'unavailable' : 'partial',
      benchmarkComplete ? '本地 qfq benchmark 日线覆盖完整执行区间' : 'benchmark 日线覆盖不完整',
      benchmarkFacts.map((fact) => `benchmark:${fact.date.toISOString()}:${fact.contentHash}`),
    ),
    gate(
      'evaluator-code',
      evaluatorComplete ? 'complete' : days.length === 0 ? 'unavailable' : 'partial',
      evaluatorComplete
        ? '全部历史运行绑定相同 evaluator version 与 code hash'
        : '历史运行缺少 evaluator code identity 或身份不一致',
      days.map((day) => `strategy-run:${day.id}`),
    ),
  ] satisfies StrictBacktestGateItem[];
  const audit = gateAudit(items, ctx.clock());
  const inputFingerprint = strictBacktestHash({
    specHash: strictBacktestSpecHash(spec),
    days: days.map((day) => ({ id: day.id, dataAsOf: day.dataAsOf })),
    targets,
    marketFacts: marketFacts.map((fact) => fact.contentHash),
    benchmarkFacts: benchmarkFacts.map((fact) => fact.contentHash),
    evaluator: CURRENT_STRATEGY_EVALUATOR_IDENTITY,
  });
  return { gateAudit: audit, inputFingerprint, targets, marketFacts, benchmarkFacts };
};

export const createStrictStrategyBacktestTool = defineTool({
  name: 'create_strict_strategy_backtest',
  description: '基于已完成 PIT evaluation 创建隔离严格回测；门禁不全时只返回审计，不输出收益指标',
  sideEffect: 'write',
  input: CreateStrictStrategyBacktestInput,
  output: CreateStrictStrategyBacktestOutput,
  handler: async (input, ctx: ToolContext) => {
    const strategy = await ctx.repos.strategy.findById(input.strategyId);
    if (strategy === null) return errNotFound('Strategy', input.strategyId);
    const version = await ctx.repos.strategy.findVersionById(input.strategyVersionId);
    if (version === null) return errNotFound('StrategyVersion', input.strategyVersionId);
    if (version.strategyId !== strategy.id) {
      return errInvalidInput('strategyVersionId 不属于指定 Strategy');
    }
    const spec = StrictBacktestSpecV2Schema.parse({
      schemaVersion: 2,
      strategyId: input.strategyId,
      strategyVersionId: input.strategyVersionId,
      from: input.from,
      to: input.to,
      initialCash: input.initialCash,
      benchmark: { stockId: input.benchmarkStockId, datasetVersion: input.benchmarkDatasetVersion },
      execution: {
        model: 'next-open-full-rebalance-equal-weight-v1',
        lotSize: input.lotSize,
        maxPositions: input.maxPositions,
      },
      fees: {
        model: 'ashare-fees-v1',
        commissionBps: input.costs.commissionBps,
        minimumCommission: input.costs.minimumCommission,
        sellStampDutyBps: input.costs.sellStampDutyBps,
      },
      slippage: {
        model: 'fixed-bps-at-open-v1',
        buyBps: input.costs.buySlippageBps,
        sellBps: input.costs.sellSlippageBps,
      },
    });
    const assembled = await assembleBacktest(spec, ctx);
    const specHash = strictBacktestSpecHash(spec);
    const id = `strict-backtest-${strictBacktestHash({ specHash, inputFingerprint: assembled.inputFingerprint }).slice(0, 32)}`;
    const existing = await ctx.repos.strategyBacktest.findRunById(id);
    if (existing !== null) return { run: existing };
    const now = ctx.clock();
    const runnable = assembled.gateAudit.status === 'complete';
    const run = StrictBacktestRunSchema.parse({
      id,
      status: runnable ? 'queued' : 'complete',
      resultAvailability: assembled.gateAudit.status,
      spec,
      specHash,
      inputFingerprint: assembled.inputFingerprint,
      evaluator: CURRENT_STRATEGY_EVALUATOR_IDENTITY,
      gateAudit: assembled.gateAudit,
      createdAt: now,
      ...(runnable ? {} : { finishedAt: now }),
    });
    await ctx.repos.strategyBacktest.saveRun(run);
    return { run };
  },
});

export const executeStrictStrategyBacktestTool = defineTool({
  name: 'execute_strict_strategy_backtest',
  description: '执行已通过全部事实门禁的严格回测；不生成 Advice、Trade 或通知',
  sideEffect: 'write',
  input: ExecuteStrictStrategyBacktestInput,
  output: ExecuteStrictStrategyBacktestOutput,
  handler: async (input, ctx: ToolContext) => {
    const existing = await ctx.repos.strategyBacktest.findRunById(input.backtestRunId);
    if (existing === null) return errNotFound('StrictStrategyBacktest', input.backtestRunId);
    if (existing.status === 'complete' || existing.status === 'failed') return { run: existing };
    if (existing.spec.schemaVersion === 1) {
      return errInvalidInput('v1 strict backtest 已退役，只支持只读查询；请用 v2 重新创建');
    }
    if (existing.gateAudit.status !== 'complete')
      return errInvalidInput('strict backtest facts gate 未完成');
    const assembled = await assembleBacktest(existing.spec, ctx);
    if (assembled.inputFingerprint !== existing.inputFingerprint) {
      const failed = StrictBacktestRunSchema.parse({
        ...existing,
        status: 'failed',
        error: 'strict_backtest_input_changed',
        finishedAt: ctx.clock(),
      });
      await ctx.repos.strategyBacktest.saveRun(failed);
      return { run: failed };
    }
    const running = StrictBacktestRunSchema.parse({
      ...existing,
      status: 'running',
      startedAt: ctx.clock(),
    });
    await ctx.repos.strategyBacktest.saveRun(running);
    try {
      const metrics = runStrictBacktest({
        spec: existing.spec,
        targets: assembled.targets,
        marketFacts: assembled.marketFacts,
        benchmarkFacts: assembled.benchmarkFacts,
      });
      const complete = StrictBacktestRunSchema.parse({
        ...running,
        status: 'complete',
        resultAvailability: 'complete',
        metrics,
        finishedAt: ctx.clock(),
      });
      await ctx.repos.strategyBacktest.saveRun(complete);
      return { run: complete };
    } catch (error) {
      const failed = StrictBacktestRunSchema.parse({
        ...running,
        status: 'failed',
        error: error instanceof Error ? error.message : 'strict_backtest_execution_failed',
        finishedAt: ctx.clock(),
      });
      await ctx.repos.strategyBacktest.saveRun(failed);
      return { run: failed };
    }
  },
});

export const getStrictStrategyBacktestTool = defineTool({
  name: 'get_strict_strategy_backtest',
  description: '读取隔离严格回测运行、逐项数据门禁和可用指标',
  sideEffect: 'read',
  input: GetStrictStrategyBacktestInput,
  output: GetStrictStrategyBacktestOutput,
  handler: async (input, ctx) => ({
    run: await ctx.repos.strategyBacktest.findRunById(input.backtestRunId),
  }),
});

export const listStrictStrategyBacktestsTool = defineTool({
  name: 'list_strict_strategy_backtests',
  description: '列出严格回测运行；与 StrategyRun operational/evaluation 事实隔离',
  sideEffect: 'read',
  input: ListStrictStrategyBacktestsInput,
  output: ListStrictStrategyBacktestsOutput,
  handler: async (input, ctx) => ({
    runs: await ctx.repos.strategyBacktest.listRuns({
      ...(input.strategyId === undefined ? {} : { strategyId: input.strategyId }),
      limit: input.limit,
    }),
  }),
});
