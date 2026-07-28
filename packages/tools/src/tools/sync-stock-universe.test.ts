import { type StockUniverseManagerLike, stockCode } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { syncStockUniverseTool } from './sync-stock-universe.js';

describe('tool/sync_stock_universe', () => {
  it('获取完整快照并原子写入本地股票目录', async () => {
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

    const result = await syncStockUniverseTool.execute(
      { coverage: 'CN_A_SHARES_SH_SZ', force: true },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('succeeded');
    expect(result.data.observedCount).toBe(1);
    expect((await ctx.repos.stock.findById('600519.SH'))?.name).toBe('贵州茅台');
  });

  it('相对同源上一版骤降超过阈值时拒绝提交', async () => {
    const now = new Date('2026-07-28T08:30:00.000Z');
    const manager: StockUniverseManagerLike = {
      name: 'stock-universe',
      sources: ['eastmoney'],
      fetchStockUniverse: async () => ({
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
      }),
    };
    const ctx = await buildTestContext({ clock: () => now, stockUniverse: manager });
    await ctx.repos.stockUniverse.applySnapshot({
      syncId: 'previous-full',
      appliedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      snapshot: {
        source: 'eastmoney',
        coverage: 'CN_A_SHARES_SH_SZ',
        observedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        complete: true,
        reportedTotal: 2,
        entries: [
          {
            stockId: '600519.SH',
            code: stockCode('600519'),
            exchange: 'SH',
            name: '贵州茅台',
            listingStatus: 'listed',
          },
          {
            stockId: '002594.SZ',
            code: stockCode('002594'),
            exchange: 'SZ',
            name: '比亚迪',
            listingStatus: 'listed',
          },
        ],
      },
    });

    const result = await syncStockUniverseTool.execute({ force: true }, ctx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('adapter_error');
    expect(
      (
        await ctx.repos.stockUniverse.listCurrent({
          coverage: 'CN_A_SHARES_SH_SZ',
          status: 'active',
        })
      ).map((stock) => stock.id),
    ).toEqual(['002594.SZ', '600519.SH']);
  });
});
