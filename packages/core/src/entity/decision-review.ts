import { z } from 'zod';
import { InvariantError } from '../error/index.js';
import { AccountSchema } from './account.js';
import { HoldingSchema } from './holding.js';
import { TradeSchema } from './trade.js';

export const DecisionReviewSubjectSchema = z
  .object({
    kind: z.enum(['advice', 'trading-plan-version', 'watch-trigger']),
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

export const DecisionReviewContextSchema = z
  .object({
    schemaVersion: z.literal(1),
    capturedAt: z.coerce.date(),
    sourceDataAsOf: z.coerce.date().nullable(),
    captureOrigin: z.enum(['user', 'legacy-explicit-link']),
    source: z.record(z.string(), z.unknown()),
    contextHash: z.string().min(1),
  })
  .strict();
export type DecisionReviewContext = z.infer<typeof DecisionReviewContextSchema>;

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
