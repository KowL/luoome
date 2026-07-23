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
