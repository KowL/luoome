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
    expect(protectedResult.error.kind).toBe('invariant_violation');

    const updated = await updateAlertPlanTool.execute(
      { alertPlanId: 'price-alert', enabled: false, cooldownMinutes: 10 },
      ctx,
    );
    expect(updated.ok).toBe(true);
    const removed = await deleteAlertPlanTool.execute({ alertPlanId: 'price-alert' }, ctx);
    expect(removed.ok).toBe(true);
    expect(await ctx.repos.alertPlan.findById('price-alert')).toBeNull();
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
});
