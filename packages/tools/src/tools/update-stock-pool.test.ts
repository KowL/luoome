import type { ToolContext } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { createStockPoolTool } from './create-stock-pool.js';
import { updateStockPoolTool } from './update-stock-pool.js';

const T0 = new Date('2026-07-22T00:00:00.000Z');

const seedGroup = async (ctx: ToolContext, id: string): Promise<string> => {
  await ctx.repos.stockGroup.save({
    id,
    name: id,
    resolver: { kind: 'manual', stockIds: ['002594.SZ'] },
    refreshPolicy: 'manual',
    enabled: true,
    createdAt: T0,
    updatedAt: T0,
  });
  return id;
};

const seedPool = async (ctx: Awaited<ReturnType<typeof buildTestContext>>) => {
  const groupId = await seedGroup(ctx, 'grp-manual');
  await createStockPoolTool.execute(
    {
      id: 'p-1',
      name: '原名',
      groupId,
      rules: [{ kind: 'price-change', pct: 0.05 }],
    },
    ctx,
  );
};

describe('update_stock_pool', () => {
  it('改 name + enabled：未传字段保持原值', async () => {
    const ctx = await buildTestContext();
    await seedPool(ctx);
    const r = await updateStockPoolTool.execute({ id: 'p-1', name: '新名', enabled: false }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.pool.name).toBe('新名');
    expect(r.data.pool.enabled).toBe(false);
    // rules / groupId / cooldownMinutes 不变
    expect(r.data.pool.rules).toHaveLength(1);
    expect(r.data.pool.groupId).toBe('grp-manual');
    expect(r.data.pool.cooldownMinutes).toBe(30);
  });

  it('池不存在 → not_found', async () => {
    const ctx = await buildTestContext();
    const r = await updateStockPoolTool.execute({ id: 'missing', name: 'x' }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('not_found');
  });

  it('description=null 清空 description', async () => {
    const ctx = await buildTestContext();
    const groupId = await seedGroup(ctx, 'grp-manual');
    await createStockPoolTool.execute(
      {
        id: 'p-d',
        name: 'd',
        description: 'old',
        groupId,
        rules: [{ kind: 'price-change', pct: 0.05 }],
      },
      ctx,
    );
    const r = await updateStockPoolTool.execute({ id: 'p-d', description: null }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.pool.description).toBeUndefined();
  });

  it('换绑到不存在的分组 → not_found', async () => {
    const ctx = await buildTestContext();
    await seedPool(ctx);
    const r = await updateStockPoolTool.execute({ id: 'p-1', groupId: 'no-such-group' }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('not_found');
  });

  it('换绑到已存在的分组 → groupId 更新', async () => {
    const ctx = await buildTestContext();
    await seedPool(ctx);
    await seedGroup(ctx, 'grp-other');
    const r = await updateStockPoolTool.execute({ id: 'p-1', groupId: 'grp-other' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.pool.groupId).toBe('grp-other');
  });

  it('merged 后分组为 formula 且 tactic 规则不一致 → invalid_input（阶段 B 跨实体不变量）', async () => {
    const ctx = await buildTestContext();
    await ctx.repos.stockGroup.save({
      id: 'grp-formula',
      name: 'f',
      resolver: { kind: 'formula', tacticId: 'breakout-volume', lookbackDays: 5 },
      refreshPolicy: 'daily',
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });
    await createStockPoolTool.execute(
      {
        id: 'p-f',
        name: 'f',
        groupId: 'grp-formula',
        rules: [{ kind: 'tactic', tacticId: 'breakout-volume', minScore: 60 }],
      },
      ctx,
    );
    const r = await updateStockPoolTool.execute(
      {
        id: 'p-f',
        rules: [{ kind: 'tactic', tacticId: 'ma-bullish-alignment', minScore: 60 }],
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });
});
