import { money, type Quote, stockCode } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { resolveQuote, resolveQuotes } from './resolve-quotes.js';

describe('internal/resolveQuotes', () => {
  it('实时拉取落库；解析失败的 stockId 记 unresolved', async () => {
    const ctx = await buildTestContext();
    const items = await resolveQuotes(ctx, ['002594.SZ', 'NOPE'], { context: 'display' });
    expect(items).toEqual([
      { stockId: 'NOPE', status: 'unresolved', reason: 'stock_not_found' },
      expect.objectContaining({ stockId: '002594.SZ', status: 'ok', retrieval: 'live' }),
    ]);
    expect(await ctx.repos.quote.latestByStock('002594.SZ')).not.toBeNull();
  });

  it('单只股票走 fetchQuote，保留详情估值字段而不经过批量快照', async () => {
    const ctx = await buildTestContext();
    const now = ctx.clock();
    const market = {
      ...ctx.adapters.market,
      fetchQuote: (): Promise<Quote> =>
        Promise.resolve({
          stockId: '002594.SZ',
          observedAt: now,
          fetchedAt: now,
          timestampSource: 'retrieval',
          ts: now,
          open: money(100),
          high: money(101),
          low: money(99),
          close: money(100.5),
          volume: 1234,
          totalMarketCap: 200_000_000_000,
          peTtm: 19.6,
          psTtm: 2.7,
          pb: 3.8,
          source: 'eastmoney',
        }),
      batchQuote: (): Promise<Map<string, Quote>> => Promise.reject(new Error('not expected')),
    };
    const item = await resolveQuote(
      { ...ctx, adapters: { ...ctx.adapters, market } },
      '002594.SZ',
      { context: 'display' },
    );
    expect(item).toMatchObject({
      status: 'ok',
      retrieval: 'live',
      quote: { totalMarketCap: 200_000_000_000, peTtm: 19.6, psTtm: 2.7, pb: 3.8 },
    });
  });

  it('实时缺席回退本地最近快照（local-fallback）', async () => {
    const ctx = await buildTestContext();
    const now = ctx.clock();
    const cached: Quote = {
      stockId: '002594.SZ',
      observedAt: now,
      fetchedAt: now,
      timestampSource: 'upstream',
      ts: now,
      open: money(100),
      high: money(101),
      low: money(99),
      close: money(100.5),
      volume: 1234,
      source: 'cached',
    };
    await ctx.repos.quote.save(cached);
    const market = {
      ...ctx.adapters.market,
      batchQuote: (): Promise<Map<string, Quote>> => Promise.resolve(new Map()),
    };
    const items = await resolveQuotes(
      { ...ctx, adapters: { ...ctx.adapters, market } },
      ['002594.SZ', '600519.SH'],
      { context: 'display' },
    );
    expect(items).toEqual([
      expect.objectContaining({
        stockId: '002594.SZ',
        status: 'ok',
        retrieval: 'local-fallback',
        quote: expect.objectContaining({ close: 100.5 }),
      }),
      { stockId: '600519.SH', status: 'unavailable', reason: 'quote_unavailable' },
    ]);
  });

  it('实时整批抛错不向上传播，回退本地快照', async () => {
    const ctx = await buildTestContext();
    const now = ctx.clock();
    await ctx.repos.quote.save({
      stockId: '002594.SZ',
      observedAt: now,
      fetchedAt: now,
      timestampSource: 'upstream',
      ts: now,
      open: money(100),
      high: money(101),
      low: money(99),
      close: money(100.5),
      volume: 1234,
      source: 'cached',
    });
    const market = {
      ...ctx.adapters.market,
      batchQuote: (): Promise<Map<string, Quote>> => Promise.reject(new Error('upstream down')),
    };
    const items = await resolveQuotes(
      { ...ctx, adapters: { ...ctx.adapters, market } },
      ['002594.SZ', '600519.SH'],
      { context: 'display' },
    );
    expect(items).toEqual([
      expect.objectContaining({
        stockId: '002594.SZ',
        status: 'ok',
        retrieval: 'local-fallback',
        quote: expect.objectContaining({ close: 100.5 }),
      }),
      { stockId: '600519.SH', status: 'unavailable', reason: 'quote_unavailable' },
    ]);
  });

  it('超过 100 只时按 chunk 分批拉取', async () => {
    const ctx = await buildTestContext();
    const stockIds = Array.from({ length: 150 }, (_, i) => `T${i}.SZ`);
    for (const id of stockIds) {
      await ctx.repos.stock.save({
        id,
        code: stockCode(id.slice(0, -3)),
        exchange: 'SZ',
        name: `测试${id}`,
      });
    }
    const sizes: number[] = [];
    const market = {
      ...ctx.adapters.market,
      batchQuote: (codes: readonly string[]): Promise<Map<string, Quote>> => {
        sizes.push(codes.length);
        return Promise.resolve(new Map());
      },
    };
    const items = await resolveQuotes({ ...ctx, adapters: { ...ctx.adapters, market } }, stockIds, {
      context: 'display',
    });
    expect(sizes).toEqual([100, 50]);
    expect(items.every((item) => item.status === 'unavailable')).toBe(true);
  });
});
