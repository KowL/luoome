import { describe, expect, it } from 'vitest';

import { buildMockContext } from '../context.js';
import { createStockPoolTool } from './create-stock-pool.js';
import { updateStockPoolTool } from './update-stock-pool.js';

const seedPool = async (ctx: Awaited<ReturnType<typeof buildMockContext>>) => {
  await createStockPoolTool.execute(
    {
      id: 'p-1',
      name: '原名',
      source: { kind: 'manual', stockIds: ['002594.SZ'] },
      rules: [{ kind: 'price-change', pct: 0.05 }],
    },
    ctx,
  );
};

describe('update_stock_pool', () => {
  it('改 name + enabled：未传字段保持原值', async () => {
    const ctx = await buildMockContext();
    await seedPool(ctx);
    const r = await updateStockPoolTool.execute({ id: 'p-1', name: '新名', enabled: false }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.pool.name).toBe('新名');
    expect(r.data.pool.enabled).toBe(false);
    // rules / source / cooldownMinutes 不变
    expect(r.data.pool.rules).toHaveLength(1);
    expect(r.data.pool.cooldownMinutes).toBe(30);
  });

  it('池不存在 → not_found', async () => {
    const ctx = await buildMockContext();
    const r = await updateStockPoolTool.execute({ id: 'missing', name: 'x' }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('not_found');
  });

  it('description=null 清空 description', async () => {
    const ctx = await buildMockContext();
    await createStockPoolTool.execute(
      {
        id: 'p-d',
        name: 'd',
        description: 'old',
        source: { kind: 'manual', stockIds: ['002594.SZ'] },
        rules: [{ kind: 'price-change', pct: 0.05 }],
      },
      ctx,
    );
    const r = await updateStockPoolTool.execute({ id: 'p-d', description: null }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.pool.description).toBeUndefined();
  });

  it('换 holdings source 到不存在的 account → not_found', async () => {
    const ctx = await buildMockContext();
    await seedPool(ctx);
    const r = await updateStockPoolTool.execute(
      { id: 'p-1', source: { kind: 'holdings', accountId: 'no-such' } },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('not_found');
  });
});
