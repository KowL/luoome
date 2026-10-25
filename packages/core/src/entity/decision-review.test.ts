import { describe, expect, it } from 'vitest';

import {
  assertDecisionReviewContent,
  DecisionReviewContentPatchSchema,
  DecisionReviewContentSchema,
  type DecisionReviewSubject,
  mergeDecisionReviewContent,
} from './decision-review.js';

const adviceSubject: DecisionReviewSubject = { kind: 'advice', id: 'advice-1' };
const watchSubject: DecisionReviewSubject = { kind: 'watch-trigger', id: 'trigger-1' };

describe('DecisionReview content patches', () => {
  it('keeps stored content complete and materializes an initial patch', () => {
    expect(DecisionReviewContentSchema.safeParse({ tradeIds: [] }).success).toBe(false);
    const parsed = mergeDecisionReviewContent(
      DecisionReviewContentPatchSchema.parse({ tradeIds: [] }),
    );
    expect(parsed).toEqual({
      tradeIds: [],
      adviceFeedback: null,
      triggerFeedback: null,
      note: null,
    });
  });

  it('占位字符串 "null" 仍然被拒绝', () => {
    const parsed = DecisionReviewContentPatchSchema.safeParse({
      tradeIds: [],
      triggerFeedback: 'null',
    });
    expect(parsed.success).toBe(false);
  });

  it('非法的枚举取值仍然被拒绝', () => {
    const parsed = DecisionReviewContentPatchSchema.safeParse({
      tradeIds: [],
      triggerFeedback: 'none',
    });
    expect(parsed.success).toBe(false);
  });

  it('uses null for omitted initial fields without equating omission with removal on updates', () => {
    const omitted = mergeDecisionReviewContent({ tradeIds: [], note: 'x' });
    const explicit = mergeDecisionReviewContent({
      tradeIds: [],
      adviceFeedback: null,
      triggerFeedback: null,
      note: 'x',
    });
    expect(omitted).toEqual(explicit);
    const previous = { ...omitted, adviceFeedback: { outcome: 'ignored' as const, pnl: 0 } };
    expect(mergeDecisionReviewContent({ note: 'updated' }, previous)).toEqual({
      ...previous,
      note: 'updated',
    });
    expect(
      mergeDecisionReviewContent({ adviceFeedback: null }, previous).adviceFeedback,
    ).toBeNull();
  });

  it('preserves omitted links and trigger feedback and clears a note only with explicit null', () => {
    const previous = {
      tradeIds: ['trade-1'],
      adviceFeedback: null,
      triggerFeedback: 'useful' as const,
      note: 'original',
    };
    expect(mergeDecisionReviewContent({ note: undefined }, previous)).toEqual(previous);
    expect(mergeDecisionReviewContent({ note: null }, previous)).toEqual({
      ...previous,
      note: null,
    });
    expect(mergeDecisionReviewContent({ triggerFeedback: null, tradeIds: [] }, previous)).toEqual({
      ...previous,
      triggerFeedback: null,
      tradeIds: [],
    });
    expect(DecisionReviewContentPatchSchema.safeParse({ tradeIds: null }).success).toBe(false);
  });

  it('省略可空字段后不变量仍然按显式 null 判定', () => {
    expect(() =>
      assertDecisionReviewContent(
        adviceSubject,
        mergeDecisionReviewContent({ tradeIds: [], note: 'x' }),
        true,
      ),
    ).not.toThrow();
    expect(() =>
      assertDecisionReviewContent(
        adviceSubject,
        mergeDecisionReviewContent({
          tradeIds: [],
          adviceFeedback: { outcome: 'ignored' },
          note: 'x',
        }),
        true,
      ),
    ).not.toThrow();
    expect(() =>
      assertDecisionReviewContent(
        adviceSubject,
        mergeDecisionReviewContent({
          tradeIds: [],
          triggerFeedback: 'handled',
          note: 'x',
        }),
        true,
      ),
    ).toThrow();
  });

  it('首次记录全部为空仍然被拒绝', () => {
    expect(() =>
      assertDecisionReviewContent(
        adviceSubject,
        mergeDecisionReviewContent({ tradeIds: [] }),
        true,
      ),
    ).toThrow();
    expect(() =>
      assertDecisionReviewContent(watchSubject, mergeDecisionReviewContent({ tradeIds: [] }), true),
    ).toThrow();
  });
});
