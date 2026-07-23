import { describe, expect, it } from 'vitest';

import { buildMockContext } from '../context.js';
import { createStockPoolTool } from './create-stock-pool.js';
import { deleteStockPoolTool } from './delete-stock-pool.js';

describe('delete_stock_pool', () => {
  it('删除已存在池 → removed=true', async () => {
    const ctx = await buildMockContext();
    await ctx.repos.stockGroup.save({
      id: 'grp-manual',
      name: 'grp-manual',
      resolver: { kind: 'manual', stockIds: ['002594.SZ'] },
      refreshPolicy: 'manual',
      enabled: true,
      createdAt: new Date('2026-07-22T00:00:00Z'),
      updatedAt: new Date('2026-07-22T00:00:00Z'),
    });
    await createStockPoolTool.execute(
      {
        id: 'p-del',
        name: 'x',
        groupId: 'grp-manual',
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
