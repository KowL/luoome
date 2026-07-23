import { describe, expect, it } from 'vitest';

import { buildMockContext } from '../context.js';
import { listStockPoolsTool } from './list-stock-pools.js';

describe('list_stock_pools', () => {
  it('空库：enabledOnly=true 返回 total=0', async () => {
    const ctx = await buildMockContext();
    const r = await listStockPoolsTool.execute({ enabledOnly: true }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.total).toBe(0);
    expect(r.data.pools).toEqual([]);
  });

  it('种池后默认仅 enabled 返回；enabledOnly=false 全量', async () => {
    const ctx = await buildMockContext();
    await ctx.repos.stockPool.save({
      id: 'p-on',
      name: 'on',
      groupId: 'grp-manual',
      rules: [{ kind: 'price-change', pct: 0.05 }],
      cooldownMinutes: 30,
      enabled: true,
      createdAt: new Date('2026-07-21T00:00:00Z'),
      updatedAt: new Date('2026-07-21T00:00:00Z'),
    });
    await ctx.repos.stockPool.save({
      id: 'p-off',
      name: 'off',
      groupId: 'grp-manual',
      rules: [{ kind: 'price-change', pct: 0.05 }],
      cooldownMinutes: 30,
      enabled: false,
      createdAt: new Date('2026-07-21T00:00:00Z'),
      updatedAt: new Date('2026-07-21T00:00:00Z'),
    });

    const onlyEnabled = await listStockPoolsTool.execute({ enabledOnly: true }, ctx);
    expect(onlyEnabled.ok).toBe(true);
    if (!onlyEnabled.ok) return;
    expect(onlyEnabled.data.total).toBe(1);
    expect(onlyEnabled.data.pools.map((p) => p.id)).toEqual(['p-on']);

    const all = await listStockPoolsTool.execute({ enabledOnly: false }, ctx);
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.data.total).toBe(2);
  });
});
