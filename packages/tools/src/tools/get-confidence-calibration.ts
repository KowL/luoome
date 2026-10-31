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
import { AdviceHitRateSchema, computeAdviceHitRate } from '../internal/advice-hit-rate.js';
import type { AdviceOutcomeOriginFilter } from '../internal/advice-outcome-scope.js';

export const GetConfidenceCalibrationInput = z.object({
  accountId: z.string().min(1).optional(),
  subjectKind: AdviceSubjectKindSchema.optional(),
  subjectId: z.string().min(1).optional(),
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
 * - `withOutcome` 来源过滤后的反馈数，含部分采纳、忽略与未了结，不等于命中率分母；
 * - `denominator` / `followedWithPnl` 仅含 followed 且有限 pnl 的已了结样本；
 * - `hits` 为上述样本中 pnl > 0 的条数，hitRate = hits / denominator；
 * - 桶内不足 20 条时比例与区间为 null，raw counts 保留且 sampleStatus=insufficient；
 * - `avgPnl` 保留兼容空值；不从行情反推收益，不年化；
 * - `avgConfidence` 该桶全部 advice 的平均信心度（含未回填）。
 */
const CalibrationBucketSchema = AdviceHitRateSchema.extend({
  range: z.object({ min: z.number().int().min(0).max(100), max: z.number().int().min(0).max(100) }),
  total: z.number().int().nonnegative(),
  withOutcome: z.number().int().nonnegative(),
  avgPnl: z.null(),
  avgConfidence: z.number().min(0).max(100),
});

export const GetConfidenceCalibrationOutput = AdviceHitRateSchema.extend({
  /** 输出结构版本；统计语义由独立 metricVersion 标识。 */
  schemaVersion: z.literal(2),
  buckets: z.array(CalibrationBucketSchema),
  totalAdvices: z.number().int().nonnegative(),
  totalWithOutcome: z.number().int().nonnegative(),
  overallHitRate: z.number().min(0).max(1).nullable(),
  calibratedAt: z.coerce.date(),
  groups: z.array(
    AdviceHitRateSchema.extend({
      generatorKind: AnalysisProvenanceSchema.shape.generatorKind,
      model: z.string().nullable(),
      skillVersion: z.string().nullable(),
      dataAsOf: z.coerce.date().nullable(),
      totalAdvices: z.number().int().nonnegative(),
      totalWithOutcome: z.number().int().nonnegative(),
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
  originFilter: AdviceOutcomeOriginFilter,
): CalibrationBucket[] => {
  return BUCKET_LABELS.map((label, i) => {
    const items = advices.filter((advice) => bucketIndexOf(advice.confidence) === i);
    const metric = computeAdviceHitRate(items, outcomes, originFilter, true);
    return {
      ...metric,
      range: label,
      total: items.length,
      withOutcome: metric.feedbackCount,
      avgPnl: null,
      avgConfidence:
        items.length === 0
          ? 0
          : Math.round(
              (items.reduce((sum, item) => sum + item.confidence, 0) / items.length) * 100,
            ) / 100,
    };
  });
};

/**
 * 顶层提供与 get_advice_stats 相同的描述性采样统计；不把采样比例当成未来概率。
 * 来源分组与 confidence 桶分别执行 20 样本门槛，legacy-ai 不与新来源混桶。
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
        ...(input.subjectId !== undefined ? { subjectId: input.subjectId } : {}),
        ...(input.since !== undefined ? { since: input.since } : {}),
        ...(input.until !== undefined ? { until: input.until } : {}),
        includeExpired: true,
      }),
    );

    const outcomes = await accountAdviceOutcomes(ctx, accountId);
    const metric = computeAdviceHitRate(advices, outcomes, input.originFilter);
    const buckets = computeBuckets(advices, outcomes, input.originFilter);
    const totalAdvices = advices.length;
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
      const groupedBuckets = computeBuckets(items, outcomes, input.originFilter);
      const groupedMetric = computeAdviceHitRate(items, outcomes, input.originFilter, true);
      const times = items.flatMap((advice) =>
        advice.basedOn.dataAsOf ? [advice.basedOn.dataAsOf.getTime()] : [],
      );
      return {
        ...groupedMetric,
        generatorKind: source?.generatorKind ?? ('legacy-ai' as const),
        model: source?.model ?? null,
        skillVersion: source?.skillVersion ?? null,
        dataAsOf: times.length ? new Date(Math.max(...times)) : null,
        totalAdvices: items.length,
        totalWithOutcome: groupedMetric.feedbackCount,
        overallHitRate: groupedMetric.hitRate,
        buckets: groupedBuckets,
      };
    });
    return {
      ...metric,
      groups,
      schemaVersion: 2 as const,
      buckets: groups.length > 1 ? [] : buckets,
      totalAdvices,
      totalWithOutcome: metric.feedbackCount,
      overallHitRate: metric.hitRate,
      calibratedAt: ctx.clock(),
    };
  },
});
