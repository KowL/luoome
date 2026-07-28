import { type StockUniverseManagerLike, stockCode } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { syncStockUniverseWorkflow } from './sync-stock-universe.js';

describe('workflow/sync-stock-universe', () => {
  it('只通过 sync_stock_universe tool 完成目录同步', async () => {
    const manager: StockUniverseManagerLike = {
      name: 'stock-universe',
      sources: ['eastmoney'],
      fetchStockUniverse: async () => ({
        source: 'eastmoney',
        coverage: 'CN_A_SHARES_SH_SZ',
        observedAt: new Date('2026-07-28T08:20:00.000Z'),
        complete: true,
        reportedTotal: 1,
        entries: [
          {
            stockId: '600519.SH',
            code: stockCode('600519'),
            exchange: 'SH',
            name: '贵州茅台',
            listingStatus: 'listed',
          },
        ],
      }),
    };
    const ctx = await buildTestContext({ stockUniverse: manager });

    const result = await syncStockUniverseWorkflow.run({ force: true }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('succeeded');
    expect(result.data.observedCount).toBe(1);
  });
});
