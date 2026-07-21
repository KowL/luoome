import { describe, expect, it } from 'vitest';

import { buildMockContext } from '../context.js';
import { createStockPoolTool } from './create-stock-pool.js';
import { deleteStockPoolTool } from './delete-stock-pool.js';

describe('delete_stock_pool', () => {
  it('删除已存在池 → removed=true', async () => {
    const ctx = await buildMockContext();
    await createStockPoolTool.execute(
      {
        id: 'p-del',
        name: 'x',
        source: { kind: 'manual', stockIds: ['002594.SZ'] },
        rules: [{ kind: 'price-change', pct: 0.05 }],
      },
      ctx,
    );
    const r = await deleteStockPoolTool.execute({ id: 'p-del' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.removed).toBe(true);
    expect(await ctx.repos.stockPool.findById('p-del')).toBeNull();
  });

  it('池不存在 → not_found', async () => {
    const ctx = await buildMockContext();
    const r = await deleteStockPoolTool.execute({ id: 'missing' }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('not_found');
  });
});
