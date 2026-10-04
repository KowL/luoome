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

export const GetAdviceStatsInput = z.object({
  accountId: z.string().min(1).optional(),
  subjectKind: AdviceSubjectKindSchema.optional(),
  subjectId: z.string().min(1).optional(),
  /** ISO 日期时间字符串；按 createdAt 过滤（闭区间下界）。 */
  since: z.coerce.date().optional(),
  /** ISO 日期时间字符串；按 createdAt 过滤（闭区间上界）。 */
  until: z.coerce.date().optional(),
});

/**
 * 单层决策统计。
 * 注：core 的 AdviceStats.byDecision 类型是无限递归（byDecision 的每个值仍含
 * 必填 byDecision），没有任何有限值能满足它；因此本工具输出一层拍平的
 * byDecision 分解（叶子不再嵌套），字段与 core AdviceStats 其余部分对齐。
 */
const flatStatsSchema = z.object({
  schemaVersion: z.literal(2),
  totalAdvices: z.number().int().nonnegative(),
  avgConfidence: z.number().min(0).max(100),
  feedbackCount: z.number().int().nonnegative(),
  followedWithPnl: z.number().int().nonnegative(),
  outcomeRate: z.object({
    followed: z.number().min(0).max(1).nullable(),
    partiallyFollowed: z.number().min(0).max(1).nullable(),
    ignored: z.number().min(0).max(1).nullable(),
  }),
  pnlWhenFollowed: z.null(),
  pnlWhenIgnored: z.null(),
  /** 用户明确 followed 且填写 pnl 的样本中盈利比例。 */
  hitRate: z.number().min(0).max(1).nullable(),
});

export const GetAdviceStatsOutput = flatStatsSchema.extend({
  byDecision: z.record(AdviceDecisionSchema, flatStatsSchema),
});

type FlatStats = z.infer<typeof flatStatsSchema>;

const computeFlatStats = (
  advices: readonly Advice[],
  outcomes: ReadonlyMap<string, AdviceOutcome>,
): FlatStats => {
  const totalAdvices = advices.length;
  const avgConfidence =
    totalAdvices === 0
      ? 0
      : Math.round((advices.reduce((sum, a) => sum + a.confidence, 0) / totalAdvices) * 100) / 100;

  let followed = 0;
  let partiallyFollowed = 0;
  let ignored = 0;
  let followedWithPnl = 0;
  let hits = 0;

  for (const advice of advices) {
    const outcome = outcomes.get(advice.id);
    if (outcome === undefined) continue;
    if (outcome.outcome === 'followed') followed += 1;
    else if (outcome.outcome === 'partially_followed') partiallyFollowed += 1;
    else ignored += 1;

    if (outcome.pnl === undefined) continue;
    if (outcome.outcome === 'followed') {
      followedWithPnl += 1;
      if (outcome.pnl > 0) hits += 1;
    }
  }

  const feedbackCount = followed + partiallyFollowed + ignored;
  const rate = (n: number): number | null => (totalAdvices === 0 ? null : n / totalAdvices);

  return {
    schemaVersion: 2,
    totalAdvices,
    avgConfidence,
    feedbackCount,
    followedWithPnl,
    outcomeRate: {
      followed: rate(followed),
      partiallyFollowed: rate(partiallyFollowed),
      ignored: rate(ignored),
    },
    pnlWhenFollowed: null,
    pnlWhenIgnored: null,
    hitRate: followedWithPnl === 0 ? null : hits / followedWithPnl,
  };
};

const byDecisionOf = (
  advices: readonly Advice[],
  outcomes: ReadonlyMap<string, AdviceOutcome>,
): Record<AdviceDecision, FlatStats> => {
  const forDecision = (decision: AdviceDecision): FlatStats =>
    computeFlatStats(
      advices.filter((a) => a.decision === decision),
      outcomes,
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
    '复盘口径统计包含已过期 advice',
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

    return { ...computeFlatStats(advices, outcomes), byDecision: byDecisionOf(advices, outcomes) };
  },
});
