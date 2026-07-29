import { addWatchlistMemberTool, createAlertPlanTool, createWatchlistTool } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { intradayWatchWorkflow } from './intraday-watch.js';

describe('intraday-watch target model', () => {
  it('只从 enabled AlertPlan + WatchlistMember 解析扫描对象', async () => {
    const ctx = await buildTestContext({
      clock: () => new Date('2026-07-17T07:00:00.000Z'),
    });
    await createWatchlistTool.execute(
      {
        id: 'target-watchlist',
        name: '目标观察',
        kind: 'personal',
        membershipPolicy: 'manual',
      },
      ctx,
    );
    await addWatchlistMemberTool.execute(
      { watchlistId: 'target-watchlist', stockId: '002594.SZ' },
      ctx,
    );
    await createAlertPlanTool.execute(
      {
        id: 'target-alert',
        name: '目标提醒',
        watchlistId: 'target-watchlist',
        rules: [{ id: 'above-zero', kind: 'price-level', level: 0.01, side: 'above' }],
      },
      ctx,
    );

    const result = await intradayWatchWorkflow.run(
      { alertPlanIds: ['target-alert'], notify: false },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.evaluatedPlans).toBe(1);
    expect(result.data.evaluatedStocks).toBe(1);
    expect(result.data.triggers).toHaveLength(1);
    expect(result.data.triggers[0]).toMatchObject({
      alertPlanId: 'target-alert',
      stockId: '002594.SZ',
      ruleId: 'above-zero',
    });
  });

  it('disabled Watchlist 使关联 AlertPlan not-ready', async () => {
    const ctx = await buildTestContext();
    await ctx.repos.watchlist.save({
      id: 'disabled-watchlist',
      name: '停用',
      kind: 'personal',
      membershipPolicy: 'manual',
      enabled: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await createAlertPlanTool.execute(
      {
        id: 'disabled-alert',
        name: '不应扫描',
        watchlistId: 'disabled-watchlist',
        rules: [{ id: 'move', kind: 'price-change', pct: 0.01 }],
      },
      ctx,
    );
    const result = await intradayWatchWorkflow.run({ notify: false }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.evaluatedStocks).toBe(0);
    expect(result.data.triggers).toEqual([]);
  });
});
