import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { listWatchPlansTool } from './list-watch-plans.js';

const T0 = new Date('2026-07-24T00:00:00.000Z');

describe('list_watch_plans', () => {
  it('返回盯盘方案及其分组名称、成员数和 ready 状态', async () => {
    const ctx = await buildTestContext();
    await ctx.repos.stockGroup.save({
      id: 'core-holdings',
      name: '核心持仓',
      resolver: { kind: 'manual', stockIds: ['002594.SZ'] },
      refreshPolicy: 'manual',
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });
    await ctx.repos.stockPool.save({
      id: 'risk-watch',
      name: '持仓风控',
      groupId: 'core-holdings',
      rules: [{ kind: 'price-change', pct: 0.05 }],
      cooldownMinutes: 30,
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });

    const result = await listWatchPlansTool.execute({ enabledOnly: false }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.plans).toHaveLength(1);
    expect(result.data.plans[0]).toMatchObject({
      group: { id: 'core-holdings', name: '核心持仓' },
      memberCount: 1,
      state: 'ready',
    });
  });

  it('daily 动态分组没有今日快照时标记 stale', async () => {
    const ctx = await buildTestContext({ clock: () => new Date('2026-07-24T02:00:00.000Z') });
    await ctx.repos.stockGroup.save({
      id: 'leaders',
      name: '今日龙头',
      resolver: { kind: 'formula', tacticId: 'breakout-volume', lookbackDays: 5 },
      refreshPolicy: 'daily',
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });
    await ctx.repos.stockPool.save({
      id: 'leader-watch',
      name: '龙头监控',
      groupId: 'leaders',
      rules: [{ kind: 'price-change', pct: 0.05 }],
      cooldownMinutes: 30,
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });

    const result = await listWatchPlansTool.execute({ enabledOnly: false }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.plans[0]?.state).toBe('stale');
  });

  it('引用停用分组时标记 group-disabled', async () => {
    const ctx = await buildTestContext();
    await ctx.repos.stockGroup.save({
      id: 'paused-group',
      name: '暂停使用',
      resolver: { kind: 'manual', stockIds: ['002594.SZ'] },
      refreshPolicy: 'manual',
      enabled: false,
      createdAt: T0,
      updatedAt: T0,
    });
    await ctx.repos.stockPool.save({
      id: 'paused-watch',
      name: '暂停分组监控',
      groupId: 'paused-group',
      rules: [{ kind: 'price-change', pct: 0.05 }],
      cooldownMinutes: 30,
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });

    const result = await listWatchPlansTool.execute({ enabledOnly: false }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.plans[0]?.state).toBe('group-disabled');
  });

  it('分组可用但没有成员时标记 empty', async () => {
    const ctx = await buildTestContext();
    await ctx.repos.stockGroup.save({
      id: 'empty-dynamic',
      name: '待首次刷新',
      resolver: { kind: 'llm', prompt: '选择龙头', maxMembers: 10 },
      refreshPolicy: 'manual',
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });
    await ctx.repos.stockPool.save({
      id: 'empty-watch',
      name: '空分组监控',
      groupId: 'empty-dynamic',
      rules: [{ kind: 'price-change', pct: 0.05 }],
      cooldownMinutes: 30,
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });

    const result = await listWatchPlansTool.execute({ enabledOnly: false }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.plans[0]?.state).toBe('empty');
  });

  it('历史坏数据引用不存在分组时降级为 group-missing', async () => {
    const ctx = await buildTestContext();
    await ctx.repos.stockPool.save({
      id: 'orphan-watch',
      name: '孤立方案',
      groupId: 'missing-group',
      rules: [{ kind: 'price-change', pct: 0.05 }],
      cooldownMinutes: 30,
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });

    const result = await listWatchPlansTool.execute({ enabledOnly: false }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.plans[0]).toMatchObject({
      group: null,
      memberCount: 0,
      state: 'group-missing',
    });
  });

  it('可按 groupId 只读取当前分组关联的方案', async () => {
    const ctx = await buildTestContext();
    for (const id of ['group-a', 'group-b']) {
      await ctx.repos.stockGroup.save({
        id,
        name: id,
        resolver: { kind: 'manual', stockIds: [] },
        refreshPolicy: 'manual',
        enabled: true,
        createdAt: T0,
        updatedAt: T0,
      });
      await ctx.repos.stockPool.save({
        id: `watch-${id}`,
        name: id,
        groupId: id,
        rules: [{ kind: 'price-change', pct: 0.05 }],
        cooldownMinutes: 30,
        enabled: true,
        createdAt: T0,
        updatedAt: T0,
      });
    }

    const result = await listWatchPlansTool.execute(
      { enabledOnly: false, groupId: 'group-b' },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.plans.map(({ plan }) => plan.id)).toEqual(['watch-group-b']);
  });
});
