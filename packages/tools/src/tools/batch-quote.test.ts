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
    // 两条都落库
    expect(await ctx.repos.quote.latestByStock('002594.SZ')).not.toBeNull();
    expect(await ctx.repos.quote.latestByStock('600519.SH')).not.toBeNull();
  });

  it('上游对某标的返回空 → 回落 DB 内最近一次 quote_snapshot', async () => {
    const ctx = await buildTestContext();
    const cachedQuote: Quote = {
      stockId: '002594.SZ',
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
      ts: new Date('2026-07-21T02:30:00.000Z'),
      open: money(200),
      high: money(201),
      low: money(199),
      close: money(200.5),
      volume: 5678,
      source: 'eastmoney',
    };
    const flakyAdapter = {
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
