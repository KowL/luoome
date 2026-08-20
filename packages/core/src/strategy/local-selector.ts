import { z } from 'zod';

import type { DailyBar } from '../entity/quote.js';

export const LocalSelectorMetricSchema = z.enum([
  'momentum-20',
  'ma-distance-20',
  'volatility-20',
  'average-volume-20',
]);
export type LocalSelectorMetric = z.infer<typeof LocalSelectorMetricSchema>;

export const LocalSelectorParametersV1Schema = z
  .object({
    parameterVersion: z.literal('local-selector-v1'),
    minimumBars: z.number().int().min(21).max(250).default(60),
    minimumCoverageRatio: z.number().min(0.5).max(1).default(0.98),
    top: z.number().int().min(1).max(200).default(30),
    factors: z
      .array(
        z.object({
          metric: LocalSelectorMetricSchema,
          direction: z.enum(['higher', 'lower']),
          weight: z.number().positive().max(1),
        }),
      )
      .min(1)
      .max(4),
  })
  .superRefine((parameters, ctx) => {
    const metrics = parameters.factors.map((factor) => factor.metric);
    if (new Set(metrics).size !== metrics.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['factors'],
        message: 'local selector factor metric 必须唯一',
      });
    }
    const totalWeight = parameters.factors.reduce((sum, factor) => sum + factor.weight, 0);
    if (Math.abs(totalWeight - 1) > 1e-9) {
      ctx.addIssue({
        code: 'custom',
        path: ['factors'],
        message: 'local selector factor 权重之和必须等于 1',
      });
    }
  });
export type LocalSelectorParametersV1 = z.infer<typeof LocalSelectorParametersV1Schema>;

export const DEFAULT_LOCAL_SELECTOR_PARAMETERS: LocalSelectorParametersV1 =
  LocalSelectorParametersV1Schema.parse({
    parameterVersion: 'local-selector-v1',
    minimumBars: 60,
    minimumCoverageRatio: 0.98,
    top: 30,
    factors: [
      { metric: 'momentum-20', direction: 'higher', weight: 0.35 },
      { metric: 'ma-distance-20', direction: 'higher', weight: 0.25 },
      { metric: 'volatility-20', direction: 'lower', weight: 0.2 },
      { metric: 'average-volume-20', direction: 'higher', weight: 0.2 },
    ],
  });

export const LocalSelectorFactorResultSchema = z.object({
  metric: LocalSelectorMetricSchema,
  direction: z.enum(['higher', 'lower']),
  rawValue: z.number().finite(),
  percentile: z.number().min(0).max(100),
  weight: z.number().positive().max(1),
  contribution: z.number().min(0).max(100),
});
export type LocalSelectorFactorResult = z.infer<typeof LocalSelectorFactorResultSchema>;

export const LocalSelectorCandidateSchema = z.object({
  stockId: z.string().min(1),
  rank: z.number().int().positive(),
  score: z.number().min(0).max(100),
  selected: z.boolean(),
  factors: z.array(LocalSelectorFactorResultSchema).min(1),
  evidence: z.array(z.string().min(1)).min(1),
  counterEvidence: z.array(z.string().min(1)),
  dataAsOf: z.coerce.date(),
});
export type LocalSelectorCandidate = z.infer<typeof LocalSelectorCandidateSchema>;

export const LocalSelectorUnavailableSchema = z.object({
  stockId: z.string().min(1),
  reason: z.enum(['no-bars', 'insufficient-bars', 'invalid-bars']),
  availableBars: z.number().int().nonnegative(),
  requiredBars: z.number().int().positive(),
});
export type LocalSelectorUnavailable = z.infer<typeof LocalSelectorUnavailableSchema>;

export interface RunLocalSelectorInput {
  readonly stockIds: readonly string[];
  readonly barsByStock: ReadonlyMap<string, readonly DailyBar[]>;
  readonly parameters: LocalSelectorParametersV1;
}

export interface RunLocalSelectorResult {
  readonly evaluatedCount: number;
  readonly coverageRatio: number;
  readonly candidates: readonly LocalSelectorCandidate[];
  readonly unavailable: readonly LocalSelectorUnavailable[];
}

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

const metricValue = (metric: LocalSelectorMetric, bars: readonly DailyBar[]): number => {
  const latest = bars.at(-1) as DailyBar;
  const last20 = bars.slice(-20);
  switch (metric) {
    case 'momentum-20': {
      const baseline = bars.at(-21) as DailyBar;
      return ((latest.close - baseline.close) / baseline.close) * 100;
    }
    case 'ma-distance-20': {
      const average = mean(last20.map((bar) => bar.close));
      return ((latest.close - average) / average) * 100;
    }
    case 'volatility-20': {
      const returns = bars
        .slice(-21)
        .slice(1)
        .map((bar, index) => {
          const previous = bars.slice(-21)[index] as DailyBar;
          return (bar.close - previous.close) / previous.close;
        });
      const average = mean(returns);
      return Math.sqrt(mean(returns.map((value) => (value - average) ** 2))) * 100;
    }
    case 'average-volume-20':
      return mean(last20.map((bar) => bar.volume));
  }
};

