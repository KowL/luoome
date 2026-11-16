import {
  AdviceDecisionSchema,
  type AdviceQuery,
  AdviceSchema,
  AdviceSubjectKindSchema,
  DecisionReviewSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';
import {
  accountAdviceOutcomes,
  attachAccountAdviceOutcomes,
} from '../internal/account-advice-outcomes.js';
import { listDecisionReviewsTool } from './decision-review.js';

export const GetAdviceInput = z.object({
  accountId: z.string().min(1).optional(),
  subjectKind: AdviceSubjectKindSchema.optional(),
  subjectId: z.string().min(1).optional(),
  decision: AdviceDecisionSchema.optional(),
  sourceTool: z.string().min(1).optional(),
  /** ISO 日期时间字符串；按 createdAt 过滤（闭区间下界）。 */
  since: z.coerce.date().optional(),
  /** ISO 日期时间字符串；按 createdAt 过滤（闭区间上界）。 */
  until: z.coerce.date().optional(),
  /** 默认 false：已过期 advice（validUntil <= now）不返回（ARCHITECTURE §6.5）。 */
  includeExpired: z.boolean().default(false),
  limit: z.number().int().positive().max(500).default(50),
  /** 同时附带该标的的决策复盘记录（合并原 list_decision_reviews）。 */
  includeDecisionReviews: z.boolean().default(false),
  decisionReviewLimit: z.number().int().positive().max(200).default(20),
});

export const GetAdviceOutput = z.object({
  advices: z.array(AdviceSchema),
  total: z.number().int().nonnegative(),
  decisionReviews: z.array(DecisionReviewSchema).optional(),
});

export const getAdviceTool = defineTool({
  name: 'get_advice',
  description: '查询历史建议（按标的 / 决策 / 来源 / 时间窗过滤，默认不含已过期）',
  sideEffect: 'read',
  input: GetAdviceInput,
  output: GetAdviceOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    if (!accountId || (await ctx.repos.account.findById(accountId)) === null)
      return errNotFound('Account', accountId);
    const filter: AdviceQuery = {
      ...(input.subjectKind !== undefined ? { subjectKind: input.subjectKind } : {}),
      ...(input.subjectId !== undefined ? { subjectId: input.subjectId } : {}),
      ...(input.decision !== undefined ? { decision: input.decision } : {}),
      ...(input.sourceTool !== undefined ? { sourceTool: input.sourceTool } : {}),
      ...(input.since !== undefined ? { since: input.since } : {}),
      ...(input.until !== undefined ? { until: input.until } : {}),
      includeExpired: input.includeExpired,
      limit: input.limit,
    };
    const raw = await ctx.repos.advice.query(filter);
    const outcomes = await accountAdviceOutcomes(ctx, accountId);
    const advices = attachAccountAdviceOutcomes(raw, outcomes);
    // core Advice 的数组字段是 readonly，经 schema parse 得到输出类型（运行时零改动）。
    const output: z.infer<typeof GetAdviceOutput> = {
      advices: z.array(AdviceSchema).parse(advices),
      total: advices.length,
    };
    if (input.includeDecisionReviews) {
      const reviews = await listDecisionReviewsTool.execute(
        {
          accountId,
          subjectKind: 'advice',
          limit: input.decisionReviewLimit,
        },
        ctx,
      );
      if (reviews.ok) output.decisionReviews = [...reviews.data.records];
    }
    return output;
  },
});
