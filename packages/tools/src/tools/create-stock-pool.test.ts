import type { GroupResolver, ToolContext } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { createStockPoolTool } from './create-stock-pool.js';

const T0 = new Date('2026-07-22T00:00:00.000Z');

/** 种一个分组（默认 manual 002594.SZ），返回 groupId。 */
const seedGroup = async (
  ctx: ToolContext,
  id = 'grp-manual',
  resolver: GroupResolver = { kind: 'manual', stockIds: ['002594.SZ'] },
): Promise<string> => {
  await ctx.repos.stockGroup.save({
    id,
    name: id,
    resolver,
    refreshPolicy: 'manual',
    enabled: true,
    createdAt: T0,
    updatedAt: T0,
  });
  return id;
};

describe('create_stock_pool', () => {
  it('引用已存在分组建池：合法路径 → 落库 + 字段一致', async () => {
    const ctx = await buildTestContext();
    const groupId = await seedGroup(ctx);
    const r = await createStockPoolTool.execute(
      {
        id: 'manual-pool',
        name: '手动池',
        groupId,
        rules: [{ kind: 'price-change', pct: 0.05 }],
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.pool.id).toBe('manual-pool');
    expect(r.data.pool.groupId).toBe(groupId);
    expect(r.data.pool.enabled).toBe(true);
    expect(r.data.pool.cooldownMinutes).toBe(30);

    const found = await ctx.repos.stockPool.findById('manual-pool');
    expect(found?.id).toBe('manual-pool');
  });

  it('同 id 重复 → invalid_input', async () => {
    const ctx = await buildTestContext();
    const groupId = await seedGroup(ctx);
    const input = {
      id: 'dup',
      name: 'x',
      groupId,
      rules: [{ kind: 'price-change', pct: 0.05 }],
    };
    await createStockPoolTool.execute(input, ctx);
    const r2 = await createStockPoolTool.execute(input, ctx);
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.kind).toBe('invalid_input');
  });

  it('groupId 引用的分组不存在 → not_found', async () => {
    const ctx = await buildTestContext();
    const r = await createStockPoolTool.execute(
      {
        id: 'g-bad',
        name: 'x',
        groupId: 'no-such-group',
        rules: [{ kind: 'price-change', pct: 0.05 }],
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('not_found');
  });

  it('tactic 规则引用不存在的 tactic → not_found', async () => {
    const ctx = await buildTestContext();
    const groupId = await seedGroup(ctx);
    const r = await createStockPoolTool.execute(
      {
        id: 't-bad',
        name: 'x',
        groupId,
        rules: [{ kind: 'tactic', tacticId: 'no-such', minScore: 60 }],
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('not_found');
  });

  it('id 含大写 → invalid_input（zod parse）', async () => {
    const ctx = await buildTestContext();
    const groupId = await seedGroup(ctx);
    const r = await createStockPoolTool.execute(
      {
        id: 'BadID',
        name: 'x',
        groupId,
        rules: [{ kind: 'price-change', pct: 0.05 }],
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('rules 为空 → invalid_input', async () => {
    const ctx = await buildTestContext();
    const groupId = await seedGroup(ctx);
    const r = await createStockPoolTool.execute(
      {
        id: 'no-rules',
        name: 'x',
        groupId,
        rules: [],
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('formula 分组 + tactic 规则 tacticId 不一致 → invalid_input（阶段 B 跨实体不变量）', async () => {
    const ctx = await buildTestContext();
    const groupId = await seedGroup(ctx, 'grp-formula', {
      kind: 'formula',
      tacticId: 'breakout-volume',
      lookbackDays: 5,
    });
    const r = await createStockPoolTool.execute(
      {
        id: 'mismatch-pool',
        name: 'x',
        groupId,
        rules: [{ kind: 'tactic', tacticId: 'ma-bullish-alignment', minScore: 60 }],
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('formula 分组 + tactic 规则 tacticId 一致 → 合法', async () => {
    const ctx = await buildTestContext();
    const groupId = await seedGroup(ctx, 'grp-formula', {
      kind: 'formula',
      tacticId: 'breakout-volume',
      lookbackDays: 5,
    });
    const r = await createStockPoolTool.execute(
      {
        id: 'match-pool',
        name: 'x',
        groupId,
        rules: [{ kind: 'tactic', tacticId: 'breakout-volume', minScore: 60 }],
      },
      ctx,
    );
    expect(r.ok).toBe(true);
  });
});
