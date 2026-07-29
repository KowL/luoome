import { describe, expect, it } from 'vitest';

import { assertStrategySelectionPolicy } from './strategy-watchlist-policy.js';

describe('Strategy / Watchlist 已确认决策约束', () => {
  it('零 selection rule 只允许 builtin/migration', () => {
    expect(() =>
      assertStrategySelectionPolicy({ origin: 'builtin', selectionRuleCount: 0 }),
    ).not.toThrow();
    expect(() =>
      assertStrategySelectionPolicy({ origin: 'migration', selectionRuleCount: 0 }),
    ).not.toThrow();
    expect(() => assertStrategySelectionPolicy({ origin: 'user', selectionRuleCount: 0 })).toThrow(
      /至少需要一条/,
    );
    expect(() =>
      assertStrategySelectionPolicy({ origin: 'user', selectionRuleCount: 1 }),
    ).not.toThrow();
  });
});
