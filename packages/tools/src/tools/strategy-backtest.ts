import {
  CURRENT_STRATEGY_EVALUATOR_IDENTITY,
  compareStrategyRunEvaluator,
  EVALUATOR_CODE_IDENTITY_SOURCE,
  runStrictBacktest,
  STRATEGY_EVALUATOR_CODE_HASH,
  STRATEGY_EVALUATOR_VERSION,
  type StrategyEvaluationDay,
  type StrategyEvaluationSession,
  type StrategyResult,
  type StrictBacktestGateAudit,
  type StrictBacktestGateItem,
  type StrictBacktestMarketFact,
  StrictBacktestRunSchema,
  StrictBacktestSpecSchema,
  strictBacktestHash,
  strictBacktestSpecHash,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';
import {
  type BacktestMarketFactSyncReport,
  describeBacktestFactSkips,
  syncBacktestMarketFacts,
} from '../internal/backtest-market-facts.js';

const BacktestCostsInput = z.object({
  commissionBps: z.number().nonnegative().max(100),
  minimumCommission: z.number().nonnegative(),
  sellStampDutyBps: z.number().nonnegative().max(100),
  buySlippageBps: z.number().nonnegative().max(500),
  sellSlippageBps: z.number().nonnegative().max(500),
});

export const CreateStrictStrategyBacktestInput = z.object({
  strategyId: z.string().min(1),
  evaluationSessionId: z.string().min(1),
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

/**
 * 已披露的范围缺口：`corporate-actions` 无数据源（§8 不在本期范围），
 * 不阻断回测执行，但必须在 gateAudit 里逐项可见。其余门禁仍必须 complete。
 */
const DISCLOSED_GAP_GATES: ReadonlySet<StrictBacktestGateItem['key']> = new Set([
  'corporate-actions',
]);

export const blockingGatesComplete = (audit: StrictBacktestGateAudit): boolean =>
  audit.items
    .filter((item) => !DISCLOSED_GAP_GATES.has(item.key))
    .every((item) => item.status === 'complete');

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

const latestFactsByStockDate = (
  facts: readonly StrictBacktestMarketFact[],
  cutoffByDate: ReadonlyMap<string, Date>,
): Map<string, StrictBacktestMarketFact> => {
  const result = new Map<string, StrictBacktestMarketFact>();
  for (const fact of facts) {
    const cutoff = cutoffByDate.get(fact.date.toISOString());
    if (cutoff === undefined || fact.recordedAt > cutoff) continue;
    const key = `${fact.stockId}\0${fact.date.toISOString()}`;
    const existing = result.get(key);
    if (
      existing === undefined ||
      fact.recordedAt > existing.recordedAt ||
      (fact.recordedAt.getTime() === existing.recordedAt.getTime() &&
        fact.contentHash > existing.contentHash)
    ) {
      result.set(key, fact);
    }
  }
  return result;
};

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

interface BacktestContext {
  readonly session: StrategyEvaluationSession;
  readonly days: readonly StrategyEvaluationDay[];
  readonly completeDays: readonly StrategyEvaluationDay[];
  readonly executionDays: readonly StrategyEvaluationDay[];
  readonly targets: readonly { readonly date: Date; readonly stockIds: readonly string[] }[];
  readonly targetStockIds: readonly string[];
  readonly cutoffByDate: ReadonlyMap<string, Date>;
  readonly runs: ReadonlyMap<
    string,
    Awaited<ReturnType<ToolContext['repos']['strategyRun']['findRunById']>>
  >;
  readonly resultsByDay: ReadonlyMap<string, readonly StrategyResult[]>;
  readonly pitComplete: boolean;
  readonly revisionComplete: boolean;
  readonly evaluatorComplete: boolean;
  readonly evaluatorComparisons: readonly (
    | 'match'
    | 'not-v3'
    | 'version-mismatch'
    | 'legacy-identity'
    | 'identity-basis-mismatch'
    | 'code-identity-mismatch'
    | 'missing'
  )[];
}

const collectBacktestContext = async (
  spec: z.infer<typeof StrictBacktestSpecSchema>,
  ctx: ToolContext,
): Promise<BacktestContext> => {
  const session = await ctx.repos.strategyEvaluation.findSessionById(spec.evaluationSessionId);
  if (session === null)
    throw new Error(`StrategyEvaluationSession not found: ${spec.evaluationSessionId}`);
  const days = [...(await ctx.repos.strategyEvaluation.listDays(session.id))].sort(
    (left, right) => left.dataAsOf.getTime() - right.dataAsOf.getTime(),
  );
  const completeDays = days.filter((day) => day.status === 'complete');
  const runs = new Map<string, Awaited<ReturnType<typeof ctx.repos.strategyRun.findRunById>>>();
  const resultsByDay = new Map<string, readonly StrategyResult[]>();
  for (const day of completeDays) {
    if (day.runId === undefined) continue;
    const run = await ctx.repos.strategyRun.findRunById(day.runId);
    runs.set(day.runId, run);
    if (run !== null)
      resultsByDay.set(
        day.dataAsOf.toISOString(),
        await ctx.repos.strategyRun.listResults(day.runId),
      );
  }

  const pitComplete =
    session.status === 'complete' &&
    days.length >= 2 &&
    days.every(
      (day) =>
        day.status === 'complete' && day.universeSyncId !== undefined && day.runId !== undefined,
    );
  const revisionComplete =
    pitComplete &&
    days.every(
      (day) =>
        day.vintageStatus === 'available' &&
        day.dataCheckpointId !== undefined &&
        day.revisionCutoff !== undefined,
    );
  const evaluatorComparisons = days.map((day) => {
    const run = day.runId === undefined ? null : runs.get(day.runId);
    return run === null || run === undefined
      ? ('missing' as const)
      : compareStrategyRunEvaluator(run.inputSnapshot, {
          version: STRATEGY_EVALUATOR_VERSION,
          codeIdentity: STRATEGY_EVALUATOR_CODE_HASH,
          codeIdentitySource: EVALUATOR_CODE_IDENTITY_SOURCE,
        });
  });
  const evaluatorComplete =
    revisionComplete && evaluatorComparisons.every((item) => item === 'match');

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
  const cutoffByDate = new Map(
    executionDays.flatMap((day) =>
      day.revisionCutoff === undefined
        ? []
        : ([[day.dataAsOf.toISOString(), day.revisionCutoff]] as const),
    ),
  );
  return {
    session,
    days,
    completeDays,
    executionDays,
    targets,
    targetStockIds,
    cutoffByDate,
    runs,
    resultsByDay,
    pitComplete,
    revisionComplete,
    evaluatorComplete,
    evaluatorComparisons,
  };
};

const assembleBacktest = async (
  spec: z.infer<typeof StrictBacktestSpecSchema>,
  ctx: ToolContext,
  context: BacktestContext,
  report?: BacktestMarketFactSyncReport,
): Promise<AssembledBacktest> => {
  const {
    session,
    days,
    completeDays,
    executionDays,
    targets,
    targetStockIds,
    cutoffByDate,
    runs,
    pitComplete,
    revisionComplete,
    evaluatorComplete,
    evaluatorComparisons,
  } = context;
  const maxCutoff = [...cutoffByDate.values()].sort((a, b) => b.getTime() - a.getTime())[0];
  const allMarketFacts = await ctx.repos.strategyBacktest.listMarketFacts({
    stockIds: targetStockIds,
    from: executionDays[0]?.dataAsOf ?? spec.from,
    to: executionDays.at(-1)?.dataAsOf ?? spec.to,
    ...(maxCutoff === undefined ? {} : { recordedAt: maxCutoff }),
  });
  const marketByKey = latestFactsByStockDate(allMarketFacts, cutoffByDate);
  const requiredMarketKeys = executionDays.flatMap((day) =>
    targetStockIds.map((stockId) => `${stockId}\0${day.dataAsOf.toISOString()}`),
  );
  const marketFacts = requiredMarketKeys.flatMap((key) => {
    const fact = marketByKey.get(key);
    return fact === undefined ? [] : [fact];
  });
  const tradabilityComplete = requiredMarketKeys.every((key) => marketByKey.has(key));

  const benchmarkFacts: StrictBacktestMarketFact[] = [];
  let benchmarkComplete = revisionComplete;
  for (const day of executionDays) {
    const cutoff = day.revisionCutoff;
    if (cutoff === undefined) {
      benchmarkComplete = false;
      continue;
    }
    const revisions = await ctx.repos.dailyBar.listRevisions({
      stockId: spec.benchmark.stockId,
      from: day.dataAsOf,
      to: day.dataAsOf,
      recordedAt: cutoff,
    });
    const revision = revisions.at(-1);
    if (revision === undefined) {
      benchmarkComplete = false;
      continue;
    }
    benchmarkFacts.push({
      stockId: revision.stockId,
      date: revision.date,
      rawOpen: revision.open,
      rawHigh: revision.high,
      rawLow: revision.low,
      rawClose: revision.close,
      sessionStatus: 'open',
      buyAllowed: true,
      sellAllowed: true,
      buyRestriction: 'none',
      sellRestriction: 'none',
      corporateActionsStatus: 'unavailable',
      corporateActions: [],
      source: `${revision.source}:${spec.benchmark.datasetVersion}`,
      recordedAt: revision.recordedAt,
      contentHash: revision.contentHash,
    });
  }
  if (benchmarkFacts.length !== executionDays.length) benchmarkComplete = false;

  const items = [
    gate(
      'pit-universe',
      pitComplete ? 'complete' : days.length === 0 ? 'unavailable' : 'partial',
      pitComplete
        ? 'PIT universe 与逐日运行完整'
        : 'evaluation session/day 缺少完整 PIT universe 或终态 run',
      days.flatMap((day) =>
        day.universeSyncId === undefined ? [] : [`universe:${day.universeSyncId}`],
      ),
    ),
    gate(
      'daily-bar-revisions',
      revisionComplete ? 'complete' : completeDays.length === 0 ? 'unavailable' : 'partial',
      revisionComplete
        ? '逐日 revision vintage 与 cutoff 完整'
        : '至少一个 evaluation day 的 DailyBar vintage/cutoff 不可用',
      days.flatMap((day) =>
        day.dataCheckpointId === undefined ? [] : [`checkpoint:${day.dataCheckpointId}`],
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
        ? '所有潜在持仓在全部执行日都有 PIT 可交易性事实'
        : `缺少可交易性事实${describeBacktestFactSkips(report) === null ? '' : `：${describeBacktestFactSkips(report)}`}`,
      marketFacts.map(
        (fact) => `market-fact:${fact.stockId}:${fact.date.toISOString()}:${fact.contentHash}`,
      ),
    ),
    gate(
      'corporate-actions',
      'unavailable',
      '无分红送转数据源，属 §8 不在本期范围',
      marketFacts.map((fact) => `market-fact:${fact.stockId}:${fact.date.toISOString()}`),
    ),
    gate(
      'benchmark',
      benchmarkComplete ? 'complete' : benchmarkFacts.length === 0 ? 'unavailable' : 'partial',
      benchmarkComplete
        ? '版本化 benchmark revisions 覆盖完整执行区间'
        : 'benchmark revision/cutoff 覆盖不完整',
      benchmarkFacts.map((fact) => `benchmark:${fact.date.toISOString()}:${fact.contentHash}`),
    ),
    gate(
      'evaluator-code',
      evaluatorComplete ? 'complete' : runs.size === 0 ? 'unavailable' : 'partial',
      evaluatorComplete
        ? '所有逐日运行绑定相同 evaluator version 与文件级 code identity'
        : (() => {
            const counts = new Map<string, number>();
            for (const item of evaluatorComparisons) {
              counts.set(item, (counts.get(item) ?? 0) + 1);
            }
            const labels: Record<string, string> = {
              missing: '缺 evaluator 快照',
              'not-v3': '旧版运行快照',
              'version-mismatch': 'evaluator 版本不一致',
              'legacy-identity': '旧 manifest 哈希无法验证，需重跑',
              'identity-basis-mismatch':
                '代码身份来源不同（src-files vs dist-artifact），不可跨环境比较',
              'code-identity-mismatch': 'evaluator 代码内容已变化',
            };
            return `运行与当前 evaluator 不一致：${[...counts.entries()]
              .map(([reason, count]) => `${labels[reason] ?? reason} ${count} 条`)
              .join('、')}`;
          })(),
      [...runs.values()].flatMap((run) => (run === null ? [] : [`strategy-run:${run.id}`])),
    ),
  ] satisfies StrictBacktestGateItem[];
  const audit = gateAudit(items, ctx.clock());
  const inputFingerprint = strictBacktestHash({
    specHash: strictBacktestSpecHash(spec),
    session: {
      id: session.id,
      definitionHash: session.definitionHash,
      status: session.status,
    },
    days: days.map((day: StrategyEvaluationDay) => ({
      dataAsOf: day.dataAsOf,
      runId: day.runId,
      universeSyncId: day.universeSyncId,
      dataCheckpointId: day.dataCheckpointId,
      revisionCutoff: day.revisionCutoff,
      vintageStatus: day.vintageStatus,
    })),
    targets,
    marketFacts: marketFacts.map((fact) => fact.contentHash),
    benchmarkFacts: benchmarkFacts.map((fact) => fact.contentHash),
    evaluator: CURRENT_STRATEGY_EVALUATOR_IDENTITY,
  });
  return { gateAudit: audit, inputFingerprint, targets, marketFacts, benchmarkFacts };
};

export const createStrictStrategyBacktestTool = defineTool({
  name: 'create_strict_strategy_backtest',
  description:
    '基于已完成 PIT 历史评估创建隔离的组合回测运行；门禁不全时只返回门禁审计，不输出任何收益指标',
  sideEffect: 'write',
  input: CreateStrictStrategyBacktestInput,
  output: CreateStrictStrategyBacktestOutput,
  handler: async (input, ctx: ToolContext) => {
    const session = await ctx.repos.strategyEvaluation.findSessionById(input.evaluationSessionId);
    if (session === null)
      return errNotFound('StrategyEvaluationSession', input.evaluationSessionId);
    if (session.strategyId !== input.strategyId)
      return errInvalidInput('evaluation session 不属于指定 Strategy');
    const spec = StrictBacktestSpecSchema.parse({
      schemaVersion: 1,
      strategyId: input.strategyId,
      strategyVersionId: session.strategyVersionId,
      evaluationSessionId: session.id,
      from: session.from,
      to: session.to,
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
    const context = await collectBacktestContext(spec, ctx);
    const report = await syncBacktestMarketFacts(
      { stockIds: context.targetStockIds, days: context.executionDays },
      ctx,
    );
    const assembled = await assembleBacktest(spec, ctx, context, report);
    const specHash = strictBacktestSpecHash(spec);
    const id = `strict-backtest-${strictBacktestHash({ specHash, inputFingerprint: assembled.inputFingerprint }).slice(0, 32)}`;
    const existing = await ctx.repos.strategyBacktest.findRunById(id);
    if (existing !== null) return { run: existing };
    const now = ctx.clock();
    const runnable = blockingGatesComplete(assembled.gateAudit);
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
  description: '执行已通过全部事实门禁的组合回测运行（内部执行步）；不生成 Advice、Trade 或通知',
  sideEffect: 'write',
  input: ExecuteStrictStrategyBacktestInput,
  output: ExecuteStrictStrategyBacktestOutput,
  handler: async (input, ctx: ToolContext) => {
    const existing = await ctx.repos.strategyBacktest.findRunById(input.backtestRunId);
    if (existing === null) return errNotFound('StrictStrategyBacktest', input.backtestRunId);
    if (existing.status === 'complete' || existing.status === 'failed') return { run: existing };
    if (!blockingGatesComplete(existing.gateAudit))
      return errInvalidInput('strict backtest facts gate 未完成');
    const context = await collectBacktestContext(existing.spec, ctx);
    const report = await syncBacktestMarketFacts(
      { stockIds: context.targetStockIds, days: context.executionDays },
      ctx,
    );
    const assembled = await assembleBacktest(existing.spec, ctx, context, report);
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
  description: '读取隔离的组合回测运行、逐项数据门禁和可用指标',
  sideEffect: 'read',
  input: GetStrictStrategyBacktestInput,
  output: GetStrictStrategyBacktestOutput,
  handler: async (input, ctx) => ({
    run: await ctx.repos.strategyBacktest.findRunById(input.backtestRunId),
  }),
});

export const listStrictStrategyBacktestsTool = defineTool({
  name: 'list_strict_strategy_backtests',
  description: '列出组合回测运行；与 StrategyRun operational/evaluation 事实隔离',
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
