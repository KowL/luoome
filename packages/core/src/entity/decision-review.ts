import { z } from 'zod';
import { InvariantError } from '../error/index.js';
import { AccountSchema } from './account.js';
import { AdviceOutcomeOriginSchema } from './advice.js';
import { HoldingSchema } from './holding.js';
import { TradeSchema } from './trade.js';

export const DecisionReviewSubjectSchema = z
  .object({
    /**
     * `account-review`：账户级日复盘（REQ-M4-11）。
     * `id` 为 `<accountId>:<YYYY-MM-DD>`，**一天一条** —— 这同时是确认路径的幂等键。
     */
    kind: z.enum(['advice', 'trading-plan-version', 'watch-trigger', 'account-review']),
    id: z.string().min(1),
  })
  .strict();
export type DecisionReviewSubject = z.infer<typeof DecisionReviewSubjectSchema>;

export const DecisionReviewContentSchema = z
  .object({
    tradeIds: z.array(z.string().min(1)).max(100),
    adviceFeedback: z
      .object({
        outcome: z.enum(['followed', 'partially_followed', 'ignored']),
        /**
         * 回填来源（REQ-M3-18 §2）。写入工具总是按通道盖章，调用方传什么都会被覆盖；
         * 可选只是为了读出 REQ-M3-18 之前的历史修订（无法追溯 = unattested）。
         */
        origin: AdviceOutcomeOriginSchema.optional(),
        pnl: z.number().finite().optional(),
        benchmarkPnl: z.number().finite().optional(),
        holdingHours: z.number().finite().nonnegative().optional(),
      })
      .strict()
      .nullable(),
    triggerFeedback: z.enum(['handled', 'useful', 'useless', 'ignored']).nullable(),
    note: z.string().max(2000).nullable(),
  })
  .strict();
export type DecisionReviewContent = z.infer<typeof DecisionReviewContentSchema>;

export const DecisionReviewContentPatchSchema = DecisionReviewContentSchema.partial().describe(
  'Top-level content patch: omitted fields keep their value from expectedRevision; on creation they start empty/null. Explicit null clears nullable fields; tradeIds: [] clears links. A supplied adviceFeedback object replaces that whole field.',
);
export type DecisionReviewContentPatch = z.infer<typeof DecisionReviewContentPatchSchema>;

export const mergeDecisionReviewContent = (
  patch: DecisionReviewContentPatch,
  previous?: DecisionReviewContent,
): DecisionReviewContent => ({
  tradeIds: patch.tradeIds ?? previous?.tradeIds ?? [],
  adviceFeedback:
    patch.adviceFeedback === undefined ? (previous?.adviceFeedback ?? null) : patch.adviceFeedback,
  triggerFeedback:
    patch.triggerFeedback === undefined
      ? (previous?.triggerFeedback ?? null)
      : patch.triggerFeedback,
  note: patch.note === undefined ? (previous?.note ?? null) : patch.note,
});

export const DecisionReviewContextSchema = z
  .object({
    schemaVersion: z.literal(1),
    capturedAt: z.coerce.date(),
    sourceDataAsOf: z.coerce.date().nullable(),
    captureOrigin: z.enum(['user', 'legacy-explicit-link']),
    /**
     * 来源快照。**不含**确认动作的元信息（如来源草稿 id）——
     * 那些进 `confirmationSourceDraftId`，否则会让「同一来源、两条路径」算出不同
     * `contextHash`，永远报「来源已变化」。
     */
    source: z.record(z.string(), z.unknown()),
    /**
     * 确认动作来自哪份草稿（REQ-M4-11）。
     *
     * **刻意不放进 `source`**：`contextHash` 摘要的是「来源是否还是当时那个来源」，
     * 而草稿 id 是确认动作的附属信息。放进 `source` 就需要「算 hash 前记得剥掉」，
     * 而「记得剥」是会漏的（本仓库 `tools/decision-review.ts` 两处算 hash 的地方
     * 就曾一处剥、一处没剥）。**放这里，任何地方算 hash 都天然一致。**
     */
    confirmationSourceDraftId: z.string().min(1).optional(),
    contextHash: z.string().min(1),
  })
  .strict();
export type DecisionReviewContext = z.infer<typeof DecisionReviewContextSchema>;

