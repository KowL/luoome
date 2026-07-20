import {
  type Advice,
  type AdviceOutcome,
  type AdviceRepository,
  AdviceSubjectKindSchema,
  type Money,
  MoneySchema,
  money,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

export const GetConfidenceCalibrationInput = z.object({
  subjectKind: AdviceSubjectKindSchema.optional(),
  /** ISO 日期时间字符串；按 createdAt 过滤（闭区间下界）。 */
  since: z.coerce.date().optional(),
  /** ISO 日期时间字符串；按 createdAt 过滤（闭区间上界）。 */
  until: z.coerce.date().optional(),
});

/**
 * 单个信心度桶（10 一档，共 10 桶：0-9 / 10-19 / ... / 90-100）。
 * - `range.min/max` 闭区间（0-9 含两端；90-100 含 100）；
 * - `total` 该桶 advice 总数（含未回填）；
 * - `withOutcome` 该桶已回填 outcome 的条数（分母用这个，不用 total）；
 * - `hits` 该桶已回填且「followed 且 pnl > 0」的条数；
 * - `hitRate` = hits / withOutcome（无回填时 NaN → 输出 0）；
 * - `avgPnl` 该桶全部已回填 advice 的 pnl 平均（含 ignored/partially_followed）；
 * - `avgConfidence` 该桶全部 advice 的平均信心度（含未回填）。
 */
const CalibrationBucketSchema = z.object({
  range: z.object({ min: z.number().int().min(0).max(100), max: z.number().int().min(0).max(100) }),
  total: z.number().int().nonnegative(),
  withOutcome: z.number().int().nonnegative(),
  hits: z.number().int().nonnegative(),
  hitRate: z.number().min(0).max(1),
  avgPnl: MoneySchema,
  avgConfidence: z.number().min(0).max(100),
});

export const GetConfidenceCalibrationOutput = z.object({
  buckets: z.array(CalibrationBucketSchema),
  totalAdvices: z.number().int().nonnegative(),
  totalWithOutcome: z.number().int().nonnegative(),
  overallHitRate: z.number().min(0).max(1),
  calibratedAt: z.coerce.date(),
});

type CalibrationBucket = z.infer<typeof CalibrationBucketSchema>;

const BUCKET_EDGES: readonly number[] = [
  0,
  10,
  20,
  30,
  40,
  50,
  60,
  70,
  80,
  90,
  101, // 101 保证 100 落入最后一桶
];
const BUCKET_LABELS: ReadonlyArray<{ min: number; max: number }> = (() => {
  const labels: { min: number; max: number }[] = [];
  for (let i = 0; i < BUCKET_EDGES.length - 1; i++) {
    const min = BUCKET_EDGES[i] ?? 0;
    const max = (BUCKET_EDGES[i + 1] ?? min + 10) - 1;
    labels.push({ min, max });
  }
  return labels;
})();

const bucketIndexOf = (confidence: number): number => {
  // confidence ∈ [0, 100]；BUCKET_LABELS 第 9 项包含 90-100。
  const idx = Math.min(9, Math.floor(confidence / 10));
  return Math.max(0, idx);
};

/**
 * 与 get_advice_stats 共用：core AdviceRepository 未声明 outcome reader，
 * db 实现额外提供 getOutcome()。通过结构化类型守护做适配。
 */
interface OutcomeReader {
  getOutcome(adviceId: string): Promise<AdviceOutcome | null>;
}

const asOutcomeReader = (repo: AdviceRepository): OutcomeReader | null => {
  const candidate = repo as unknown as Partial<OutcomeReader>;
  return typeof candidate.getOutcome === 'function' ? (repo as unknown as OutcomeReader) : null;
};

const zeroMoney = (): Money => money(0);

const computeBuckets = (
  advices: readonly Advice[],
  outcomes: ReadonlyMap<string, AdviceOutcome>,
): CalibrationBucket[] => {
  const buckets: Array<{
    total: number;
    withOutcome: number;
    hits: number;
    pnlSum: number;
    confidenceSum: number;
  }> = BUCKET_LABELS.map(() => ({
    total: 0,
    withOutcome: 0,
    hits: 0,
    pnlSum: 0,
    confidenceSum: 0,
  }));

  for (const advice of advices) {
    const idx = bucketIndexOf(advice.confidence);
    const bucket = buckets[idx];
    if (bucket === undefined) continue;
    bucket.total += 1;
    bucket.confidenceSum += advice.confidence;
    const outcome = outcomes.get(advice.id);
    if (outcome === undefined) continue;
    bucket.withOutcome += 1;
    if (outcome.pnl !== undefined) bucket.pnlSum += outcome.pnl;
    if (outcome.outcome === 'followed' && outcome.pnl !== undefined && outcome.pnl > 0) {
      bucket.hits += 1;
    }
  }

  return BUCKET_LABELS.map((label, i) => {
    const agg = buckets[i] ?? { total: 0, withOutcome: 0, hits: 0, pnlSum: 0, confidenceSum: 0 };
    const avgPnl = agg.withOutcome === 0 ? zeroMoney() : ((agg.pnlSum / agg.withOutcome) as Money);
    return {
      range: label,
      total: agg.total,
      withOutcome: agg.withOutcome,
      hits: agg.hits,
      hitRate: agg.withOutcome === 0 ? 0 : agg.hits / agg.withOutcome,
      avgPnl,
      avgConfidence: agg.total === 0 ? 0 : Math.round((agg.confidenceSum / agg.total) * 100) / 100,
    };
  });
};

/**
 * 历史 advice 按 confidence 桶聚合（v0.5 W4 自校准）。
 * 直观含义：当 advice 的 confidence=80 但 hitRate 在 80-90 桶里只有 30%，
 * 说明该口径的 confidence 高估了真实可信度；事后可调 prompt 的校准系数或
 * 在 review 页 / TUI 弹层把「calibratedConfidence」建议给用户参考。
 * 默认含已过期 advice（与 get_advice_stats 复盘口径一致）；不带 outcome
 * 的 advice 计入 total 但不计入 withOutcome / hitRate。
 */
export const getConfidenceCalibrationTool = defineTool({
  name: 'get_confidence_calibration',
  description:
    '把历史 advice 按 confidence 桶（0-9 / 10-19 / ... / 90-100，每 10 一档）聚合 hitRate / avgPnl / avgConfidence；' +
    '为 agent 提供「该系统当前 confidence 校准度」的客观画像，便于 advice 输出增补 calibratedConfidence 字段。',
  sideEffect: 'read',
  input: GetConfidenceCalibrationInput,
  output: GetConfidenceCalibrationOutput,
  handler: async (input, ctx) => {
    const advices = await ctx.repos.advice.query({
      ...(input.subjectKind !== undefined ? { subjectKind: input.subjectKind } : {}),
      ...(input.since !== undefined ? { since: input.since } : {}),
      ...(input.until !== undefined ? { until: input.until } : {}),
      includeExpired: true,
    });

    const outcomes = new Map<string, AdviceOutcome>();
    const reader = asOutcomeReader(ctx.repos.advice);
    if (reader === null) {
      ctx.logger.warn(
        'get_confidence_calibration: advice repo 不支持 getOutcome，outcome 维度按空统计',
        { tool: 'get_confidence_calibration' },
      );
    } else {
      await Promise.all(
        advices.map(async (advice) => {
          const outcome = await reader.getOutcome(advice.id);
          if (outcome !== null) outcomes.set(advice.id, outcome);
        }),
      );
    }

    const buckets = computeBuckets(advices, outcomes);
    const totalAdvices = advices.length;
    const totalWithOutcome = outcomes.size;
    let overallHits = 0;
    for (const b of buckets) overallHits += b.hits;
    return {
      buckets,
      totalAdvices,
      totalWithOutcome,
      overallHitRate: totalWithOutcome === 0 ? 0 : overallHits / totalWithOutcome,
      calibratedAt: ctx.clock(),
    };
  },
});
