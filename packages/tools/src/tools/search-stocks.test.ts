import type { MarketDataAdapterLike } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';
import { searchStocksTool } from './search-stocks.js';

describe('tool/search_stocks', () => {
  it('正常路径：按代码模糊搜', async () => {
    const ctx = await buildTestContext();
    const res = await searchStocksTool.execute({ query: '0025' }, ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.stocks.length).toBeGreaterThan(0);
    expect(res.data.stocks[0]?.id).toBe('002594.SZ');
  });

  it('正常路径：按名称模糊搜', async () => {
    const ctx = await buildTestContext();
    const res = await searchStocksTool.execute({ query: '茅台' }, ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.stocks[0]?.id).toBe('600519.SH');
  });

  it('正常路径：limit 限制', async () => {
    const ctx = await buildTestContext();
    const res = await searchStocksTool.execute({ query: 'A', limit: 3 }, ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.stocks.length).toBeLessThanOrEqual(3);
  });

  it('正常路径：query 空白 → 返回空数组', async () => {
    const ctx = await buildTestContext();
    const res = await searchStocksTool.execute({ query: '   ' }, ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.stocks).toEqual([]);
  });

  it('错误路径：limit 超过 100 → invalid_input', async () => {
    const ctx = await buildTestContext();
    const res = await searchStocksTool.execute({ query: 'x', limit: 101 }, ctx);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('invalid_input');
  });

  it('目录尚未同步时走 adapter 外部搜索（source=external）', async () => {
    const ctx = await buildTestContext();
    const res = await searchStocksTool.execute({ query: '0025' }, ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.source).toBe('external');
    expect(res.data.stocks[0]?.id).toBe('002594.SZ');
  });

  it('adapter 抛错 → 降级本地历史（source=local-history）', async () => {
    const ctx = await buildTestContext();
    const brokenMarket: MarketDataAdapterLike = {
      ...ctx.adapters.market,
      name: 'broken',
      fetchQuote: () => Promise.reject(new Error('down')),
      batchQuote: () => Promise.reject(new Error('down')),
      fetchDailyBars: () => Promise.reject(new Error('down')),
      searchStocks: () => Promise.reject(new Error('down')),
    };
    const res = await searchStocksTool.execute(
      { query: '0025' },
      { ...ctx, adapters: { ...ctx.adapters, market: brokenMarket } },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.source).toBe('local-history');
    expect(res.data.stocks[0]?.id).toBe('002594.SZ');
  });

  it('adapter 未实现 searchStocks → 本地历史（source=local-history）', async () => {
    const ctx = await buildTestContext();
    const noSearchMarket: MarketDataAdapterLike = {
      ...ctx.adapters.market,
      name: 'no-search',
      fetchQuote: () => Promise.reject(new Error('not used')),
      batchQuote: () => Promise.reject(new Error('not used')),
      fetchDailyBars: () => Promise.reject(new Error('not used')),
      searchStocks: () => Promise.reject(new Error('unsupported_capability: search')),
    };
    const res = await searchStocksTool.execute(
      { query: '茅台' },
      { ...ctx, adapters: { ...ctx.adapters, market: noSearchMarket } },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.source).toBe('local-history');
    expect(res.data.stocks[0]?.id).toBe('600519.SH');
  });

  it('新鲜本地目录命中时不访问外部搜索', async () => {
    const now = new Date('2026-07-28T08:30:00.000Z');
    const ctx = await buildTestContext({ clock: () => now });
    await ctx.repos.stockUniverse.applySnapshot({
      syncId: 'sync-search',
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
            code: '600519' as never,
            exchange: 'SH',
            name: '贵州茅台',
            listingStatus: 'listed',
          },
        ],
      },
    });
    let externalCalls = 0;
    const market: MarketDataAdapterLike = {
      ...ctx.adapters.market,
      searchStocks: async () => {
        externalCalls += 1;
        return [];
      },
    };

    const res = await searchStocksTool.execute(
      { query: '茅台' },
      { ...ctx, adapters: { ...ctx.adapters, market } },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.source).toBe('local-universe');
    expect(res.data.stocks.map((stock) => stock.id)).toEqual(['600519.SH']);
    expect(externalCalls).toBe(0);
  });
});
