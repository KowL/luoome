import { z } from 'zod';

/**
 * 复盘 → 策略修订**提案**（REQ-M4-03）。
 *
 * ## 「提案」与「发布」是两件事
 *
 * 提案表达「基于这次复盘，我认为策略该这样改」，它是**研究的产物**，不是变更动作。
 * 真正改策略要走 `publish_strategy_version`，那需要单独的用户动作。
 *
 * ## 为什么状态枚举里没有 `published` / `active`
 *
 * 这是「**不产生自动发布**」的**第一重**保证：**类型上就写不出「已生效的提案」**。
 * 第二重是产出路径不调用发布类工具（有源码守卫钉住）。
 * 两者都要：前者防「有人顺手加个状态」，后者防「绕过枚举直接调工具」。
 */
export const ReviewRevisionProposalStatusSchema = z.enum([
  /** 刚生成的提案，尚未被任何人看过。 */
  'draft',
  /** 已被用户明确接受，**但仍未发布**——接受 ≠ 发布。 */
  'accepted',
  /** 已被用户放弃。 */
  'rejected',
]);
export type ReviewRevisionProposalStatus = z.infer<typeof ReviewRevisionProposalStatusSchema>;

/**
 * 提案。
 *
 * ## 两个必填的追溯字段
 *
 * - `sourceReviewId`：**来自哪次复盘**（PRD 需求 ①）
 * - `factIds`：**引用哪些具体事实**（PRD 需求 ③，复用 M4-02 的 `factIds: string[]` 结构）
 *
 * 都设成**必填**而不是可选：可选就会长出「不知道从哪来的提案」，
 * 而那类提案无法被审计。
 */
export const ReviewRevisionProposalSchema = z
  .object({
    id: z.string().min(1),
    strategyId: z.string().min(1),
    accountId: z.string().min(1),
    /**
     * 来源复盘 id（`DecisionReview.id`）。**必填**。
     */
    sourceReviewId: z.string().min(1),
    /**
     * 引用的事实 id 数组（**不是自由文本**）。
     *
     * 与 M4-02 的 `TriangleRoleTask.factIds` 同一结构：
     * 若允许字符串，就会变成「因为业绩好」这类无法核对的理由。
     */
    factIds: z.array(z.string().min(1)).min(1),
    /** 改什么（人话说明，允许文本——它是提案内容，不是证据）。 */
    changeSummary: z.string().trim().min(1).max(500),
    status: ReviewRevisionProposalStatusSchema,
    createdAt: z.coerce.date(),
  })
  .strict();
export type ReviewRevisionProposal = z.infer<typeof ReviewRevisionProposalSchema>;

/**
 * 提案产出的**状态是封闭的**：只有三个，没有已生效态。
 *
 * 这条函数式断言给守卫用：若有人往枚举里加 `published`，
 * `PROPOSAL_STATUSES` 与这里会不一致，测试立刻红。
 */
export const PROPOSAL_STATUSES = ['draft', 'accepted', 'rejected'] as const;

/** 已生效态的字面量——**提案里出现任何一个都是 Bug**。 */
export const FORBIDDEN_PROPOSAL_STATUSES = ['published', 'active', 'enabled', 'live'] as const;
