import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';
import {
  createAlertPlanTool,
  deleteAlertPlanTool,
  listAlertPlansTool,
  updateAlertPlanTool,
} from './alert-plan.js';
import { archiveWatchlistTool, createWatchlistTool, getWatchlistTool } from './watchlist.js';

describe('AlertPlan tools', () => {
  it('CRUD 使用 Watchlist/Strategy 引用并保护被引用 Watchlist', async () => {
    const ctx = await buildTestContext();
    await createWatchlistTool.execute(
      {
        id: 'alert-watchlist',
        name: '提醒观察',
        kind: 'personal',
        membershipPolicy: 'manual',
      },
      ctx,
    );
    const created = await createAlertPlanTool.execute(
      {
        id: 'price-alert',
        name: '价格提醒',
        watchlistId: 'alert-watchlist',
        rules: [{ id: 'move', kind: 'price-change', pct: 0.05, direction: 'up' }],
      },
      ctx,
    );
    expect(created.ok).toBe(true);

    const listed = await listAlertPlansTool.execute({ watchlistId: 'alert-watchlist' }, ctx);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data.plans).toHaveLength(1);

    const detail = await getWatchlistTool.execute({ watchlistId: 'alert-watchlist' }, ctx);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.data.alertPlans.map((plan) => plan.id)).toEqual(['price-alert']);

    const protectedResult = await archiveWatchlistTool.execute(
      { watchlistId: 'alert-watchlist' },
      ctx,
    );
    expect(protectedResult.ok).toBe(false);
    if (protectedResult.ok) return;
    expect(protectedResult.error.kind).toBe('invalid_input');

    const updated = await updateAlertPlanTool.execute(
      { alertPlanId: 'price-alert', enabled: false, cooldownMinutes: 10 },
      ctx,
    );
    expect(updated.ok).toBe(true);
    // 遗留 watch_rule_states 应随 delete_alert_plan 级联清理
    await ctx.repos.watchRuleState.upsert({
      alertPlanId: 'price-alert',
      poolId: 'price-alert',
      stockId: '002594.SZ',
      ruleId: 'move',
      active: true,
      lastEvaluatedAt: new Date('2026-07-28T02:00:00Z'),
    });
    const removed = await deleteAlertPlanTool.execute({ alertPlanId: 'price-alert' }, ctx);
    expect(removed.ok).toBe(true);
    expect(await ctx.repos.alertPlan.findById('price-alert')).toBeNull();
    expect(await ctx.repos.watchRuleState.listByPool('price-alert')).toEqual([]);
  });

  it('strategy-signal rule 拒绝不存在的 Strategy', async () => {
    const ctx = await buildTestContext();
    await createWatchlistTool.execute(
      {
        id: 'strategy-alert-watch',
        name: '策略提醒',
        kind: 'strategy',
        membershipPolicy: 'synced',
      },
      ctx,
    );
    const result = await createAlertPlanTool.execute(
      {
        id: 'bad-strategy-alert',
        name: '错误策略',
        watchlistId: 'strategy-alert-watch',
        rules: [
          {
            id: 'signal',
            kind: 'strategy-signal',
            strategyId: 'missing',
            minScore: 60,
          },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not_found');
  });

  it('更新时 priority=null 清除计划级优先级', async () => {
    const ctx = await buildTestContext();
    await createWatchlistTool.execute(
      {
        id: 'priority-watchlist',
        name: '优先级观察',
        kind: 'personal',
        membershipPolicy: 'manual',
      },
      ctx,
    );
    await createAlertPlanTool.execute(
      {
        id: 'priority-alert',
        name: '优先级提醒',
        watchlistId: 'priority-watchlist',
        priority: 'urgent',
        rules: [{ id: 'level', kind: 'price-level', level: 10, side: 'above' }],
      },
      ctx,
    );

    const result = await updateAlertPlanTool.execute(
      { alertPlanId: 'priority-alert', priority: null },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.plan.priority).toBeUndefined();
    expect((await ctx.repos.alertPlan.findById('priority-alert'))?.priority).toBeUndefined();
  });
});
