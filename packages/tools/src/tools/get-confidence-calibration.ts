import {
  type Advice,
  type AdviceOutcome,
  AdviceSubjectKindSchema,
  AnalysisProvenanceSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';
import {
  accountAdviceOutcomes,
  accountScopedAdvices,
} from '../internal/account-advice-outcomes.js';
import { partitionAdviceOutcomes } from '../internal/advice-outcome-scope.js';

export const GetConfidenceCalibrationInput = z.object({
  accountId: z.string().min(1).optional(),
  subjectKind: AdviceSubjectKindSchema.optional(),
  /** ISO 日期时间字符串；按 createdAt 过滤（闭区间下界）。 */
  since: z.coerce.date().optional(),
  /** ISO 日期时间字符串；按 createdAt 过滤（闭区间上界）。 */
  until: z.coerce.date().optional(),
  /**
   * 回填来源口径（REQ-M3-18 §3）：默认 `user`。校准的是「模型信心 vs 用户回填的兑现」，
   * 把模型自己写的 outcome 算进去等于用模型解释模型。
   */
  originFilter: z.enum(['user', 'all']).default('user'),
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
  followedWithPnl: z.number().int().nonnegative(),
  hitRate: z.number().min(0).max(1).nullable(),
  avgPnl: z.null(),
  avgConfidence: z.number().min(0).max(100),
});

export const GetConfidenceCalibrationOutput = z.object({
  schemaVersion: z.literal(2),
  buckets: z.array(CalibrationBucketSchema),
  totalAdvices: z.number().int().nonnegative(),
  totalWithOutcome: z.number().int().nonnegative(),
  overallHitRate: z.number().min(0).max(1).nullable(),
  followedWithPnl: z.number().int().nonnegative(),
  calibratedAt: z.coerce.date(),
  /** 本次校准采用的来源口径（默认 user）。 */
  originFilter: z.enum(['user', 'all']),
  /** 窗口内回填记录按来源计数。 */
  originCounts: z.object({
    user: z.number().int().nonnegative(),
    model: z.number().int().nonnegative(),
    import: z.number().int().nonnegative(),
    unattested: z.number().int().nonnegative(),
  }),
  /** 被本次口径排除的条数；`originFilter='all'` 时两者都是 0。 */
  excluded: z.object({
    nonUserOrigin: z.number().int().nonnegative(),
    unattested: z.number().int().nonnegative(),
  }),
  groups: z.array(
    z.object({
      generatorKind: AnalysisProvenanceSchema.shape.generatorKind,
      model: z.string().nullable(),
      skillVersion: z.string().nullable(),
      dataAsOf: z.coerce.date().nullable(),
      totalAdvices: z.number().int().nonnegative(),
      totalWithOutcome: z.number().int().nonnegative(),
      followedWithPnl: z.number().int().nonnegative(),
      minimumOutcomes: z.literal(20),
      overallHitRate: z.number().min(0).max(1).nullable(),
      buckets: z.array(CalibrationBucketSchema),
    }),
  ),
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

const computeBuckets = (
  advices: readonly Advice[],
  outcomes: ReadonlyMap<string, AdviceOutcome>,
): CalibrationBucket[] => {
  const buckets: Array<{
    total: number;
    withOutcome: number;
    hits: number;
    followedWithPnl: number;
    confidenceSum: number;
  }> = BUCKET_LABELS.map(() => ({
    total: 0,
    withOutcome: 0,
    hits: 0,
    followedWithPnl: 0,
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
    if (outcome.outcome === 'followed' && outcome.pnl !== undefined) {
      bucket.followedWithPnl += 1;
      if (outcome.pnl > 0) bucket.hits += 1;
    }
  }

  return BUCKET_LABELS.map((label, i) => {
    const agg = buckets[i] ?? {
      total: 0,
      withOutcome: 0,
      hits: 0,
      followedWithPnl: 0,
      confidenceSum: 0,
    };
    return {
      range: label,
      total: agg.total,
      withOutcome: agg.withOutcome,
      hits: agg.hits,
      followedWithPnl: agg.followedWithPnl,
      hitRate: agg.followedWithPnl === 0 ? null : agg.hits / agg.followedWithPnl,
      avgPnl: null,
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
    '按生成方式、模型与技能版本分别校准历史建议；legacy-ai 不与新来源混桶。' +
    'groups 提供数据时点与信心桶；少于 20 条已跟随且填报盈亏的样本不提供分组比例结论。' +
    '默认只统计用户亲自回填（origin=user）的 outcome，其它来源需显式 originFilter=all。',
  sideEffect: 'read',
  input: GetConfidenceCalibrationInput,
  output: GetConfidenceCalibrationOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    if (!accountId || (await ctx.repos.account.findById(accountId)) === null)
      return errNotFound('Account', accountId);
    const advices = await accountScopedAdvices(
      ctx,
      accountId,
      await ctx.repos.advice.query({
        ...(input.subjectKind !== undefined ? { subjectKind: input.subjectKind } : {}),
        ...(input.since !== undefined ? { since: input.since } : {}),
        ...(input.until !== undefined ? { until: input.until } : {}),
        includeExpired: true,
      }),
    );

    const outcomes = await accountAdviceOutcomes(ctx, accountId);
    const { inScope, originCounts, excluded } = partitionAdviceOutcomes(
      outcomes,
      input.originFilter,
    );

    const buckets = computeBuckets(advices, inScope);
    const totalAdvices = advices.length;
    const totalWithOutcome = advices.filter((advice) => inScope.has(advice.id)).length;
    const followedWithPnl = buckets.reduce((sum, bucket) => sum + bucket.followedWithPnl, 0);
    let overallHits = 0;
    for (const b of buckets) overallHits += b.hits;
    const sourceGroups = new Map<string, Advice[]>();
    for (const advice of advices) {
      const key = JSON.stringify([
        advice.provenance?.generatorKind ?? 'legacy-ai',
        advice.provenance?.model ?? null,
        advice.provenance?.skillVersion ?? null,
      ]);
      const group = sourceGroups.get(key) ?? [];
      group.push(advice);
      sourceGroups.set(key, group);
    }
    const groups = [...sourceGroups.values()].map((items) => {
      const first = items[0];
      const source = first?.provenance;
      const groupedBuckets = computeBuckets(items, inScope);
      const samples = groupedBuckets.reduce((sum, bucket) => sum + bucket.followedWithPnl, 0);
      const hits = groupedBuckets.reduce((sum, bucket) => sum + bucket.hits, 0);
      const times = items.flatMap((advice) =>
        advice.basedOn.dataAsOf ? [advice.basedOn.dataAsOf.getTime()] : [],
      );
      return {
        generatorKind: source?.generatorKind ?? ('legacy-ai' as const),
        model: source?.model ?? null,
        skillVersion: source?.skillVersion ?? null,
        dataAsOf: times.length ? new Date(Math.max(...times)) : null,
        totalAdvices: items.length,
        totalWithOutcome: items.filter((advice) => inScope.has(advice.id)).length,
        followedWithPnl: samples,
        minimumOutcomes: 20 as const,
        overallHitRate: samples >= 20 ? hits / samples : null,
        buckets: groupedBuckets.map((bucket) => ({
          ...bucket,
          hitRate: bucket.followedWithPnl >= 20 ? bucket.hitRate : null,
        })),
      };
    });
    return {
      groups,
      schemaVersion: 2 as const,
      buckets: groups.length > 1 ? [] : buckets,
      totalAdvices,
      totalWithOutcome,
      overallHitRate:
        groups.length > 1 || followedWithPnl === 0 ? null : overallHits / followedWithPnl,
      followedWithPnl,
      originFilter: input.originFilter,
      originCounts,
      excluded,
      calibratedAt: ctx.clock(),
    };
  },
});