const percentileByStock = (
  values: ReadonlyMap<string, number>,
  direction: 'higher' | 'lower',
): ReadonlyMap<string, number> => {
  const sorted = [...values.entries()].sort(
    ([leftId, left], [rightId, right]) => left - right || leftId.localeCompare(rightId),
  );
  const percentiles = new Map<string, number>();
  let cursor = 0;
  while (cursor < sorted.length) {
    const value = sorted[cursor]?.[1];
    let end = cursor + 1;
    while (end < sorted.length && sorted[end]?.[1] === value) end += 1;
    const averageIndex = (cursor + end - 1) / 2;
    const ascending = sorted.length === 1 ? 50 : (averageIndex / (sorted.length - 1)) * 100;
    const percentile = direction === 'higher' ? ascending : 100 - ascending;
    for (let index = cursor; index < end; index += 1) {
      const stockId = sorted[index]?.[0];
      if (stockId !== undefined) percentiles.set(stockId, percentile);
    }
    cursor = end;
  }
  return percentiles;
};

const validBars = (bars: readonly DailyBar[]): boolean =>
  bars.every(
    (bar, index) =>
      bar.adjustment === 'qfq' &&
      bar.close > 0 &&
      bar.volume >= 0 &&
      (index === 0 || (bars[index - 1] as DailyBar).date < bar.date),
  );

export const runLocalSelector = (input: RunLocalSelectorInput): RunLocalSelectorResult => {
  const parameters = LocalSelectorParametersV1Schema.parse(input.parameters);
  const stockIds = [...new Set(input.stockIds)].sort();
  const unavailable: LocalSelectorUnavailable[] = [];
  const rawByStock = new Map<string, Map<LocalSelectorMetric, number>>();
  const dataAsOfByStock = new Map<string, Date>();

  for (const stockId of stockIds) {
    const bars = [...(input.barsByStock.get(stockId) ?? [])].sort(
      (left, right) => left.date.getTime() - right.date.getTime(),
    );
    if (bars.length === 0) {
      unavailable.push({
        stockId,
        reason: 'no-bars',
        availableBars: 0,
        requiredBars: parameters.minimumBars,
      });
      continue;
    }
    if (bars.length < parameters.minimumBars) {
      unavailable.push({
        stockId,
        reason: 'insufficient-bars',
        availableBars: bars.length,
        requiredBars: parameters.minimumBars,
      });
      continue;
    }
    const window = bars.slice(-parameters.minimumBars);
    if (!validBars(window)) {
      unavailable.push({
        stockId,
        reason: 'invalid-bars',
        availableBars: window.length,
        requiredBars: parameters.minimumBars,
      });
      continue;
    }
    const metrics = new Map<LocalSelectorMetric, number>();
    for (const factor of parameters.factors)
      metrics.set(factor.metric, metricValue(factor.metric, window));
    if ([...metrics.values()].some((value) => !Number.isFinite(value))) {
      unavailable.push({
        stockId,
        reason: 'invalid-bars',
        availableBars: window.length,
        requiredBars: parameters.minimumBars,
      });
      continue;
    }
    rawByStock.set(stockId, metrics);
    dataAsOfByStock.set(stockId, (window.at(-1) as DailyBar).date);
  }

  const percentiles = new Map<LocalSelectorMetric, ReadonlyMap<string, number>>();
  for (const factor of parameters.factors) {
    percentiles.set(
      factor.metric,
      percentileByStock(
        new Map(
          [...rawByStock].map(([stockId, metrics]) => [
            stockId,
            metrics.get(factor.metric) as number,
          ]),
        ),
        factor.direction,
      ),
    );
  }

  const ranked = [...rawByStock].map(([stockId, metrics]) => {
    const factors = parameters.factors.map((factor) => {
      const percentile = percentiles.get(factor.metric)?.get(stockId) as number;
      return LocalSelectorFactorResultSchema.parse({
        ...factor,
        rawValue: metrics.get(factor.metric),
        percentile,
        contribution: percentile * factor.weight,
      });
    });
    const score = factors.reduce((sum, factor) => sum + factor.contribution, 0);
    const counterEvidence = factors
      .filter((factor) => factor.percentile < 25)
      .map(
        (factor) =>
          `${factor.metric} 横截面分位 ${factor.percentile.toFixed(2)}，对当前排序构成反证`,
      );
    return {
      stockId,
      score,
      factors,
      evidence: factors.map(
        (factor) =>
          `${factor.metric} 原始值 ${factor.rawValue.toFixed(4)}，横截面分位 ${factor.percentile.toFixed(2)}`,
      ),
      counterEvidence,
      dataAsOf: dataAsOfByStock.get(stockId) as Date,
    };
  });
  ranked.sort(
    (left, right) => right.score - left.score || left.stockId.localeCompare(right.stockId),
  );
  const candidates = ranked.map((candidate, index) =>
    LocalSelectorCandidateSchema.parse({
      ...candidate,
      rank: index + 1,
      selected: index < parameters.top,
    }),
  );
  return {
    evaluatedCount: candidates.length,
    coverageRatio: stockIds.length === 0 ? 0 : candidates.length / stockIds.length,
    candidates,
    unavailable,
  };
};
