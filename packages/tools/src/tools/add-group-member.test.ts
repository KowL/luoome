import type { StockGroup, ToolContext } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { addGroupMemberTool } from './add-group-member.js';

const T0 = new Date('2026-07-22T00:00:00.000Z');

const seedManualGroup = async (
  ctx: ToolContext,
  overrides: Partial<StockGroup> = {},
): Promise<void> => {
  await ctx.repos.stockGroup.save({
    id: 'watch-list',
    name: '关注',
    resolver: { kind: 'manual', stockIds: ['002594.SZ'] },
    refreshPolicy: 'manual',
    enabled: true,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  });
};

describe('add_group_member', () => {
  it('happy path：把 stockId 追加到手动分组末尾，updatedAt 推进', async () => {
    const ctx = await buildTestContext();
    await seedManualGroup(ctx);
    const before = await ctx.repos.stockGroup.findById('watch-list');
    const t1 = new Date('2026-07-23T00:00:00.000Z');
    const r = await addGroupMemberTool.execute(
      { groupId: 'watch-list', stockId: '600519.SH' },
      { ...ctx, clock: () => t1 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.group.resolver).toEqual({
      kind: 'manual',
      stockIds: ['002594.SZ', '600519.SH'],
    });
    expect(r.data.group.updatedAt.getTime()).toBe(t1.getTime());
    expect(r.data.group.updatedAt.getTime()).toBeGreaterThan(before?.updatedAt.getTime() ?? 0);
    expect(r.data.addedStockId).toBe('600519.SH');
  });

  it('空成员列表也能加成员（创建时留空的场景）', async () => {
    const ctx = await buildTestContext();
    await seedManualGroup(ctx, {
      resolver: { kind: 'manual', stockIds: [] },
    });
    const r = await addGroupMemberTool.execute(
      { groupId: 'watch-list', stockId: '002594.SZ' },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.group.resolver).toEqual({ kind: 'manual', stockIds: ['002594.SZ'] });
  });

  it('非 manual 分组 → invalid_input', async () => {
    const ctx = await buildTestContext();
    await seedManualGroup(ctx, {
      id: 'formula-group',
      resolver: {
        kind: 'formula',
        tacticId: 'breakout-volume',
        lookbackDays: 7,
        minScore: 60,
      },
      refreshPolicy: 'daily',
    });
    const r = await addGroupMemberTool.execute(
      { groupId: 'formula-group', stockId: '002594.SZ' },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('重复 stockId → invalid_input，原值不变', async () => {
    const ctx = await buildTestContext();
    await seedManualGroup(ctx);
    const r = await addGroupMemberTool.execute(
      { groupId: 'watch-list', stockId: '002594.SZ' },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
    const unchanged = await ctx.repos.stockGroup.findById('watch-list');
    expect(unchanged?.resolver).toEqual({ kind: 'manual', stockIds: ['002594.SZ'] });
  });

  it('stockId 不在 stock 库（合法格式但未登记）：自动 stub 入库', async () => {
    const ctx = await buildTestContext();
    await seedManualGroup(ctx);
    const r = await addGroupMemberTool.execute(
      { groupId: 'watch-list', stockId: '999999.SH' },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.group.resolver).toEqual({
      kind: 'manual',
      stockIds: ['002594.SZ', '999999.SH'],
    });
    const stub = await ctx.repos.stock.findById('999999.SH');
    expect(stub).toMatchObject({ id: '999999.SH', code: '999999', exchange: 'SH', name: '999999' });
  });

  it('stockName 携带：自动 stub 用真实名，group 落库后端不影响 stockName', async () => {
    const ctx = await buildTestContext();
    await seedManualGroup(ctx, {
      resolver: { kind: 'manual', stockIds: [] },
    });
    const r = await addGroupMemberTool.execute(
      { groupId: 'watch-list', stockId: '999999.SH', stockName: '某新股' },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.group.resolver).toEqual({
      kind: 'manual',
      stockIds: ['999999.SH'],
    });
    const stub = await ctx.repos.stock.findById('999999.SH');
    expect(stub?.name).toBe('某新股');
  });

  it('groupId 不存在 → not_found', async () => {
    const ctx = await buildTestContext();
    const r = await addGroupMemberTool.execute({ groupId: 'missing', stockId: '002594.SZ' }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('not_found');
  });

  it('stockId 格式非法 → invalid_input（zod）', async () => {
    const ctx = await buildTestContext();
    await seedManualGroup(ctx);
    const r = await addGroupMemberTool.execute({ groupId: 'watch-list', stockId: '002594' }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });
});
