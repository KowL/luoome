import type { StockGroup, ToolContext } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { updateStockGroupTool } from './update-stock-group.js';

const T0 = new Date('2026-07-22T00:00:00.000Z');

const seedGroup = (ctx: ToolContext, overrides: Partial<StockGroup> = {}) =>
  ctx.repos.stockGroup.save({
    id: 'grp-1',
    name: '分组一',
    description: '旧描述',
    resolver: { kind: 'manual', stockIds: ['002594.SZ'] },
    refreshPolicy: 'manual',
    enabled: true,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  });

describe('update_stock_group', () => {
  it('改 name / description：只改传入字段，其余保持', async () => {
    const ctx = await buildTestContext();
    await seedGroup(ctx);
    const r = await updateStockGroupTool.execute({ id: 'grp-1', name: '新名' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.group.name).toBe('新名');
    expect(r.data.group.description).toBe('旧描述');
    expect(r.data.group.resolver).toEqual({ kind: 'manual', stockIds: ['002594.SZ'] });
  });

  it('description=null 清空描述', async () => {
    const ctx = await buildTestContext();
    await seedGroup(ctx);
    const r = await updateStockGroupTool.execute({ id: 'grp-1', description: null }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.group.description).toBeUndefined();
  });

  it('改 resolver：合法引用 → 落库', async () => {
    const ctx = await buildTestContext();
    await seedGroup(ctx);
    const r = await updateStockGroupTool.execute(
      {
        id: 'grp-1',
        resolver: { kind: 'formula', tacticId: 'breakout-volume', lookbackDays: 10 },
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.group.resolver.kind).toBe('formula');
  });

  it('改 resolver：tactic 不存在 → not_found，原值不变', async () => {
    const ctx = await buildTestContext();
    await seedGroup(ctx);
    const r = await updateStockGroupTool.execute(
      { id: 'grp-1', resolver: { kind: 'formula', tacticId: 'nope', lookbackDays: 10 } },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('not_found');
    const unchanged = await ctx.repos.stockGroup.findById('grp-1');
    expect(unchanged?.resolver.kind).toBe('manual');
  });

  it('改 refreshPolicy / enabled', async () => {
    const ctx = await buildTestContext();
    await seedGroup(ctx);
    const r = await updateStockGroupTool.execute(
      { id: 'grp-1', refreshPolicy: 'daily', enabled: false },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.group.refreshPolicy).toBe('daily');
    expect(r.data.group.enabled).toBe(false);
  });

  it('id 不存在 → not_found', async () => {
    const ctx = await buildTestContext();
    const r = await updateStockGroupTool.execute({ id: 'missing', name: 'x' }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('not_found');
  });
});
