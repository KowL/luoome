import type { StockGroup, ToolContext } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildMockContext } from '../context.js';
import { getStockGroupTool } from './get-stock-group.js';

const T0 = new Date('2026-07-22T00:00:00.000Z');
/** 今日（Shanghai）= 2026-07-22（UTC 01:00 → Shanghai 09:00）。 */
const NOW = new Date('2026-07-22T01:00:00.000Z');
/** 昨日（Shanghai）= 2026-07-21。 */
const YESTERDAY = new Date('2026-07-21T01:00:00.000Z');

const seedGroup = (ctx: ToolContext, id: string, overrides: Partial<StockGroup> = {}) =>
  ctx.repos.stockGroup.save({
    id,
    name: id,
    resolver: { kind: 'manual', stockIds: ['002594.SZ'] },
    refreshPolicy: 'manual',
    enabled: true,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  });

const seedSnapshot = (
  ctx: ToolContext,
  groupId: string,
  refreshId: string,
  stockIds: readonly string[],
  createdAt: Date,
) =>
  ctx.repos.groupMember.saveBatch(
    stockIds.map((stockId, i) => ({
      id: `${refreshId}-${i}`,
      groupId,
      stockId,
      refreshId,
      reason: 'test reason',
      createdAt,
    })),
  );

describe('get_stock_group', () => {
  it('id 不存在 → not_found', async () => {
    const ctx = await buildMockContext();
    const r = await getStockGroupTool.execute({ id: 'missing' }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('not_found');
  });

  it('manual 组：成员=固定列表，latestRefreshAt=null，stale=false', async () => {
    const ctx = await buildMockContext({ clock: () => NOW });
    await seedGroup(ctx, 'g-manual');
    const r = await getStockGroupTool.execute({ id: 'g-manual' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.members.map((m) => m.stockId)).toEqual(['002594.SZ']);
    expect(r.data.latestRefreshAt).toBeNull();
    expect(r.data.stale).toBe(false);
  });

  it('holdings 组：成员=活跃持仓现算，stale=false', async () => {
    const ctx = await buildMockContext({ clock: () => NOW });
    await seedGroup(ctx, 'g-holdings', {
      resolver: { kind: 'holdings', accountId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' },
    });
    const r = await getStockGroupTool.execute({ id: 'g-holdings' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.members.length).toBeGreaterThan(0);
    expect(r.data.latestRefreshAt).toBeNull();
    expect(r.data.stale).toBe(false);
  });

  it('daily formula 组无快照 → stale=true', async () => {
    const ctx = await buildMockContext({ clock: () => NOW });
    await seedGroup(ctx, 'g-f', {
      resolver: { kind: 'formula', tacticId: 'breakout-volume', lookbackDays: 5 },
      refreshPolicy: 'daily',
    });
    const r = await getStockGroupTool.execute({ id: 'g-f' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.members).toEqual([]);
    expect(r.data.latestRefreshAt).toBeNull();
    expect(r.data.stale).toBe(true);
  });

  it('daily formula 组最新批次在昨日 → stale=true；在今日 → stale=false', async () => {
    const ctx = await buildMockContext({ clock: () => NOW });
    await seedGroup(ctx, 'g-f', {
      resolver: { kind: 'formula', tacticId: 'breakout-volume', lookbackDays: 5 },
      refreshPolicy: 'daily',
    });
    await seedSnapshot(ctx, 'g-f', 'rf-old', ['002594.SZ'], YESTERDAY);
    const r1 = await getStockGroupTool.execute({ id: 'g-f' }, ctx);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.data.stale).toBe(true);
    expect(r1.data.latestRefreshAt?.toISOString()).toBe(YESTERDAY.toISOString());

    await seedSnapshot(ctx, 'g-f', 'rf-new', ['600519.SH'], NOW);
    const r2 = await getStockGroupTool.execute({ id: 'g-f' }, ctx);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.data.stale).toBe(false);
    expect(r2.data.members.map((m) => m.stockId)).toEqual(['600519.SH']);
    expect(r2.data.members[0]?.reason).toBe('test reason');
  });

  it('refreshPolicy=manual 的 formula 组：即使无快照也 stale=false', async () => {
    const ctx = await buildMockContext({ clock: () => NOW });
    await seedGroup(ctx, 'g-fm', {
      resolver: { kind: 'formula', tacticId: 'breakout-volume', lookbackDays: 5 },
      refreshPolicy: 'manual',
    });
    const r = await getStockGroupTool.execute({ id: 'g-fm' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.stale).toBe(false);
  });
});
