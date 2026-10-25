import { money } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';
import { fetchQuoteTool } from './fetch-quote.js';

describe('tool/fetch_quote', () => {
  it('正常路径：Stock.id 命中 → 拉行情写库 + 返回', async () => {
    const ctx = await buildTestContext({ clock: () => new Date('2026-10-25T04:00:00Z') });
    const res = await fetchQuoteTool.execute({ stockId: '002594.SZ' }, ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.quote.stockId).toBe('002594.SZ');
    expect(res.data.quote.source).toBe('test');
    expect(res.data.retrieval).toBe('live');
    expect(res.data.freshness).toBe('fresh');
    // 写库后能查到
    const latest = await ctx.repos.quote.latestByStock('002594.SZ');
    expect(latest?.close).toBe(res.data.quote.close);
  });

  it('正常路径：纯代码也能命中 fixture', async () => {
    const ctx = await buildTestContext();
    const res = await fetchQuoteTool.execute({ stockId: '002594' }, ctx);
    expect(res.ok).toBe(true);
  });

  it('完整 stockId 尚未入库时自动登记名称，再拉行情', async () => {
    const ctx = await buildTestContext();
    const res = await fetchQuoteTool.execute({ stockId: '601398.SH', stockName: '工商银行' }, ctx);
    expect(res.ok).toBe(true);
    expect((await ctx.repos.stock.findById('601398.SH'))?.name).toBe('工商银行');
  });

  it('上游失败回退本地最近快照', async () => {
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
      batchQuote: () => Promise.reject(new Error('upstream down')),
    };
    const res = await fetchQuoteTool.execute(
      { stockId: '002594.SZ' },
      { ...ctx, adapters: { ...ctx.adapters, market } },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.quote.close).toBe(100.5);
    expect(res.data.quote.source).toBe('cached');
    expect(res.data.retrieval).toBe('local-fallback');
    expect(res.data.quote.observedAt).toEqual(now);
  });

  it('错误路径：stock 不存在 → not_found', async () => {
    const ctx = await buildTestContext();
    const res = await fetchQuoteTool.execute({ stockId: 'NOPE' }, ctx);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('not_found');
  });

  it('reports stale fallback provenance without refreshing the observation time', async () => {
    const ctx = await buildTestContext();
    const at = new Date(ctx.clock().getTime() - 86_400_000);
    await ctx.repos.quote.save({
      stockId: '002594.SZ',
      ts: at,
      observedAt: at,
      fetchedAt: at,
      timestampSource: 'upstream',
      open: money(100),
      high: money(101),
      low: money(99),
      close: money(100),
      volume: 1000,
      source: 'cached',
    });
    const market = {
      ...ctx.adapters.market,
      fetchQuote: () => Promise.reject(new Error('offline')),
    };
    const result = await fetchQuoteTool.execute(
      { stockId: '002594.SZ' },
      { ...ctx, adapters: { ...ctx.adapters, market } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ retrieval: 'local-fallback', freshness: 'stale' });
    expect(result.data.quote.observedAt).toEqual(at);
    expect(result.data.quote.fetchedAt).toEqual(at);
  });

  it('错误路径：空 stockId → invalid_input', async () => {
    const ctx = await buildTestContext();
    const res = await fetchQuoteTool.execute({ stockId: '' }, ctx);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('invalid_input');
  });
});
