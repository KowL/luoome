import type { Advice, Trade } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { linkTrades } from './trade-advice-links.js';

const advice = (id: string): Advice => ({ id, subjectKind: 'stock', subjectId: 'S' }) as Advice;
const trade = (id: string, adviceId?: string): Trade =>
  ({ id, stockId: 'S', adviceId }) as unknown as Trade;

describe('task-16 linkTrades：双链并认 + 去重', () => {
  it('两条链指向同一 advice 时，同一成交只记一次', () => {
    const links = linkTrades([advice('a1')], [trade('t1', 'a1')], new Map([['a1', ['t1']]]));
    expect(links.byAdvice.get('a1')).toHaveLength(1);
  });

  it('两条链指向不同 advice 时，成交只归一个 owner（review.tradeIds 优先）', () => {
    const links = linkTrades(
      [advice('a1'), advice('a2')],
      [trade('t1', 'a1')],
      new Map([['a2', ['t1']]]),
    );
    expect(links.byAdvice.get('a2')).toHaveLength(1);
    expect(links.byAdvice.get('a1') ?? []).toHaveLength(0);
    // 总链接数 = 成交数：没有重复计入。
    const total = [...links.byAdvice.values()].reduce((sum, list) => sum + list.length, 0);
    expect(total).toBe(1);
  });

  it('仅 Trade.adviceId 的成交也算链接（双链并认）', () => {
    const links = linkTrades([advice('a1')], [trade('t1', 'a1')], new Map());
    expect(links.byAdvice.get('a1')?.[0]?.relation).toBe('trade.adviceId');
  });

  it('仅 DecisionReview.tradeIds 的成交也算链接', () => {
    const links = linkTrades([advice('a1')], [trade('t1')], new Map([['a1', ['t1']]]));
    expect(links.byAdvice.get('a1')?.[0]?.relation).toBe('decision-review.tradeIds');
  });

  it('链接指向不存在的成交时进 unknowns，不静默丢弃', () => {
    const links = linkTrades([advice('a1')], [], new Map([['a1', ['ghost']]]));
    expect(links.unknowns).toHaveLength(1);
    expect(links.unknowns[0]).toContain('ghost');
  });
});
