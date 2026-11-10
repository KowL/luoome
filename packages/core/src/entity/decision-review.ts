import { z } from 'zod';
import { InvariantError } from '../error/index.js';

export const DecisionReviewSubjectKindSchema = z.enum(['advice', 'trading-plan', 'trade']);
export type DecisionReviewSubjectKind = z.infer<typeof DecisionReviewSubjectKindSchema>;

export const DecisionReviewSubjectSchema = z
  .object({
    kind: DecisionReviewSubjectKindSchema,
    id: z.string().min(1),
  })
  .strict();
export type DecisionReviewSubject = z.infer<typeof DecisionReviewSubjectSchema>;

export const DecisionReviewAdviceFeedbackSchema = z
  .object({
    outcome: z.enum(['followed', 'partially_followed', 'ignored']),
    pnl: z.number().finite().optional(),
    benchmarkPnl: z.number().finite().optional(),
    holdingHours: z.number().finite().nonnegative().optional(),
  })
  .strict();

export const DecisionReviewContentSchema = z
  .object({
    tradeIds: z.array(z.string().min(1)).max(100).default([]),
    adviceFeedback: DecisionReviewAdviceFeedbackSchema.nullable().default(null),
    /** 教训标签；用于按主题筛选历史复盘。 */
    lessonTags: z.array(z.string().min(1).max(50)).max(20).default([]),
    note: z.string().max(2000).nullable().default(null),
  })
  .strict();
export type DecisionReviewContent = z.infer<typeof DecisionReviewContentSchema>;

export const DecisionReviewSchema = z
  .object({
    id: z.string().min(1),
    accountId: z.string().min(1),
    subject: DecisionReviewSubjectSchema,
    stockId: z.string().min(1).nullable(),
    content: DecisionReviewContentSchema,
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .strict();
export type DecisionReview = z.infer<typeof DecisionReviewSchema>;

export const assertDecisionReviewContent = (
  subject: DecisionReviewSubject,
  content: DecisionReviewContent,
): void => {
  const parsed = DecisionReviewContentSchema.parse(content);
  if (new Set(parsed.tradeIds).size !== parsed.tradeIds.length) {
    throw new InvariantError('成交关联不可重复');
  }
  if (subject.kind !== 'advice' && parsed.adviceFeedback !== null) {
    throw new InvariantError('只有 Advice 可以填写建议反馈');
  }
  if (
    parsed.tradeIds.length === 0 &&
    parsed.adviceFeedback === null &&
    parsed.lessonTags.length === 0 &&
    parsed.note === null
  ) {
    throw new InvariantError('复盘内容不能全部为空');
  }
};
