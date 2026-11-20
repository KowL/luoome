import {
  ACTIVE_SIGNAL_OBSERVATION_HORIZONS,
  ActiveSignalObservationHorizonSchema,
  aggregateSignalObservationStats,
  deduplicateSignalObservations,
  SIGNAL_OBSERVATION_SAMPLE_UNIT,
  SignalObservationSchema,
  SignalObservationSourceKindSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

const SIGNAL_OBSERVATION_HORIZONS = ACTIVE_SIGNAL_OBSERVATION_HORIZONS;
const SIGNAL_OBSERVATION_STATS_LIMIT = 5000;

const SignalObservationStatsItemSchema = z.object({
  horizon: ActiveSignalObservationHorizonSchema,
  sampleUnit: z.literal(SIGNAL_OBSERVATION_SAMPLE_UNIT),
  total: z.number().int().nonnegative(),
  complete: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  unavailable: z.number().int().nonnegative(),
  uniqueStocks: z.number().int().nonnegative(),
  missingRate: z.number().min(0).max(1),
  observationIds: z.array(z.string().min(1)).max(SIGNAL_OBSERVATION_STATS_LIMIT),
  benchmarkStatus: z.enum(['complete', 'unavailable']),
  averageReturnPct: z.number().finite().optional(),
  medianReturnPct: z.number().finite().optional(),
  p25ReturnPct: z.number().finite().optional(),
  p75ReturnPct: z.number().finite().optional(),
  averageBenchmarkReturnPct: z.number().finite().optional(),
  averageExcessReturnPct: z.number().finite().optional(),
  averageMaxFavorableExcursionPct: z.number().finite().optional(),
  averageMaxAdverseExcursionPct: z.number().finite().optional(),
  observedAsOf: z.coerce.date().optional(),
});

export const GetSignalObservationStatsInput = z
  .object({
    /** 按 observation.baselineAt 的闭区间下界过滤。 */
    since: z.coerce.date().optional(),
    /** 按 observation.baselineAt 的闭区间上界过滤。 */
    until: z.coerce.date().optional(),
    sourceKind: SignalObservationSourceKindSchema.optional(),
    horizons: z.array(ActiveSignalObservationHorizonSchema).min(1).max(3).optional(),
    limit: z.number().int().min(1).max(SIGNAL_OBSERVATION_STATS_LIMIT).default(1000),
  })
  .superRefine((input, context) => {
    if (input.since !== undefined && input.until !== undefined && input.since > input.until) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['until'],
        message: 'until 必须不早于 since',
      });
    }
  });

export const GetSignalObservationStatsOutput = z.object({
  sampleUnit: z.literal(SIGNAL_OBSERVATION_SAMPLE_UNIT),
  window: z.object({
    since: z.coerce.date().optional(),
    until: z.coerce.date().optional(),
  }),
  sourceKind: SignalObservationSourceKindSchema.optional(),
  horizons: z.array(ActiveSignalObservationHorizonSchema),
  total: z.number().int().nonnegative(),
  complete: z.number().int().nonnegative(),
  missingRate: z.number().min(0).max(1),
  observedAsOf: z.coerce.date().optional(),
  stats: z.array(SignalObservationStatsItemSchema),
  limitations: z.array(z.string().min(1).max(300)).max(12),
});

type SignalObservationStatsItem = z.infer<typeof SignalObservationStatsItemSchema>;

const latestDate = (dates: readonly (Date | undefined)[]): Date | undefined =>
  dates.reduce<Date | undefined>(
    (latest, value) =>
      value !== undefined && (latest === undefined || value > latest) ? value : latest,
    undefined,
  );

const buildLimitations = (
  input: z.infer<typeof GetSignalObservationStatsInput>,
  total: number,
  missingRate: number,
  hasObservedAsOf: boolean,
): string[] => {
  const limitations = [
    '这是信号后续表现的描述性统计，不是回测、不是胜率承诺，也不是因果结论。',
    '样本按 stock-day-horizon 去重；pending/unavailable 不计入收益均值，但计入 missingRate。',
    `本次最多读取 ${input.limit} 条 observation；更大范围请分段查询。`,
  ];
  if (input.sourceKind === undefined) {
    limitations.push(
      '未限定 sourceKind，结果可能混合 watch-trigger、strategy-signal 与历史兼容来源。',
    );
  }
  if (total === 0) limitations.push('筛选范围内没有 SignalObservation 样本。');
  if (missingRate > 0) {
    limitations.push(
      `存在 ${(missingRate * 100).toFixed(2)}% 的非 complete 样本，结果受观察覆盖影响。`,
    );
  }
  if (!hasObservedAsOf)
    limitations.push('当前筛选范围没有 complete observation，无法提供 observedAsOf。');
  return limitations;
};

