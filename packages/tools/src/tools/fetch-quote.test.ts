import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';
import { fetchQuoteTool } from './fetch-quote.js';

describe('tool/fetch_quote', () => {
  it('正常路径：Stock.id 命中 → 拉行情写库 + 返回', async () => {
    const ctx = await buildTestContext();
    const res = await fetchQuoteTool.execute({ stockId: '002594.SZ' }, ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.quote.stockId).toBe('002594.SZ');
    expect(res.data.quote.source).toBe('test');
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

  it('错误路径：stock 不存在 → not_found', async () => {
    const ctx = await buildTestContext();
    const res = await fetchQuoteTool.execute({ stockId: 'NOPE' }, ctx);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('not_found');
  });

  it('错误路径：空 stockId → invalid_input', async () => {
    const ctx = await buildTestContext();
    const res = await fetchQuoteTool.execute({ stockId: '' }, ctx);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('invalid_input');
  });
});
