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

  it('v0.8：mock ctx 走 adapter 外部搜索（source=market）', async () => {
    const ctx = await buildTestContext();
    const res = await searchStocksTool.execute({ query: '0025' }, ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.source).toBe('market');
    expect(res.data.stocks[0]?.id).toBe('002594.SZ');
  });

  it('v0.8：adapter 抛错 → 降级本地库（source=local）', async () => {
    const ctx = await buildTestContext();
    const brokenMarket: MarketDataAdapterLike = {
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
    expect(res.data.source).toBe('local');
    expect(res.data.stocks[0]?.id).toBe('002594.SZ');
  });

  it('v0.8：adapter 未实现 searchStocks → 本地库（source=local）', async () => {
    const ctx = await buildTestContext();
    const noSearchMarket: MarketDataAdapterLike = {
      name: 'no-search',
      fetchQuote: () => Promise.reject(new Error('not used')),
      batchQuote: () => Promise.reject(new Error('not used')),
      fetchDailyBars: () => Promise.reject(new Error('not used')),
    };
    const res = await searchStocksTool.execute(
      { query: '茅台' },
      { ...ctx, adapters: { ...ctx.adapters, market: noSearchMarket } },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.source).toBe('local');
    expect(res.data.stocks[0]?.id).toBe('600519.SH');
  });
});
