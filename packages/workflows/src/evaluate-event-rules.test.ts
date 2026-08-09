import {
  AlertPlanSchema,
  type StockEvent,
  type ToolContext,
  WatchlistMemberSchema,
  WatchlistSchema,
} from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { evaluateEventRulesWorkflow } from './evaluate-event-rules.js';

const CLOCK = () => new Date('2026-07-25T01:00:00.000Z');
/** now 的 Asia/Shanghai 当日 = 07-25；+3 自然日 = 07-28 00:00 SH = 07-27T16:00Z。 */
const EVENT_IN_3_DAYS = new Date('2026-07-27T16:00:00.000Z');

const seedAlertPlanWithEventRule = async (
  ctx: ToolContext,
  opts: {
    importance?: 'normal' | 'important' | 'urgent';
    daysBefore?: number[];
    occursAt?: Date;
    remindBeforeDays?: number[];
    dailyNotificationLimit?: number;
  } = {},
): Promise<StockEvent> => {
  const now = CLOCK();
  const watchlist = WatchlistSchema.parse({
    id: 'evt-watchlist',
    name: '事件 Watchlist',
    kind: 'personal',
    membershipPolicy: 'manual',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.repos.watchlist.save(watchlist);
  await ctx.repos.watchlistMember.saveMember(
    WatchlistMemberSchema.parse({
      id: 'evt-watchlist:stk-evt',
      watchlistId: watchlist.id,
      stockId: 'stk-evt',
      stage: 'watching',
      priority: 'normal',
      firstAddedAt: now,
      lastActivityAt: now,
    }),
  );
  const plan = AlertPlanSchema.parse({
    id: 'evt-alert',
    name: '事件 AlertPlan',
    watchlistId: watchlist.id,
    rules: [{ kind: 'event-date', id: 'r1', daysBefore: opts.daysBefore ?? [3] }],
    logic: 'ANY',
    triggerMode: 'on-enter',
    cooldownMinutes: 30,
    dailyNotificationLimit: opts.dailyNotificationLimit ?? 20,
    notifyOnRecovery: false,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.repos.alertPlan.save(plan);
  const event: StockEvent = {
    id: 'evt-1',
    stockId: 'stk-evt',
    kind: 'earnings',
    title: 'Q2 财报',
    occursAt: opts.occursAt ?? EVENT_IN_3_DAYS,
    allDay: true,
    importance: opts.importance ?? 'important',
    status: 'scheduled',
    source: 'manual',
    stale: false,
    remindBeforeDays: opts.remindBeforeDays ?? [],
    createdAt: now,
    updatedAt: now,
  };
  await ctx.repos.stockEvent.save(event);
  return event;
};

describe('evaluate-event-rules workflow', () => {
  it('窗口命中 (d=3) → 生成 WatchTrigger；important → sent', async () => {
    const ctx = await buildTestContext({ clock: CLOCK });
    await seedAlertPlanWithEventRule(ctx, { importance: 'important' });
    const r = await evaluateEventRulesWorkflow.run({}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.triggered).toBe(1);
    expect(r.data.notified).toBe(1);
    const triggers = await ctx.repos.watchTrigger.listRecent({ poolId: 'evt-alert' });
    expect(triggers.length).toBe(1);
    const trigger = triggers[0];
    if (trigger === undefined) throw new Error('expected one event trigger');
    expect(trigger.eventId).toBe('evt-1');
    expect(trigger.ruleKind).toBe('event-date');
    expect(trigger.deliveryStatus).toBe('sent');
    expect((trigger.evalSnapshot as { remindDay?: number }).remindDay).toBe(3);
  });

  it('重复执行 → (event, remindDay) 去重', async () => {
    const ctx = await buildTestContext({ clock: CLOCK });
    await seedAlertPlanWithEventRule(ctx);
    await evaluateEventRulesWorkflow.run({}, ctx);
    const second = await evaluateEventRulesWorkflow.run({}, ctx);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.triggered).toBe(0);
    expect(second.data.deduped).toBe(1);
  });

  it('normal 优先级 → not-requested（仅记录，不发送）', async () => {
    const ctx = await buildTestContext({ clock: CLOCK });
    await seedAlertPlanWithEventRule(ctx, { importance: 'normal' });
    const r = await evaluateEventRulesWorkflow.run({}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.triggered).toBe(1);
    expect(r.data.notified).toBe(0);
    const triggers = await ctx.repos.watchTrigger.listRecent({ poolId: 'evt-alert' });
    expect(triggers[0]?.deliveryStatus).toBe('not-requested');
  });

  it('窗口外事件不触发', async () => {
    const ctx = await buildTestContext({ clock: CLOCK });
    await seedAlertPlanWithEventRule(ctx, { daysBefore: [1] }); // 事件在 3 天后，规则只提醒 1 天前
    const r = await evaluateEventRulesWorkflow.run({}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.triggered).toBe(0);
  });

  it('daysBefore=[0] 可命中今天 00:00 的全天事件', async () => {
    const ctx = await buildTestContext({ clock: CLOCK });
    await seedAlertPlanWithEventRule(ctx, {
      daysBefore: [0],
      occursAt: new Date('2026-07-24T16:00:00.000Z'),
    });

    const result = await evaluateEventRulesWorkflow.run({ dryRun: true }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.triggered).toBe(1);
  });

  it('事件级 remindBeforeDays 可覆盖规则默认窗口', async () => {
    const ctx = await buildTestContext({ clock: CLOCK });
    await seedAlertPlanWithEventRule(ctx, {
      daysBefore: [7, 3, 1],
      occursAt: new Date('2026-08-23T16:00:00.000Z'),
      remindBeforeDays: [30],
    });

    const result = await evaluateEventRulesWorkflow.run({ dryRun: true }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.triggered).toBe(1);
  });

  it('事件改期后相同 remindDay 仍生成新的提醒事实', async () => {
    let now = CLOCK();
    const ctx = await buildTestContext({ clock: () => now });
    const event = await seedAlertPlanWithEventRule(ctx);
    await evaluateEventRulesWorkflow.run({ dryRun: true }, ctx);
    now = new Date('2026-07-29T01:00:00.000Z');
    await ctx.repos.stockEvent.save({
      ...event,
      occursAt: new Date('2026-07-31T16:00:00.000Z'),
      updatedAt: now,
    });

    const second = await evaluateEventRulesWorkflow.run({ dryRun: true }, ctx);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.triggered).toBe(1);
    expect(await ctx.repos.watchTrigger.listRecent({ poolId: 'evt-alert' })).toHaveLength(2);
  });

  it('事件提醒遵守 AlertPlan 每日通知上限', async () => {
    const ctx = await buildTestContext({ clock: CLOCK });
    const first = await seedAlertPlanWithEventRule(ctx, { dailyNotificationLimit: 1 });
    await ctx.repos.stockEvent.save({
      ...first,
      id: 'evt-2',
      title: 'Q2 业绩说明会',
    });

    const result = await evaluateEventRulesWorkflow.run({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.triggered).toBe(2);
    expect(result.data.notified).toBe(1);
    const statuses = (await ctx.repos.watchTrigger.listRecent({ poolId: 'evt-alert' }))
      .map((trigger) => trigger.deliveryStatus)
      .sort();
    expect(statuses).toEqual(['sent', 'suppressed-daily-limit']);
  });

  it('tool 返回错误时把已开始的 WorkflowRun 更新为 failed', async () => {
    const base = await buildTestContext({ clock: CLOCK });
    await seedAlertPlanWithEventRule(base);
    const ctx: ToolContext = {
      ...base,
      repos: {
        ...base.repos,
        stockEvent: {
          ...base.repos.stockEvent,
          list: async () => {
            throw new Error('stock events unavailable');
          },
        },
      },
    };

    const result = await evaluateEventRulesWorkflow.run({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe('failed');
    const runs = await base.repos.workflowRun.listRecent({
      workflowName: 'evaluate-event-rules',
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'failed' });
    expect(runs[0]?.error).toContain('list_stock_events');
  });
});
