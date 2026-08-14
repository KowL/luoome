import { money, type Quote } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';
import { batchQuoteTool } from './batch-quote.js';

describe('tool/batch_quote', () => {
  it('正常路径：批量拉 + 写库 + 返回 quotes + unresolved 列表', async () => {
    const ctx = await buildTestContext();
    const res = await batchQuoteTool.execute({ stockIds: ['002594.SZ', '600519.SH', 'NOPE'] }, ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.quotes).toHaveLength(2);
    expect(res.data.unresolved).toEqual(['NOPE']);
    // 名称随 ok 项返回，聚合页不再二次解析
    expect(res.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stockId: '600519.SH', status: 'ok', stockName: '贵州茅台' }),
        expect.objectContaining({ stockId: '002594.SZ', status: 'ok', stockName: '比亚迪' }),
      ]),
    );
    // 两条都落库
    expect(await ctx.repos.quote.latestByStock('002594.SZ')).not.toBeNull();
    expect(await ctx.repos.quote.latestByStock('600519.SH')).not.toBeNull();
  });

  it('上游对某标的返回空 → 回落 DB 内最近一次 quote_snapshot', async () => {
    const ctx = await buildTestContext();
    const cachedQuote: Quote = {
      stockId: '002594.SZ',
      observedAt: new Date('2026-07-21T02:30:00.000Z'),
      fetchedAt: new Date('2026-07-21T02:30:00.000Z'),
      timestampSource: 'retrieval',
      ts: new Date('2026-07-21T02:30:00.000Z'),
      open: money(100),
      high: money(101),
      low: money(99),
      close: money(100.5),
      volume: 1234,
      source: 'eastmoney',
    };
    await ctx.repos.quote.save(cachedQuote);
    // 替换 market adapter：002594 缺席、600519 正常
    const liveQuote: Quote = {
      stockId: '600519.SH',
      observedAt: new Date('2026-07-21T02:30:00.000Z'),
      fetchedAt: new Date('2026-07-21T02:30:00.000Z'),
      timestampSource: 'retrieval',
      ts: new Date('2026-07-21T02:30:00.000Z'),
      open: money(200),
      high: money(201),
      low: money(199),
      close: money(200.5),
      volume: 5678,
      source: 'eastmoney',
    };
    const flakyAdapter = {
      ...ctx.adapters.market,
      name: 'flaky-test',
      async batchQuote(codes: readonly string[]): Promise<Map<string, Quote>> {
        const m = new Map<string, Quote>();
        for (const c of codes) if (c === '600519.SH') m.set(c, liveQuote);
        return m;
      },
      async fetchQuote(code: string): Promise<Quote> {
        if (code === '600519.SH') return liveQuote;
        throw new Error('upstream dropped connection');
      },
      fetchDailyBars(): Promise<never[]> {
        return Promise.resolve([]);
      },
    };
    const ctxWithFlaky = { ...ctx, adapters: { ...ctx.adapters, market: flakyAdapter } };
    const res = await batchQuoteTool.execute(
      { stockIds: ['002594.SZ', '600519.SH'] },
      ctxWithFlaky,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const byStock = new Map(res.data.quotes.map((q) => [q.stockId, q]));
    expect(byStock.get('600519.SH')?.close).toBe(200.5);
    expect(byStock.get('002594.SZ')?.close).toBe(100.5);
    expect(res.data.unresolved).toEqual([]);
    expect(res.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stockId: '600519.SH',
          status: 'ok',
          retrieval: 'live',
        }),
        expect.objectContaining({
          stockId: '002594.SZ',
          status: 'ok',
          retrieval: 'local-fallback',
          freshness: 'stale',
        }),
      ]),
    );
  });

  it('intraday-rule 拒绝跨交易日的本地快照，不混入 quotes', async () => {
    const now = new Date('2026-07-22T02:30:00.000Z');
    const ctx = await buildTestContext({ clock: () => now });
    await ctx.repos.quote.save({
      stockId: '002594.SZ',
      observedAt: new Date('2026-07-21T06:59:00.000Z'),
      fetchedAt: new Date('2026-07-21T06:59:00.000Z'),
      timestampSource: 'retrieval',
      ts: new Date('2026-07-21T06:59:00.000Z'),
      open: money(100),
      high: money(101),
      low: money(99),
      close: money(100),
      volume: 100,
      source: 'cached',
    });
    const emptyAdapter = {
      ...ctx.adapters.market,
      name: 'empty-test',
      batchQuote: (): Promise<Map<string, Quote>> => Promise.resolve(new Map()),
    };
    const result = await batchQuoteTool.execute(
      { stockIds: ['002594.SZ'], context: 'intraday-rule', watchIntervalSeconds: 60 },
      { ...ctx, adapters: { ...ctx.adapters, market: emptyAdapter } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.quotes).toEqual([]);
    expect(result.data.items).toEqual([
      {
        stockId: '002594.SZ',
        status: 'unavailable',
        reason: 'quote_not_current_trading_day',
      },
    ]);
  });

  it('intraday-rule accepts a live quote observed just after the request started', async () => {
    const requestStartedAt = new Date('2026-07-22T02:30:00.000Z');
    const nextTick = new Date(requestStartedAt.getTime() + 1);
    let clockCalls = 0;
    const base = await buildTestContext();
    const ctx = {
      ...base,
      clock: () => (clockCalls++ === 0 ? requestStartedAt : nextTick),
    };
    const quote = (observedAt: Date): Quote => ({
      stockId: '002594.SZ',
      observedAt,
      fetchedAt: observedAt,
      timestampSource: 'retrieval',
      ts: observedAt,
      open: money(100),
      high: money(101),
      low: money(99),
      close: money(100.5),
      volume: 1234,
      source: 'live-test',
    });
    const market = {
      ...ctx.adapters.market,
      batchQuote: (): Promise<Map<string, Quote>> => {
        const liveQuote = quote(ctx.clock());
        return Promise.resolve(new Map([[liveQuote.stockId, liveQuote]]));
      },
    };

    const result = await batchQuoteTool.execute(
      { stockIds: ['002594.SZ'], context: 'intraday-rule' },
      { ...ctx, adapters: { ...ctx.adapters, market } },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items).toEqual([
      expect.objectContaining({ stockId: '002594.SZ', status: 'ok', freshness: 'fresh' }),
    ]);
  });

  it('错误路径：stockIds 为空 → invalid_input', async () => {
    const ctx = await buildTestContext();
    const res = await batchQuoteTool.execute({ stockIds: [] }, ctx);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('invalid_input');
  });

  it('错误路径：超过 100 个 → invalid_input', async () => {
    const ctx = await buildTestContext();
    const res = await batchQuoteTool.execute(
      { stockIds: Array.from({ length: 101 }, (_, i) => `X${i}`) },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('invalid_input');
  });
});
