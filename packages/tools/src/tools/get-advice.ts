import {
  AdviceDecisionSchema,
  type AdviceQuery,
  AdviceSchema,
  AdviceSubjectKindSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';
import { selectAdvices } from '../internal/advice-selection.js';

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
});

/**
 * 输出口径标注（REQ-M3-17 ③ / task-20）：
 *
 * `scope` **必须**出现在结果里，而不只是写在 description 上——调用方拿到一批建议时
 * 要能就地判断「这批是不是本账户的」。本工具是**跨账户检索**，`accountId` 只决定
 * 「附加哪一份 outcome」与「账户是否存在」，**不参与建议归属过滤**。
 */
export const GetAdviceScopeSchema = z.literal('all-accounts');

export const GetAdviceOutput = z
  .object({
    /** 恒为 `all-accounts`：本工具不做账户归属过滤。按账户归属过滤请用 `list_advices`。 */
    scope: GetAdviceScopeSchema,
    advices: z.array(AdviceSchema),
    total: z.number().int().nonnegative(),
  })
  .strict();

export const getAdviceTool = defineTool({
  name: 'get_advice',
  description:
    '跨账户检索历史建议（按标的 / 决策 / 来源 / 时间窗过滤，默认不含已过期）。' +
    '**不做账户归属过滤**：accountId 只决定附加哪一份回填 outcome 与账户是否存在，' +
    '返回结果可能包含其它账户的建议（输出 scope 恒为 all-accounts）；' +
    '要「只属于本账户的建议」请用 list_advices',
  sideEffect: 'read',
  input: GetAdviceInput,
  output: GetAdviceOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    if (!accountId || (await ctx.repos.account.findById(accountId)) === null)
      return errNotFound('Account', accountId);
    // 过期判断必须用注入时钟：repository 的 includeExpired=false 分支按真实时钟过滤，
    // 会与 ctx.clock 不一致。选择逻辑抽到 `selectAdvices`，与 `list_advices` 共用一份。
    const filter: AdviceQuery = {
      ...(input.subjectKind !== undefined ? { subjectKind: input.subjectKind } : {}),
      ...(input.subjectId !== undefined ? { subjectId: input.subjectId } : {}),
      ...(input.decision !== undefined ? { decision: input.decision } : {}),
      ...(input.sourceTool !== undefined ? { sourceTool: input.sourceTool } : {}),
      ...(input.since !== undefined ? { since: input.since } : {}),
      ...(input.until !== undefined ? { until: input.until } : {}),
      includeExpired: true,
    };
    const advices = await selectAdvices(ctx, accountId, filter, {
      includeExpired: input.includeExpired,
      limit: input.limit,
    });
    // core Advice 的数组字段是 readonly，经 schema parse 得到输出类型（运行时零改动）。
    return {
      scope: 'all-accounts' as const,
      advices: z.array(AdviceSchema).parse(advices),
      total: advices.length,
    };
  },
});
