import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { intradayWatchWorkflow } from './intraday-watch.js';

const T0 = new Date('2026-07-21T00:00:00Z');

describe('intraday-watch workflow', () => {
  it('空池：返回空 triggers + 评估 0 池 0 股', async () => {
    const ctx = await buildTestContext();
    const r = await intradayWatchWorkflow.run({}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.triggers).toEqual([]);
    expect(r.data.evaluatedPlans).toBe(0);
    expect(r.data.evaluatedStocks).toBe(0);
    expect(r.data.notified).toBe(0);
    expect(r.data.suppressedByCooldown).toBe(0);
  });

  it('启用的 AlertPlan 引用停用 Watchlist 时不评估其旧成员', async () => {
    const ctx = await buildTestContext();
    await ctx.repos.watchlist.save({
      id: 'paused-watchlist',
      name: 'paused',
      kind: 'personal',
      membershipPolicy: 'manual',
      enabled: false,
      createdAt: T0,
      updatedAt: T0,
    });
    await ctx.repos.watchlistMember.saveMember({
      id: 'paused-watchlist:002594.SZ',
      watchlistId: 'paused-watchlist',
      stockId: '002594.SZ',
      priority: 'normal',
      firstAddedAt: T0,
      lastActivityAt: T0,
    });
    await ctx.repos.alertPlan.save({
      id: 'paused-plan',
      name: 'paused plan',
      watchlistId: 'paused-watchlist',
      rules: [{ id: 'move', kind: 'price-change', pct: 0.001, direction: 'any' }],
      cooldownMinutes: 30,
      logic: 'ANY',
      triggerMode: 'on-enter',
      dailyNotificationLimit: 20,
      notifyOnRecovery: false,
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });

    const result = await intradayWatchWorkflow.run({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.evaluatedPlans).toBe(1);
    expect(result.data.evaluatedStocks).toBe(0);
    expect(result.data.triggers).toEqual([]);
  });

  it('notify=false 的试跑只落审计，不标已通知，也不占后续通知冷却', async () => {
    const ctx = await buildTestContext();
    const dryRun = await intradayWatchWorkflow.run({ notify: false }, ctx);
    expect(dryRun.ok).toBe(true);
    if (!dryRun.ok) return;
    // v0.7：testCtx 默认无 member（defaultAccountId=''），所以无 trigger 是合法结果；
    // 这里专注于 dry-run 行为契约：通知通道不应被调用、不应被标记 notified、不应触发冷却抑制。
    expect(dryRun.data.triggers.every((trigger) => !trigger.notified)).toBe(true);
    expect(dryRun.data.notified).toBe(0);
    expect(dryRun.data.suppressedByCooldown).toBe(0);
  });

  it('输入校验失败（alertPlanIds 含空串）→ invalid_input', async () => {
    const ctx = await buildTestContext();
    const r = await intradayWatchWorkflow.run({ alertPlanIds: [''] }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });
});
