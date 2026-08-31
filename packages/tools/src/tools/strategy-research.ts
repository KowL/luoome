import { createHash } from 'node:crypto';
import {
  ActiveSignalObservationHorizonSchema,
  AdaptivePersonalityAssessmentSchema,
  AdaptivePersonalityPolicySchema,
  assessAdaptivePersonality,
  type DailyBar,
  DailyBarSchema,
  DEFAULT_LOCAL_SELECTOR_PARAMETERS,
  isHoliday,
  isWeekend,
  LocalSelectorCandidateSchema,
  LocalSelectorParametersV1Schema,
  LocalSelectorUnavailableSchema,
  runLocalSelector,
  type SignalObservation,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

const DAY_MS = 86_400_000;
const OBSERVATION_QUERY_CHUNK = 400;

const shanghaiDayEnd = (date: string): Date => new Date(`${date}T15:59:59.999Z`);

export const RunLocalSelectorResearchInput = z.object({
  marketDate: z.string().date(),
  revisionCutoff: z.coerce.date(),
  stockIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  parameters: LocalSelectorParametersV1Schema.default(DEFAULT_LOCAL_SELECTOR_PARAMETERS),
});
export const RunLocalSelectorResearchOutput = z.object({
  status: z.enum(['complete', 'partial', 'unavailable']),
  parameters: LocalSelectorParametersV1Schema,
  snapshot: z.object({
    marketDate: z.string().date(),
    revisionCutoff: z.coerce.date(),
    universeSyncId: z.string().min(1),
    universeObservedAt: z.coerce.date(),
    memberChecksum: z.string().regex(/^[a-f0-9]{64}$/),
    requestedCount: z.number().int().nonnegative(),
    evaluatedCount: z.number().int().nonnegative(),
    coverageRatio: z.number().min(0).max(1),
    dataAsOf: z.coerce.date().optional(),
  }),
  candidates: z.array(
    LocalSelectorCandidateSchema.extend({
      stockName: z.string().min(1),
      nameStatus: z.enum(['resolved', 'unavailable']),
    }),
  ),
  unavailableCount: z.number().int().nonnegative(),
  unavailableSamples: z.array(LocalSelectorUnavailableSchema).max(100),
  warnings: z.array(z.string().min(1)),
  limitations: z.array(z.string().min(1)),
});

const latestPITBars = (
  revisions: Awaited<ReturnType<ToolContext['repos']['dailyBar']['listRevisionsForStocks']>>,
): ReadonlyMap<string, readonly DailyBar[]> => {
  const latest = new Map<string, (typeof revisions)[number]>();
  for (const revision of revisions) {
    const key = `${revision.stockId}\0${revision.date.toISOString()}`;
    const previous = latest.get(key);
    if (
      previous === undefined ||
      revision.recordedAt > previous.recordedAt ||
      (revision.recordedAt.getTime() === previous.recordedAt.getTime() &&
        revision.contentHash.localeCompare(previous.contentHash) > 0)
    ) {
      latest.set(key, revision);
    }
  }
  const barsByStock = new Map<string, DailyBar[]>();
  for (const revision of latest.values()) {
    const bar = DailyBarSchema.parse({
      stockId: revision.stockId,
      date: revision.date,
      open: revision.open,
      high: revision.high,
      low: revision.low,
      close: revision.close,
      volume: revision.volume,
      adjustment: 'qfq',
      source: revision.source,
    });
    barsByStock.set(bar.stockId, [...(barsByStock.get(bar.stockId) ?? []), bar]);
  }
  for (const bars of barsByStock.values()) {
    bars.sort((left, right) => left.date.getTime() - right.date.getTime());
  }
  return barsByStock;
};

export const runLocalSelectorResearchTool = defineTool({
  name: 'run_local_selector_research',
  description:
    '使用 PIT StockUniverse 与批量 qfq DailyBar revision 做确定性横截面排序；score 仅用于研究排序，不是收益概率或 Advice',
  sideEffect: 'read',
  input: RunLocalSelectorResearchInput,
  output: RunLocalSelectorResearchOutput,
  handler: async (input, ctx) => {
    const marketDateEnd = shanghaiDayEnd(input.marketDate);
    if (isWeekend(marketDateEnd) || isHoliday(marketDateEnd)) {
      return errInvalidInput('marketDate 必须是 A 股交易日');
    }
    if (input.revisionCutoff < marketDateEnd) {
      return errInvalidInput('revisionCutoff 不能早于 marketDate 的上海收盘日终');
    }
    const universe = await ctx.repos.stockUniverse.latestSnapshotAtOrBefore({
      coverage: 'CN_A_SHARES_SH_SZ',
      asOf: marketDateEnd,
    });
    if (universe === null || universe.observedAt === null) {
      return errNotFound('StockUniverseSnapshot', input.marketDate);
    }
    const members = await ctx.repos.stockUniverse.listSnapshotMembers(universe.id);
    const memberById = new Map(members.map((stock) => [stock.id, stock] as const));
    const requested = [...new Set(input.stockIds ?? members.map((stock) => stock.id))].sort();
    const unknown = requested.filter((stockId) => !memberById.has(stockId));
    if (unknown.length > 0) {
      return errInvalidInput(`stockIds 不属于该 PIT StockUniverse: ${unknown.join(', ')}`);
    }
    const from = new Date(marketDateEnd.getTime() - input.parameters.minimumBars * 3 * DAY_MS);
    const revisions = await ctx.repos.dailyBar.listRevisionsForStocks({
      stockIds: requested,
      from,
      to: marketDateEnd,
      recordedAt: input.revisionCutoff,
    });
    const selected = runLocalSelector({
      stockIds: requested,
      barsByStock: latestPITBars(revisions),
      parameters: input.parameters,
    });
    const status =
      selected.evaluatedCount === 0
        ? ('unavailable' as const)
        : selected.coverageRatio >= input.parameters.minimumCoverageRatio
          ? ('complete' as const)
          : ('partial' as const);
    const chosen = selected.candidates
      .filter((candidate) => candidate.selected)
      .map((candidate) => {
        const stock = memberById.get(candidate.stockId);
        return {
          ...candidate,
          stockName: stock?.name ?? '名称暂缺',
          nameStatus: stock?.name === undefined ? ('unavailable' as const) : ('resolved' as const),
        };
      });
    const dataAsOf = chosen
      .map((candidate) => candidate.dataAsOf)
      .sort((left, right) => left.getTime() - right.getTime())[0];
    return {
      status,
      parameters: input.parameters,
      snapshot: {
        marketDate: input.marketDate,
        revisionCutoff: input.revisionCutoff,
        universeSyncId: universe.id,
        universeObservedAt: universe.observedAt,
        memberChecksum: createHash('sha256').update(JSON.stringify(requested)).digest('hex'),
        requestedCount: requested.length,
        evaluatedCount: selected.evaluatedCount,
        coverageRatio: selected.coverageRatio,
        ...(dataAsOf === undefined ? {} : { dataAsOf }),
      },
      candidates: chosen,
      unavailableCount: selected.unavailable.length,
      unavailableSamples: selected.unavailable.slice(0, 100),
      warnings: [
        ...(status === 'partial'
          ? [
              `PIT 日线覆盖率 ${selected.coverageRatio.toFixed(4)} 低于参数门槛 ${input.parameters.minimumCoverageRatio.toFixed(4)}`,
            ]
          : []),
        ...(status === 'unavailable' ? ['PIT 日线不足，未产生横截面排序结论'] : []),
      ],
      limitations: [
        '横截面 score 只表示同一 PIT 批次内的相对排序，不是胜率、收益概率或 Advice confidence。',
        '结果不会自动创建 StrategyVersion、Watchlist 来源、Advice 或交易。',
      ],
    };
  },
});

export const AssessAdaptivePersonalityInput = z.object({
  parameterVersionId: z.string().min(1),
  trainingSessionId: z.string().min(1),
  validationSessionId: z.string().min(1),
  observationHorizon: ActiveSignalObservationHorizonSchema.default('t5'),
  policy: AdaptivePersonalityPolicySchema.default({
    policyVersion: 'adaptive-personality-gate-v1',
    minTrainingTradingDays: 60,
    minValidationTradingDays: 20,
    minValidationObservations: 30,
    minVintageCoverageRatio: 1,
    minBenchmarkCoverageRatio: 0.9,
  }),
});
export const AssessAdaptivePersonalityOutput = z.object({
  assessment: AdaptivePersonalityAssessmentSchema,
});

export const assessAdaptivePersonalityTool = defineTool({
  name: 'assess_adaptive_personality',
  description:
    '检查参数版本、训练/验证隔离、PIT vintage 与真实观察门禁；证据不足返回 unavailable 且不输出自适应结论',
  sideEffect: 'read',
  input: AssessAdaptivePersonalityInput,
  output: AssessAdaptivePersonalityOutput,
  handler: async (input, ctx) => {
    const [version, training, validation] = await Promise.all([
      ctx.repos.strategy.findVersionById(input.parameterVersionId),
      ctx.repos.strategyEvaluation.findSessionById(input.trainingSessionId),
      ctx.repos.strategyEvaluation.findSessionById(input.validationSessionId),
    ]);
    if (version === null) return errNotFound('StrategyVersion', input.parameterVersionId);
    if (training === null) return errNotFound('StrategyEvaluationSession', input.trainingSessionId);
    if (validation === null)
      return errNotFound('StrategyEvaluationSession', input.validationSessionId);
    const [trainingDays, validationDays, validationRuns] = await Promise.all([
      ctx.repos.strategyEvaluation.listDays(training.id),
      ctx.repos.strategyEvaluation.listDays(validation.id),
      ctx.repos.strategyRun.listRuns({
        strategyId: validation.strategyId,
        scope: 'evaluation',
        limit: 5000,
      }),
    ]);
    const runIds = new Set(
      validationDays.flatMap((day) => (day.runId === undefined ? [] : [day.runId])),
    );
    const runs = validationRuns.filter((run) => runIds.has(run.id));
    const signals = (
      await Promise.all(runs.map((run) => ctx.repos.strategyRun.signalsByRun(run.id)))
    ).flat();
    const observations: SignalObservation[] = [];
    for (let index = 0; index < signals.length; index += OBSERVATION_QUERY_CHUNK) {
      observations.push(
        ...(await ctx.repos.signalObservation.list({
          sourceKind: 'strategy-signal',
          sourceIds: signals
            .slice(index, index + OBSERVATION_QUERY_CHUNK)
            .map((signal) => signal.id),
          horizons: [input.observationHorizon],
          limit: 5000,
        })),
      );
    }
    const completeObservations = observations.filter(
      (observation) => observation.status === 'complete',
    );
    const assessment = assessAdaptivePersonality({
      parameterVersion: {
        strategyId: version.strategyId,
        strategyVersionId: version.id,
        definitionHash: version.definitionHash,
        factReferences: version.factReferences ?? [],
      },
      training: {
        sessionId: training.id,
        strategyId: training.strategyId,
        status: training.status,
        from: training.from,
        to: training.to,
        tradingDays: trainingDays.length,
        vintageAvailableDays: trainingDays.filter(
          (day) => day.vintageStatus === 'available' && day.status === 'complete',
        ).length,
      },
      validation: {
        sessionId: validation.id,
        strategyId: validation.strategyId,
        strategyVersionId: validation.strategyVersionId,
        status: validation.status,
        from: validation.from,
        to: validation.to,
        tradingDays: validationDays.length,
        vintageAvailableDays: validationDays.filter(
          (day) => day.vintageStatus === 'available' && day.status === 'complete',
        ).length,
        observationCount: completeObservations.length,
        benchmarkAvailableCount: completeObservations.filter(
          (observation) => observation.benchmarkStatus === 'complete',
        ).length,
      },
      policy: input.policy,
    });
    return { assessment };
  },
});