/**
 * 从复盘里读「来源草稿 id」（M4-11）。
 *
 * ## 为什么需要这个函数，而不是各处读 `context.source.sourceDraftId`
 *
 * `context.source` 是 `z.record(z.string(), z.unknown())` —— **类型上无法保证**该键存在、
 * 也无法保证它是字符串。若各调用点自己 `review.context.source.sourceDraftId`，
 * 将来存储形状一变就会漏改。
 *
 * 所以：**存储形状只在这里被解释一次**，所有读取点都调它。
 * 返回 `undefined` = 这条复盘不是从草稿确认来的（历史复盘、直接写入等）。
 */
export const reviewSourceDraftId = (
  review:
    | {
        readonly context?: DecisionReviewContext | null;
      }
    | null
    | undefined,
): string | undefined => {
  // 优先 `context.confirmationSourceDraftId`（REQ-M4-11 起的存放位置）：
  // 它不进 `source`，因此不参与 `contextHash` —— 两条路径算出的 hash 天然一致。
  const direct = review?.context?.confirmationSourceDraftId;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  // 兼容旧位置（`source.sourceDraftId`）。
  const legacy = review?.context?.source?.sourceDraftId;
  return typeof legacy === 'string' && legacy.length > 0 ? legacy : undefined;
};

/** 写入侧：把来源草稿 id 放进 `context.source`（唯一写入点）。 */
export const decisionReviewContextSource = (
  base: Readonly<Record<string, unknown>> | undefined,
  sourceDraftId: string | undefined,
): Record<string, unknown> => ({
  ...(base ?? {}),
  ...(sourceDraftId === undefined ? {} : { sourceDraftId }),
});

export const DecisionReviewSchema = z
  .object({
    id: z.string().min(1),
    accountId: z.string().min(1),
    subject: DecisionReviewSubjectSchema,
    stockId: z.string().min(1).nullable(),
    sourceOccurredAt: z.coerce.date(),
    context: DecisionReviewContextSchema,
    currentRevision: z.number().int().positive(),
    createdAt: z.coerce.date(),
  })
  .strict();
export type DecisionReview = z.infer<typeof DecisionReviewSchema>;

export const DecisionReviewRevisionSchema = z
  .object({
    reviewId: z.string().min(1),
    revision: z.number().int().positive(),
    sequence: z.number().int().positive(),
    content: DecisionReviewContentSchema,
    tradeFactHashes: z.record(z.string(), z.string()),
    contentHash: z.string().min(1),
    recordedAt: z.coerce.date(),
    changeNote: z.string().max(2000).nullable(),
  })
  .strict();
export type DecisionReviewRevision = z.infer<typeof DecisionReviewRevisionSchema>;

export interface DecisionReviewWithRevision {
  readonly review: DecisionReview;
  readonly revision: DecisionReviewRevision;
}

export const DecisionTradeCommitResultSchema = z
  .object({
    trade: TradeSchema,
    holding: HoldingSchema,
    account: AccountSchema,
    reviews: z.array(
      z.object({ review: DecisionReviewSchema, revision: DecisionReviewRevisionSchema }),
    ),
  })
  .strict();
export type DecisionTradeCommitResult = z.infer<typeof DecisionTradeCommitResultSchema>;

export const assertDecisionReviewContent = (
  subject: DecisionReviewSubject,
  content: DecisionReviewContent,
  first: boolean,
): void => {
  const parsed = DecisionReviewContentSchema.parse(content);
  if (new Set(parsed.tradeIds).size !== parsed.tradeIds.length) {
    throw new InvariantError('成交关联不可重复');
  }
  if (subject.kind !== 'advice' && parsed.adviceFeedback !== null) {
    throw new InvariantError('只有 Advice 可以填写建议反馈');
  }
  if (subject.kind !== 'watch-trigger' && parsed.triggerFeedback !== null) {
    throw new InvariantError('只有 WatchTrigger 可以填写提醒反馈');
  }
  if (
    first &&
    parsed.tradeIds.length === 0 &&
    parsed.adviceFeedback === null &&
    parsed.triggerFeedback === null &&
    parsed.note === null
  ) {
    throw new InvariantError('首次记录不能全部为空');
  }
};
