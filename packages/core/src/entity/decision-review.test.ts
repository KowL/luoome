import { describe, expect, it } from 'vitest';

import {
  assertDecisionReviewContent,
  DecisionReviewContentSchema,
  type DecisionReviewSubject,
} from './decision-review.js';

const adviceSubject: DecisionReviewSubject = { kind: 'advice', id: 'advice-1' };
const watchSubject: DecisionReviewSubject = { kind: 'watch-trigger', id: 'trigger-1' };

describe('DecisionReviewContentSchema 可空字段', () => {
  it('省略可空字段 → 解析为显式 null', () => {
    const parsed = DecisionReviewContentSchema.parse({ tradeIds: [] });
    expect(parsed).toEqual({
      tradeIds: [],
      adviceFeedback: null,
      triggerFeedback: null,
      note: null,
    });
  });

  it('占位字符串 "null" 仍然被拒绝', () => {
    const parsed = DecisionReviewContentSchema.safeParse({
      tradeIds: [],
      triggerFeedback: 'null',
    });
    expect(parsed.success).toBe(false);
  });

  it('非法的枚举取值仍然被拒绝', () => {
    const parsed = DecisionReviewContentSchema.safeParse({
      tradeIds: [],
      triggerFeedback: 'none',
    });
    expect(parsed.success).toBe(false);
  });

  it('省略与显式 null 得到同一个内容（重放与哈希口径一致）', () => {
    const omitted = DecisionReviewContentSchema.parse({ tradeIds: [], note: 'x' });
    const explicit = DecisionReviewContentSchema.parse({
      tradeIds: [],
      adviceFeedback: null,
      triggerFeedback: null,
      note: 'x',
    });
    expect(omitted).toEqual(explicit);
  });

  it('省略可空字段后不变量仍然按显式 null 判定', () => {
    expect(() =>
      assertDecisionReviewContent(
        adviceSubject,
        DecisionReviewContentSchema.parse({ tradeIds: [], note: 'x' }),
        true,
      ),
    ).not.toThrow();
    expect(() =>
      assertDecisionReviewContent(
        adviceSubject,
        DecisionReviewContentSchema.parse({
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
        DecisionReviewContentSchema.parse({
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
        DecisionReviewContentSchema.parse({ tradeIds: [] }),
        true,
      ),
    ).toThrow();
    expect(() =>
      assertDecisionReviewContent(
        watchSubject,
        DecisionReviewContentSchema.parse({ tradeIds: [] }),
        true,
      ),
    ).toThrow();
  });
});
