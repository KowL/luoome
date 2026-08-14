import { money } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { deriveStrategyMetaByStock } from './strategy-meta.js';

describe('deriveStrategyMetaByStock', () => {
  it('只在提供真实天梯成员时写入 limitUpLevel/limitUpToday', () => {
    const bars = Array.from({ length: 6 }, (_, index) => ({
      stockId: '600519.SH',
      date: new Date(Date.UTC(2026, 7, index + 3)),
      open: money(10),
      high: money(10),
      low: money(10),
      close: money(10),
      volume: 1_000_000,
      adjustment: 'qfq' as const,
      source: 'sina' as const,
    }));
    const withLadder = deriveStrategyMetaByStock([
      {
        stockId: '600519.SH',
        bars,
        limitUpLadder: { ladderLevel: 3 },
      },
    ]).get('600519.SH');
    expect(withLadder).toMatchObject({ limitUpLevel: 3, limitUpToday: true });

    const withoutLadder = deriveStrategyMetaByStock([{ stockId: '600519.SH', bars }]).get(
      '600519.SH',
    );
    expect(withoutLadder).not.toHaveProperty('limitUpLevel');
    expect(withoutLadder).not.toHaveProperty('limitUpToday');
  });
});
