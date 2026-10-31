import type { Advice, AdviceOutcome } from '@luoome/core';
import { z } from 'zod';
import {
  type AdviceOutcomeOriginFilter,
  AdviceOutcomeScopeSchema,
  partitionAdviceOutcomes,
} from './advice-outcome-scope.js';

const METRIC_VERSION = 'advice-hit-rate-v3';
const MINIMUM_OUTCOMES = 20;
const WILSON_Z = 1.959963984540054;

const IntervalSchema = z.object({
  method: z.literal('wilson'),
  confidenceLevel: z.literal(0.95),
  lower: z.number().min(0).max(1),
  upper: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
});

export const AdviceHitRateSchema = AdviceOutcomeScopeSchema.extend({
  metricVersion: z.literal(METRIC_VERSION),
  feedbackCount: z.number().int().nonnegative(),
  denominator: z.number().int().nonnegative(),
  /** 兼容别名，恒等于 denominator；与 feedbackCount 不同。 */
  followedWithPnl: z.number().int().nonnegative(),
  hits: z.number().int().nonnegative(),
  hitRate: z.number().min(0).max(1).nullable(),
  minimumOutcomes: z.literal(MINIMUM_OUTCOMES),
  minimumSampleMet: z.boolean(),
  sampleStatus: z.enum(['sufficient', 'insufficient']),
  confidenceInterval: IntervalSchema.nullable(),
  minimumSampleInterval: IntervalSchema.extend({
    denominator: z.literal(MINIMUM_OUTCOMES),
    hitRate: z.literal(0.5),
  }),
  /** 互斥：先排来源，再依次分 partiallyFollowed / ignored / followed 未了结。 */
  excluded: AdviceOutcomeScopeSchema.shape.excluded.extend({
    unsettled: z.number().int().nonnegative(),
    partiallyFollowed: z.number().int().nonnegative(),
    ignored: z.number().int().nonnegative(),
  }),
  excessHitRate: z.object({
    status: // 可用性粒度:结果级（命中率比例的结论信度）。
      z.enum(['available', 'unavailable', 'insufficient']),
    value: z.number().min(0).max(1).nullable(),
    /** absolute denominator 中同时有有限同期 benchmarkPnl 的样本数。 */
    denominator: z.number().int().nonnegative(),
    eligibleDenominator: z.number().int().nonnegative(),
    hits: z.number().int().nonnegative(),
    missingBenchmark: z.number().int().nonnegative(),
    minimumSampleMet: z.boolean(),
    sampleStatus: z.enum(['sufficient', 'insufficient']),
    confidenceInterval: IntervalSchema.nullable(),
  }),
});

const wilsonInterval = (hits: number, denominator: number): z.infer<typeof IntervalSchema> => {
  const p = hits / denominator;
  const z2 = WILSON_Z ** 2;
  const scale = 1 + z2 / denominator;
  const center = (p + z2 / (2 * denominator)) / scale;
  const radius =
    (WILSON_Z * Math.sqrt((p * (1 - p) + z2 / (4 * denominator)) / denominator)) / scale;
  const lower = Math.max(0, center - radius);
  const upper = Math.min(1, center + radius);
  return { method: 'wilson', confidenceLevel: 0.95, lower, upper, width: upper - lower };
};

/** 纯反馈统计；不从行情、观察收益或 Trade 补造 pnl/基准，不年化。 */
export const computeAdviceHitRate = (
  advices: readonly Pick<Advice, 'id'>[],
  outcomes: ReadonlyMap<string, AdviceOutcome>,
  originFilter: AdviceOutcomeOriginFilter,
  grouped = false,
): z.infer<typeof AdviceHitRateSchema> => {
  const scope = partitionAdviceOutcomes(
    outcomes,
    originFilter,
    advices.map((advice) => advice.id),
  );
  const excluded = { ...scope.excluded, unsettled: 0, partiallyFollowed: 0, ignored: 0 };
  let denominator = 0;
  let hits = 0;
  let benchmarkDenominator = 0;
  let excessHits = 0;
  for (const outcome of scope.inScope.values()) {
    if (outcome.outcome === 'partially_followed') {
      excluded.partiallyFollowed += 1;
    } else if (outcome.outcome === 'ignored') {
      excluded.ignored += 1;
    } else if (outcome.pnl === undefined || !Number.isFinite(outcome.pnl)) {
      excluded.unsettled += 1;
    } else {
      // 当前反馈契约没有独立 settled 字段；只有明确 followed + finite pnl 表示已了结。
      denominator += 1;
      if (outcome.pnl > 0) hits += 1;
      if (outcome.benchmarkPnl !== undefined && Number.isFinite(outcome.benchmarkPnl)) {
        benchmarkDenominator += 1;
        if (outcome.pnl - outcome.benchmarkPnl > 0) excessHits += 1;
      }
    }
  }
  const minimumSampleMet = denominator >= MINIMUM_OUTCOMES;
  const showRate = denominator > 0 && (!grouped || minimumSampleMet);
  const missingBenchmark = denominator - benchmarkDenominator;
  const excessMinimumMet = benchmarkDenominator >= MINIMUM_OUTCOMES;
  const excessStatus =
    benchmarkDenominator === 0 || missingBenchmark > 0
      ? 'unavailable'
      : grouped && !excessMinimumMet
        ? 'insufficient'
        : 'available';
  return {
    metricVersion: METRIC_VERSION,
    feedbackCount: scope.inScope.size,
    originFilter,
    originCounts: scope.originCounts,
    excluded,
    denominator,
    followedWithPnl: denominator,
    hits,
    hitRate: showRate ? hits / denominator : null,
    minimumOutcomes: MINIMUM_OUTCOMES,
    minimumSampleMet,
    sampleStatus: minimumSampleMet ? 'sufficient' : 'insufficient',
    confidenceInterval: showRate ? wilsonInterval(hits, denominator) : null,
    minimumSampleInterval: { denominator: 20, hitRate: 0.5, ...wilsonInterval(10, 20) },
    excessHitRate: {
      status: excessStatus,
      value: excessStatus === 'available' ? excessHits / benchmarkDenominator : null,
      denominator: benchmarkDenominator,
      eligibleDenominator: denominator,
      hits: excessHits,
      missingBenchmark,
      minimumSampleMet: excessMinimumMet,
      sampleStatus: excessMinimumMet ? 'sufficient' : 'insufficient',
      confidenceInterval:
        excessStatus === 'available' ? wilsonInterval(excessHits, benchmarkDenominator) : null,
    },
  };
};