export const getSignalObservationStatsTool = defineTool({
  name: 'get_signal_observation_stats',
  description:
    '按交易日和观察周期聚合 SignalObservation 的去重描述性统计；返回样本单位、缺失率、后续表现与限制，不输出因果结论或胜率承诺',
  sideEffect: 'read',
  input: GetSignalObservationStatsInput,
  output: GetSignalObservationStatsOutput,
  handler: async (input, ctx) => {
    const observations = await ctx.repos.signalObservation.list({
      ...(input.since === undefined ? {} : { from: input.since }),
      ...(input.until === undefined ? {} : { to: input.until }),
      ...(input.sourceKind === undefined ? {} : { sourceKind: input.sourceKind }),
      horizons: input.horizons ?? SIGNAL_OBSERVATION_HORIZONS,
      limit: input.limit,
    });
    const sampled = deduplicateSignalObservations(observations);
    const aggregates = aggregateSignalObservationStats(observations);
    const stats: SignalObservationStatsItem[] = aggregates.map((aggregate) => {
      const rows = sampled.filter((observation) => observation.horizon === aggregate.horizon);
      const completeRows = rows.filter((observation) => observation.status === 'complete');
      return {
        horizon: ActiveSignalObservationHorizonSchema.parse(aggregate.horizon),
        sampleUnit: SIGNAL_OBSERVATION_SAMPLE_UNIT,
        total: aggregate.total,
        complete: aggregate.complete,
        pending: rows.filter((observation) => observation.status === 'pending').length,
        unavailable: rows.filter((observation) => observation.status === 'unavailable').length,
        uniqueStocks: aggregate.uniqueStocks,
        missingRate: aggregate.missingRate,
        observationIds: [...aggregate.observationIds],
        benchmarkStatus:
          completeRows.length > 0 &&
          completeRows.every((observation) => observation.benchmarkStatus === 'complete')
            ? 'complete'
            : 'unavailable',
        ...(aggregate.averageReturnPct === undefined
          ? {}
          : { averageReturnPct: aggregate.averageReturnPct }),
        ...(aggregate.medianReturnPct === undefined
          ? {}
          : { medianReturnPct: aggregate.medianReturnPct }),
        ...(aggregate.p25ReturnPct === undefined ? {} : { p25ReturnPct: aggregate.p25ReturnPct }),
        ...(aggregate.p75ReturnPct === undefined ? {} : { p75ReturnPct: aggregate.p75ReturnPct }),
        ...(aggregate.averageBenchmarkReturnPct === undefined
          ? {}
          : { averageBenchmarkReturnPct: aggregate.averageBenchmarkReturnPct }),
        ...(aggregate.averageExcessReturnPct === undefined
          ? {}
          : { averageExcessReturnPct: aggregate.averageExcessReturnPct }),
        ...(aggregate.averageMaxFavorableExcursionPct === undefined
          ? {}
          : { averageMaxFavorableExcursionPct: aggregate.averageMaxFavorableExcursionPct }),
        ...(aggregate.averageMaxAdverseExcursionPct === undefined
          ? {}
          : { averageMaxAdverseExcursionPct: aggregate.averageMaxAdverseExcursionPct }),
        ...(aggregate.observedAsOf === undefined ? {} : { observedAsOf: aggregate.observedAsOf }),
      };
    });
    const total = sampled.length;
    const complete = sampled.filter((observation) => observation.status === 'complete').length;
    const missingRate = total === 0 ? 0 : (total - complete) / total;
    const observedAsOf = latestDate(stats.map((item) => item.observedAsOf));
    const horizons =
      input.horizons === undefined
        ? [...SIGNAL_OBSERVATION_HORIZONS]
        : SIGNAL_OBSERVATION_HORIZONS.filter((horizon) => input.horizons?.includes(horizon));
    return {
      sampleUnit: SIGNAL_OBSERVATION_SAMPLE_UNIT,
      window: {
        ...(input.since === undefined ? {} : { since: input.since }),
        ...(input.until === undefined ? {} : { until: input.until }),
      },
      ...(input.sourceKind === undefined ? {} : { sourceKind: input.sourceKind }),
      horizons,
      total,
      complete,
      missingRate,
      ...(observedAsOf === undefined ? {} : { observedAsOf }),
      stats,
      limitations: buildLimitations(input, total, missingRate, observedAsOf !== undefined),
    };
  },
});

export const ListPendingStrategyObservationsInput = z.object({
  limit: z.number().int().min(1).max(5000).default(1000),
});
export const ListPendingStrategyObservationsOutput = z.object({
  observations: z.array(SignalObservationSchema),
  stockIds: z.array(z.string()),
});

export const listPendingStrategyObservationsTool = defineTool({
  name: 'list_pending_strategy_observations',
  description: '列出待补齐的 StrategySignal 真实表现观察',
  sideEffect: 'read',
  input: ListPendingStrategyObservationsInput,
  output: ListPendingStrategyObservationsOutput,
  handler: async (input, ctx) => {
    const observations = await ctx.repos.signalObservation.list({
      sourceKind: 'strategy-signal',
      status: 'pending',
      horizons: SIGNAL_OBSERVATION_HORIZONS,
      dueBefore: ctx.clock(),
      retryReadyAt: ctx.clock(),
      order: 'due-first',
      limit: input.limit,
    });
    return {
      observations,
      stockIds: [...new Set(observations.map((item) => item.stockId))].sort(),
    };
  },
});
