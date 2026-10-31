import {
  AdviceCardSchema,
  AdviceDecisionSchema,
  type AdviceQuery,
  AdviceSchema,
  AdviceSubjectKindSchema,
  renderAdviceCard,
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
 * 输出口径标注（REQ-M3-17 ③ / task-20 → task-21）：
 *
 * `scope` **必须**出现在结果里，而不只是写在 description 上——调用方拿到一批建议时
 * 要能就地判断「这批是不是本账户的」。本工具与 `list_advices` 用**同一份**归属实现
 * （`selectAdvices` → `adviceAttribution`），`scope` 恒为 `account`。
 */
export const GetAdviceScopeSchema = z.literal('account');

export const GetAdviceOutput = z
  .object({
    /** 恒为 `account`：本工具按账户归属过滤，与 `list_advices` 同一口径。 */
    scope: GetAdviceScopeSchema,
    advices: z.array(AdviceSchema),
    total: z.number().int().nonnegative(),
    /**
     * 本次查询命中、但**无法归属到任何账户**的建议条数（存量无归属数据）。
     * 它们不会出现在 `advices` 里，但必须被计数披露——不许静默丢弃。
     */
    unattributedCount: z.number().int().nonnegative(),
    /**
     * 每条返回建议的**卡片产物**（REQ-M3-09 §2 / S2）。五段的组装与「缺段 → blocked」
     * 判定只有一份实现（core `renderAdviceCard`），这里只是把它随建议一起下发，
     * 让任何消费 `get_advice` 的面都吃同一个产物，而不是各自再拼一遍。
     * 与 `advices` **按 id 对齐**。
     */
    cards: z.array(AdviceCardSchema),
  })
  .strict();

export const getAdviceTool = defineTool({
  name: 'get_advice',
  description:
    '查询**本账户**历史建议（按账户归属过滤，输出 scope 恒为 account；' +
    '另按标的 / 决策 / 来源 / 时间窗过滤，默认不含已过期）。' +
    '归属判定与 list_advices 是同一实现（basedOn.strategy.accountId 或本账户复盘记录）；' +
    '无法归属到任何账户的存量建议不进列表，条数见 unattributedCount',
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
    const { advices, unattributedCount } = await selectAdvices(ctx, accountId, filter, {
      includeExpired: input.includeExpired,
      limit: input.limit,
    });
    // core Advice 的数组字段是 readonly，经 schema parse 得到输出类型（运行时零改动）。
    const parsed = z.array(AdviceSchema).parse(advices);
    const now = ctx.clock();
    return {
      scope: 'account' as const,
      advices: parsed,
      total: parsed.length,
      unattributedCount,
      cards: parsed.map((advice) => renderAdviceCard(advice, now)),
    };
  },
});
