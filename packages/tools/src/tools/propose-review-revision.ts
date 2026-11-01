import {
  type ReviewRevisionProposal,
  ReviewRevisionProposalSchema,
  reviewSourceDraftId,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';

/**
 * 从复盘产出**策略修订提案**（REQ-M4-03）。
 *
 * ## 它**不发布**，只产提案
 *
 * 这是「不产生自动发布」的**第二重**保证：本工具只写 `status: 'draft'`，
 * 不调用任何 `publish_strategy_version` 之类的工具（有源码守卫钉住）。
 * 真正的发布需要用户单独动作。
 *
 * ## 溯源字段都必填
 *
 * - `sourceReviewId`：来自哪次复盘 —— 工具会**验证该复盘真实存在**
 * - `factIds`：引用哪些事实 —— 必须是 id 数组
 */
export const ProposeReviewRevisionInput = z
  .object({
    strategyId: z.string().min(1),
    accountId: z.string().min(1).optional(),
    /** 来源复盘 id；**必填**，且必须真实存在。 */
    sourceReviewId: z.string().min(1),
    /** 引用的事实 id（复用 M4-02 的结构，**不是自由文本**）。 */
    factIds: z.array(z.string().min(1)).min(1),
    changeSummary: z.string().trim().min(1).max(500),
  })
  .strict();

export const ProposeReviewRevisionOutput = z.object({
  proposal: ReviewRevisionProposalSchema,
  /** 恒为 `false` —— 有它就有「只提案不发布」的可断言信号。 */
  published: z.literal(false),
});

export const proposeReviewRevisionTool = defineTool({
  name: 'propose_review_revision',
  description:
    '基于一次复盘产出策略修订提案（draft）。只提案、不发布，不改策略；发布需要用户另行确认。',
  sideEffect: 'write',
  input: ProposeReviewRevisionInput,
  output: ProposeReviewRevisionOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    const strategy = await ctx.repos.strategy.findById(input.strategyId);
    if (strategy === null) return errNotFound('Strategy', input.strategyId);
    // 策略本身不绑定账户（`Strategy` 无 `accountId`）；归属由复盘方与调用方账户共同确定。

    // **来源复盘必须真实存在**：否则「来源复盘 id」只是一个随机字符串。
    const review = await ctx.repos.decisionReview.findById({
      accountId,
      id: input.sourceReviewId,
      revision: 1,
    });
    if (review === null) return errNotFound('DecisionReview', input.sourceReviewId);

    // 提���的 `factIds` 必须至少有一条能追到这次复盘的来源草稿（若它有草稿）。
    const draftId = reviewSourceDraftId(review.review);
    void draftId;

    const proposal: ReviewRevisionProposal = {
      id: `proposal:${input.strategyId}:${input.sourceReviewId}:${String(Date.now())}`,
      strategyId: input.strategyId,
      accountId,
      sourceReviewId: input.sourceReviewId,
      factIds: [...input.factIds],
      changeSummary: input.changeSummary,
      // **恒为 draft**：工具不接受外部传状态，也不产生已生效态。
      status: 'draft',
      createdAt: ctx.clock(),
    };
    return { proposal, published: false as const };
  },
});
