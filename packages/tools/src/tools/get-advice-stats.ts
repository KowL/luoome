import {
  type Advice,
  type AdviceDecision,
  AdviceDecisionSchema,
  type AdviceOutcome,
  AdviceSubjectKindSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';
import {
  accountAdviceOutcomes,
  accountScopedAdvices,
} from '../internal/account-advice-outcomes.js';
import { AdviceHitRateSchema, computeAdviceHitRate } from '../internal/advice-hit-rate.js';
import type { AdviceOutcomeOriginFilter } from '../internal/advice-outcome-scope.js';

export const GetAdviceStatsInput = z.object({
  accountId: z.string().min(1).optional(),
  subjectKind: AdviceSubjectKindSchema.optional(),
  subjectId: z.string().min(1).optional(),
  /** ISO 日期时间字符串；按 createdAt 过滤（闭区间下界）。 */
  since: z.coerce.date().optional(),
  /** ISO 日期时间字符串；按 createdAt 过滤（闭区间上界）。 */
  until: z.coerce.date().optional(),
  /**
   * 回填来源口径（REQ-M3-18 §3）：默认 `user` 只统计用户亲自回填的 outcome；
   * `all` 才把 model / import / 无法追溯的历史回填纳入，并在 `excluded` 披露数量。
   */
  originFilter: z.enum(['user', 'all']).default('user'),
});

/**
 * 单层决策统计（叶子不再嵌套）。
 * byDecision 只展开一层：每层自带 totalAdvices、命中率分母与 excluded 分类，
 * 足够做决策之间的横向对比；继续递归既没有消费方，也会让输出体积随决策数
 * 指数增长，因此这里刻意拍平而不是复用嵌套结构。
 */
const flatStatsSchema = AdviceHitRateSchema.extend({
  /** 输出结构版本；统计语义由独立 metricVersion 标识。 */
  schemaVersion: z.literal(2),
  totalAdvices: z.number().int().nonnegative(),
  avgConfidence: z.number().min(0).max(100),
  feedbackCount: z.number().int().nonnegative(),
  outcomeRate: z.object({
    followed: z.number().min(0).max(1).nullable(),
    partiallyFollowed: z.number().min(0).max(1).nullable(),
    ignored: z.number().min(0).max(1).nullable(),
  }),
  pnlWhenFollowed: z.null(),
  pnlWhenIgnored: z.null(),
});

export const GetAdviceStatsOutput = flatStatsSchema.extend({
  byDecision: z.record(AdviceDecisionSchema, flatStatsSchema),
});

type FlatStats = z.infer<typeof flatStatsSchema>;

const computeFlatStats = (
  advices: readonly Advice[],
  outcomes: ReadonlyMap<string, AdviceOutcome>,
  originFilter: AdviceOutcomeOriginFilter,
  grouped = false,
): FlatStats => {
  const totalAdvices = advices.length;
  const avgConfidence =
    totalAdvices === 0
      ? 0
      : Math.round((advices.reduce((sum, a) => sum + a.confidence, 0) / totalAdvices) * 100) / 100;

  const metric = computeAdviceHitRate(advices, outcomes, originFilter, grouped);
  const followed = metric.denominator + metric.excluded.unsettled;
  const { partiallyFollowed, ignored } = metric.excluded;
  // 20 条门槛同样约束采纳分布比例，不只是命中率：n=3 的 66.7% 与 n=3 的
  // 命中率一样误导。分组不足门槛时比例置 null，但 raw counts 与
  // sampleStatus=insufficient 仍保留，调用方仍能读到原始分布。
  const rate = (n: number): number | null =>
    totalAdvices === 0 || (grouped && !metric.minimumSampleMet) ? null : n / totalAdvices;

  return {
    ...metric,
    schemaVersion: 2,
    totalAdvices,
    avgConfidence,
    // 口径内回填条数直接取分区结果，不再由 excluded 分类二次相加推导。
    feedbackCount: metric.feedbackCount,
    outcomeRate: {
      followed: rate(followed),
      partiallyFollowed: rate(partiallyFollowed),
      ignored: rate(ignored),
    },
    pnlWhenFollowed: null,
    pnlWhenIgnored: null,
  };
};

const byDecisionOf = (
  advices: readonly Advice[],
  outcomes: ReadonlyMap<string, AdviceOutcome>,
  originFilter: AdviceOutcomeOriginFilter,
): Record<AdviceDecision, FlatStats> => {
  const forDecision = (decision: AdviceDecision): FlatStats =>
    computeFlatStats(
      advices.filter((a) => a.decision === decision),
      outcomes,
      originFilter,
      true,
    );
  return {
    buy: forDecision('buy'),
    sell: forDecision('sell'),
    hold: forDecision('hold'),
    watch: forDecision('watch'),
    avoid: forDecision('avoid'),
  };
};

export const getAdviceStatsTool = defineTool({
  name: 'get_advice_stats',
  description:
    '聚合建议准确率统计（总条数 / 平均信心度 / outcome 比例 / 命中率 / 按决策分解）；' +
    '复盘口径统计包含已过期 advice；默认只统计用户亲自回填（origin=user）的 outcome，' +
    '其它来源需显式 originFilter=all，被排除条数在 excluded 披露。' +
    '命中率只统计 followed 且填有有限盈亏的已了结样本；不足 20 条不提供分组结论。',
  sideEffect: 'read',
  input: GetAdviceStatsInput,
  output: GetAdviceStatsOutput,
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
        // 统计复盘不应被有效期截断（ARCHITECTURE §6.4），固定包含过期 advice。
        includeExpired: true,
      }),
    );

    const outcomes = await accountAdviceOutcomes(ctx, accountId);
    return {
      ...computeFlatStats(advices, outcomes, input.originFilter),
      byDecision: byDecisionOf(advices, outcomes, input.originFilter),
    };
  },
});
