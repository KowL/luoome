import type { ToolContext } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildMockContext } from '../context.js';
import { deleteStockGroupTool } from './delete-stock-group.js';

const T0 = new Date('2026-07-22T00:00:00.000Z');

const seedGroup = (ctx: ToolContext, id = 'grp-1') =>
  ctx.repos.stockGroup.save({
    id,
    name: id,
    resolver: { kind: 'manual', stockIds: ['002594.SZ'] },
    refreshPolicy: 'manual',
    enabled: true,
    createdAt: T0,
    updatedAt: T0,
  });

describe('delete_stock_group', () => {
  it('无 pool 引用 → 删除成功', async () => {
    const ctx = await buildMockContext();
    await seedGroup(ctx);
    const r = await deleteStockGroupTool.execute({ id: 'grp-1' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.removed).toBe(true);
    expect(await ctx.repos.stockGroup.findById('grp-1')).toBeNull();
  });

  it('有 pool 引用 → invariant_violation（提示先解绑）', async () => {
    const ctx = await buildMockContext();
    await seedGroup(ctx);
    await ctx.repos.stockPool.save({
      id: 'pool-1',
      name: 'p',
      groupId: 'grp-1',
      rules: [{ kind: 'price-change', pct: 0.05 }],
      cooldownMinutes: 30,
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });
    const r = await deleteStockGroupTool.execute({ id: 'grp-1' }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invariant_violation');
    if (r.error.kind === 'invariant_violation') {
      expect(r.error.message).toContain('pool-1');
    }
    // 分组未被删除
    expect(await ctx.repos.stockGroup.findById('grp-1')).not.toBeNull();
  });

  it('id 不存在 → not_found', async () => {
    const ctx = await buildMockContext();
    const r = await deleteStockGroupTool.execute({ id: 'missing' }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('not_found');
  });
});
