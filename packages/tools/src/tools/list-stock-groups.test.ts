import type { StockGroup, ToolContext } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildMockContext } from '../context.js';
import { listStockGroupsTool } from './list-stock-groups.js';

const T0 = new Date('2026-07-22T00:00:00.000Z');

const seedGroup = (ctx: ToolContext, id: string, overrides: Partial<StockGroup> = {}) =>
  ctx.repos.stockGroup.save({
    id,
    name: id,
    resolver: { kind: 'manual', stockIds: ['002594.SZ', '600519.SH'] },
    refreshPolicy: 'manual',
    enabled: true,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  });

describe('list_stock_groups', () => {
  it('默认返回全部（按 id 升序）；enabledOnly=true 仅 enabled', async () => {
    const ctx = await buildMockContext();
    await seedGroup(ctx, 'g-b', { enabled: false });
    await seedGroup(ctx, 'g-a');
    const r = await listStockGroupsTool.execute({}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.groups.map((g) => g.group.id)).toEqual(['g-a', 'g-b']);
    expect(r.data.total).toBe(2);
    expect(r.data.groups[0]?.memberCount).toBeUndefined();

    const r2 = await listStockGroupsTool.execute({ enabledOnly: true }, ctx);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.data.groups.map((g) => g.group.id)).toEqual(['g-a']);
  });

  it('includeMemberCount=true：manual 组 = stockIds 长度', async () => {
    const ctx = await buildMockContext();
    await seedGroup(ctx, 'g-manual');
    const r = await listStockGroupsTool.execute({ includeMemberCount: true }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.groups[0]?.memberCount).toBe(2);
  });

  it('includeMemberCount=true：formula 组 = 最新快照批成员数', async () => {
    const ctx = await buildMockContext();
    await seedGroup(ctx, 'g-formula', {
      resolver: { kind: 'formula', tacticId: 'breakout-volume', lookbackDays: 5 },
    });
    await ctx.repos.groupMember.saveBatch([
      {
        id: 's-1',
        groupId: 'g-formula',
        stockId: '002594.SZ',
        refreshId: 'rf-1',
        reason: 'r',
        createdAt: T0,
      },
    ]);
    const r = await listStockGroupsTool.execute({ includeMemberCount: true }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.groups[0]?.memberCount).toBe(1);
  });

  it('includeMemberCount=true：holdings 组 = 活跃持仓数（mock 种子 6 个活跃持仓）', async () => {
    const ctx = await buildMockContext();
    await seedGroup(ctx, 'g-holdings', {
      resolver: { kind: 'holdings', accountId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' },
    });
    const r = await listStockGroupsTool.execute({ includeMemberCount: true }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.groups[0]?.memberCount).toBeGreaterThan(0);
  });
});
