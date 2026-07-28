import type { StockUniverseSourceLike } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { StockUniverseManager } from './manager.js';

describe('stock-universe/StockUniverseManager', () => {
  it('主源返回无效空快照时继续 fallback', async () => {
    const calls: string[] = [];
    const primary: StockUniverseSourceLike = {
      name: 'primary',
      coverage: ['CN_A_SHARES_SH_SZ'],
      fetchStockUniverse: async () => {
        calls.push('primary');
        return {
          source: 'primary',
          coverage: 'CN_A_SHARES_SH_SZ',
          observedAt: new Date('2026-07-28T08:20:00.000Z'),
          complete: true,
          reportedTotal: 0,
          entries: [],
        } as never;
      },
    };
    const fallback: StockUniverseSourceLike = {
      name: 'fallback',
      coverage: ['CN_A_SHARES_SH_SZ'],
      fetchStockUniverse: async () => {
        calls.push('fallback');
        return {
          source: 'fallback',
          coverage: 'CN_A_SHARES_SH_SZ',
          observedAt: new Date('2026-07-28T08:21:00.000Z'),
          complete: true,
          reportedTotal: 1,
          entries: [
            {
              stockId: '600519.SH',
              code: '600519' as never,
              exchange: 'SH',
              name: '贵州茅台',
              listingStatus: 'listed',
            },
          ],
        };
      },
    };
    const manager = new StockUniverseManager({
      sources: [primary, fallback],
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    const snapshot = await manager.fetchStockUniverse({
      coverage: 'CN_A_SHARES_SH_SZ',
    });

    expect(snapshot.source).toBe('fallback');
    expect(calls).toEqual(['primary', 'fallback']);
  });
});
