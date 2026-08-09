import { addWatchlistMemberTool, createAlertPlanTool, createWatchlistTool } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { withFixedQuoteAdapter } from '@luoome/tools/testing/fixed-quote-adapter';
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

  it('logic=ALL 时部分规则命中不产生单规则 Trigger', async () => {
    const now = new Date('2026-08-09T02:00:00.000Z');
    const base = await buildTestContext({ clock: () => now });
    await createWatchlistTool.execute(
      {
        id: 'all-watchlist',
        name: '组合观察',
        kind: 'personal',
        membershipPolicy: 'manual',
      },
      base,
    );
    await addWatchlistMemberTool.execute(
      { watchlistId: 'all-watchlist', stockId: '600519.SH' },
      base,
    );
    await createAlertPlanTool.execute(
      {
        id: 'all-alert',
        name: '组合提醒',
        watchlistId: 'all-watchlist',
        logic: 'ALL',
        rules: [
          { id: 'above-50', kind: 'price-level', level: 50, side: 'above' },
          { id: 'above-150', kind: 'price-level', level: 150, side: 'above' },
        ],
      },
      base,
    );
    const ctx = withFixedQuoteAdapter(base, { '600519.SH': 100 });

    const result = await intradayWatchWorkflow.run(
      { alertPlanIds: ['all-alert'], notify: false },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.triggers).toEqual([]);
  });

  it('logic=ALL 时任一规则 unknown 不产生 repeat Trigger', async () => {
    const now = new Date('2026-08-09T02:00:00.000Z');
    const base = await buildTestContext({ clock: () => now });
    await createWatchlistTool.execute(
      {
        id: 'all-unknown-watchlist',
        name: '组合数据缺失观察',
        kind: 'personal',
        membershipPolicy: 'manual',
      },
      base,
    );
    await addWatchlistMemberTool.execute(
      { watchlistId: 'all-unknown-watchlist', stockId: '688981.SH' },
      base,
    );
    await createAlertPlanTool.execute(
      {
        id: 'all-unknown-alert',
        name: '组合数据缺失提醒',
        watchlistId: 'all-unknown-watchlist',
        logic: 'ALL',
        triggerMode: 'repeat',
        rules: [
          { id: 'above-50', kind: 'price-level', level: 50, side: 'above' },
          { id: 'holding-cost', kind: 'cost-threshold', stopLossPct: 0.05 },
        ],
      },
      base,
    );
    for (const ruleId of ['above-50', 'holding-cost', 'composite']) {
      await base.repos.watchRuleState.upsert({
        alertPlanId: 'all-unknown-alert',
        poolId: 'all-unknown-alert',
        stockId: '688981.SH',
        ruleId,
        active: true,
        lastEvaluatedAt: new Date(now.getTime() - 60_000),
      });
    }
    const ctx = withFixedQuoteAdapter(base, { '688981.SH': 100 });

    const result = await intradayWatchWorkflow.run(
      { alertPlanIds: ['all-unknown-alert'], notify: false },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.triggers).toEqual([]);
  });

  it('logic=ALL 时一条规则为 false 即使另一条 unknown 也产生恢复 Trigger', async () => {
    const now = new Date('2026-08-09T02:00:00.000Z');
    const base = await buildTestContext({ clock: () => now });
    await createWatchlistTool.execute(
      {
        id: 'all-recovery-watchlist',
        name: '组合恢复观察',
        kind: 'personal',
        membershipPolicy: 'manual',
      },
      base,
    );
    await addWatchlistMemberTool.execute(
      { watchlistId: 'all-recovery-watchlist', stockId: '688981.SH' },
      base,
    );
    await createAlertPlanTool.execute(
      {
        id: 'all-recovery-alert',
        name: '组合恢复提醒',
        watchlistId: 'all-recovery-watchlist',
        logic: 'ALL',
        notifyOnRecovery: true,
        rules: [
          { id: 'above-150', kind: 'price-level', level: 150, side: 'above' },
          { id: 'holding-cost', kind: 'cost-threshold', stopLossPct: 0.05 },
        ],
      },
      base,
    );
    for (const ruleId of ['above-150', 'holding-cost', 'composite']) {
      await base.repos.watchRuleState.upsert({
        alertPlanId: 'all-recovery-alert',
        poolId: 'all-recovery-alert',
        stockId: '688981.SH',
        ruleId,
        active: true,
        lastEvaluatedAt: new Date(now.getTime() - 60_000),
      });
    }
    const ctx = withFixedQuoteAdapter(base, { '688981.SH': 100 });

    const result = await intradayWatchWorkflow.run(
      { alertPlanIds: ['all-recovery-alert'], notify: false },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.triggers).toHaveLength(1);
    expect(result.data.triggers[0]).toMatchObject({
      ruleId: 'composite',
      triggerType: 'recovered',
    });
  });

  it('daily-first 同一上海自然日只产生一次 Trigger', async () => {
    const now = new Date('2026-08-09T02:00:00.000Z');
    const base = await buildTestContext({ clock: () => now });
    await createWatchlistTool.execute(
      {
        id: 'daily-watchlist',
        name: '每日观察',
        kind: 'personal',
        membershipPolicy: 'manual',
      },
      base,
    );
    await addWatchlistMemberTool.execute(
      { watchlistId: 'daily-watchlist', stockId: '600519.SH' },
      base,
    );
    await createAlertPlanTool.execute(
      {
        id: 'daily-alert',
        name: '每日提醒',
        watchlistId: 'daily-watchlist',
        triggerMode: 'daily-first',
        cooldownMinutes: 0,
        rules: [{ id: 'above-50', kind: 'price-level', level: 50, side: 'above' }],
      },
      base,
    );
    const ctx = withFixedQuoteAdapter(base, { '600519.SH': 100 });

    const first = await intradayWatchWorkflow.run(
      { alertPlanIds: ['daily-alert'], notify: false },
      ctx,
    );
    const second = await intradayWatchWorkflow.run(
      { alertPlanIds: ['daily-alert'], notify: false },
      ctx,
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.data.triggers).toHaveLength(1);
    expect(second.data.triggers).toEqual([]);
  });

  it('notifyOnRecovery=true 时发送恢复通知并返回最终送达状态', async () => {
    const now = new Date('2026-08-09T02:00:00.000Z');
    const base = await buildTestContext({ clock: () => now });
    await createWatchlistTool.execute(
      {
        id: 'recovery-watchlist',
        name: '恢复观察',
        kind: 'personal',
        membershipPolicy: 'manual',
      },
      base,
    );
    await addWatchlistMemberTool.execute(
      { watchlistId: 'recovery-watchlist', stockId: '600519.SH' },
      base,
    );
    await createAlertPlanTool.execute(
      {
        id: 'recovery-alert',
        name: '恢复提醒',
        watchlistId: 'recovery-watchlist',
        notifyOnRecovery: true,
        cooldownMinutes: 0,
        rules: [{ id: 'above-100', kind: 'price-level', level: 100, side: 'above' }],
      },
      base,
    );
    await base.repos.watchRuleState.upsert({
      alertPlanId: 'recovery-alert',
      poolId: 'recovery-alert',
      stockId: '600519.SH',
      ruleId: 'above-100',
      active: true,
      lastEvaluatedAt: new Date(now.getTime() - 60_000),
      lastValue: 1,
    });
    const ctx = withFixedQuoteAdapter(base, { '600519.SH': 90 });

    const result = await intradayWatchWorkflow.run(
      { alertPlanIds: ['recovery-alert'], notify: true },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.triggers).toHaveLength(1);
    expect(result.data.triggers[0]).toMatchObject({
      triggerType: 'recovered',
      deliveryStatus: 'sent',
      notified: true,
    });
    const saved = await base.repos.watchTrigger.findById(result.data.triggers[0]?.id ?? '');
    expect(saved).toMatchObject({ deliveryStatus: 'sent', notified: true });
  });
});
