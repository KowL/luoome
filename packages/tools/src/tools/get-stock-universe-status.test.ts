import { type StockUniverseManagerLike, stockCode } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { getStockUniverseStatusTool } from './get-stock-universe-status.js';

describe('tool/get_stock_universe_status', () => {
  it('返回当前覆盖范围、目录数量、新鲜度和启用数据源', async () => {
    const now = new Date('2026-07-28T08:30:00.000Z');
    const manager: StockUniverseManagerLike = {
      name: 'stock-universe',
      sources: ['eastmoney', 'tushare'],
      fetchStockUniverse: () => Promise.reject(new Error('not used')),
    };
    const ctx = await buildTestContext({ clock: () => now, stockUniverse: manager });
    await ctx.repos.stockUniverse.applySnapshot({
      syncId: 'sync-status',
      appliedAt: now,
      snapshot: {
        source: 'eastmoney',
        coverage: 'CN_A_SHARES_SH_SZ',
        observedAt: now,
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
      },
    });

    const result = await getStockUniverseStatusTool.execute({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.coverage).toBe('CN_A_SHARES_SH_SZ');
    expect(result.data.sources).toEqual(['eastmoney', 'tushare']);
    expect(result.data.activeCount).toBe(1);
    expect(result.data.missingCount).toBe(0);
    expect(result.data.freshness).toBe('fresh');
    expect(result.data.lastSuccess?.source).toBe('eastmoney');
  });
});
