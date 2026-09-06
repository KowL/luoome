import { NotificationSchema } from '@luoome/core';
import { addWatchlistMemberTool, createAlertPlanTool, createWatchlistTool } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { withFixedQuoteAdapter } from '@luoome/tools/testing/fixed-quote-adapter';
import { describe, expect, it } from 'vitest';

import { evaluateEventRulesWorkflow } from './evaluate-event-rules.js';
import { intradayWatchWorkflow } from './intraday-watch.js';

const setup = async (logic: 'ANY' | 'ALL' = 'ANY', mode = 'on-enter', event = false) => {
  let now = new Date('2026-07-27T02:00:00Z');
  const base = await buildTestContext({ clock: () => now });
  await createWatchlistTool.execute(
    { id: 'review-list', name: '测试列表', kind: 'personal', membershipPolicy: 'manual' },
    base,
  );
  await addWatchlistMemberTool.execute({ watchlistId: 'review-list', stockId: '600519.SH' }, base);
  await createAlertPlanTool.execute(
    {
      id: 'review-alert',
      name: '测试预警',
      watchlistId: 'review-list',
      logic,
      rules: event
        ? [{ id: 'rule', kind: 'event-date', daysBefore: [3] }]
        : [{ id: 'rule', kind: 'price-level', level: 100, side: 'above' }],
      triggerMode: mode,
      priority: 'important',
      cooldownMinutes: 0,
    },
    base,
  );
  const prices = { '600519.SH': 90 };
  const ctx = withFixedQuoteAdapter(base, prices);
  const advance = (ms = 60_000) => {
    now = new Date(now.getTime() + ms);
  };
  const run = async (notify = true) => {
    advance();
    const result = await intradayWatchWorkflow.run({ notify }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.data;
  };
  if (event)
    await ctx.repos.stockEvent.save({
      id: 'review-event',
      stockId: '600519.SH',
      kind: 'earnings',
      title: '测试财报',
      occursAt: new Date('2026-07-29T16:00:00Z'),
      allDay: true,
      importance: 'important',
      status: 'scheduled',
      source: 'manual',
      stale: false,
      remindBeforeDays: [],
      createdAt: now,
      updatedAt: now,
    });
  return { ctx, prices, run, advance };
};

describe('预警可靠性', () => {
  it.each(['ANY', 'ALL'] as const)('%s 试跑不消耗正式边沿，也不写正式触发', async (logic) => {
    const { ctx, prices, run } = await setup(logic);
    await run();
    const before = await ctx.repos.watchRuleState.listByPool('review-alert');
    prices['600519.SH'] = 110;
    expect((await run(false)).triggers).toHaveLength(1);
    expect(await ctx.repos.watchRuleState.listByPool('review-alert')).toEqual(before);
    expect(await ctx.repos.watchTrigger.listRecent({})).toEqual([]);
    expect((await run()).delivered).toBe(1);
  });

  it.each(['ANY', 'ALL'] as const)('%s 每日首次覆盖当天再次进入条件', async (logic) => {
    const { prices, run } = await setup(logic, 'daily-first');
    await run();
    prices['600519.SH'] = 110;
    expect((await run()).delivered).toBe(1);
    prices['600519.SH'] = 90;
    await run();
    prices['600519.SH'] = 110;
    expect((await run()).triggers).toEqual([]);
  });

  it('并发正式执行最多发送一次', async () => {
    const { ctx, prices, run } = await setup();
    await run();
    prices['600519.SH'] = 110;
    const results = await Promise.all([
      intradayWatchWorkflow.run({ notify: true }, ctx),
      intradayWatchWorkflow.run({ notify: true }, ctx),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await ctx.repos.notification.listRecent({})).toHaveLength(1);
  });

  it('达到三次尝试后停止重试，试跑不发送待重试通知', async () => {
    const { ctx, prices, run, advance } = await setup();
    await run();
    prices['600519.SH'] = 110;
    const manager = ctx.notification;
    if (!manager) throw new Error('missing fixture manager');
    const send = manager.send.bind(manager);
    manager.send = async (input) => {
      const result = await send(input);
      return {
        notification: {
          ...NotificationSchema.parse(result.notification),
          result: 'failed',
          errorMessage: 'fixture',
        },
      };
    };
    const first = await run();
    expect((await run(false)).notified).toBe(0);
    expect((await run()).notified).toBe(1);
    expect((await run()).notified).toBe(0);
    advance(300_000);
    expect((await run()).notified).toBe(1);
    advance(300_000);
    expect((await run()).notified).toBe(0);
    expect(await ctx.repos.watchTrigger.findById(first.triggers[0]?.id ?? '')).toMatchObject({
      deliveryAttempts: 3,
    });
    expect(await ctx.repos.watchTrigger.listRecent({})).toHaveLength(1);
  });

  it.each(['expired', 'daily-limit', 'disabled'] as const)('%s 时不重试', async (condition) => {
    const { ctx, prices, run, advance } = await setup();
    await run();
    prices['600519.SH'] = 110;
    const first = await run();
    const id = first.triggers[0]?.id;
    if (!id) throw new Error('missing trigger');
    await ctx.repos.watchTrigger.setDeliveryStatus([id], 'failed');
    const plan = await ctx.repos.alertPlan.findById('review-alert');
    if (!plan) throw new Error('missing plan');
    if (condition === 'expired') advance(86_400_000);
    if (condition === 'daily-limit')
      await ctx.repos.alertPlan.save({ ...plan, dailyNotificationLimit: 1 });
    if (condition === 'disabled') await ctx.repos.alertPlan.save({ ...plan, enabled: false });
    expect((await run()).notified).toBe(0);
  });

  it('发送前崩溃留下 pending，下轮重试同一条记录', async () => {
    const { ctx, prices, run } = await setup();
    await run();
    prices['600519.SH'] = 110;
    const begin = ctx.repos.watchTrigger.beginDelivery.bind(ctx.repos.watchTrigger);
    ctx.repos.watchTrigger.beginDelivery = async (ids, at) => {
      await begin(ids, at);
      throw new Error('fixture crash before sending');
    };
    expect(await intradayWatchWorkflow.run({ notify: true }, ctx)).toMatchObject({ ok: false });
    const pending = (await ctx.repos.watchTrigger.listRecent({}))[0];
    expect(pending).toMatchObject({ deliveryStatus: 'pending', deliveryAttempts: 1 });
    expect(await ctx.repos.notification.listRecent({})).toEqual([]);
    ctx.repos.watchTrigger.beginDelivery = begin;
    const retry = await run();
    expect(retry.delivered).toBe(1);
    expect(retry.triggers[0]?.id).toBe(pending?.id);
    expect(await ctx.repos.watchTrigger.listRecent({})).toHaveLength(1);
  });

  it('工具执行期间丢失租约时停止提交与发送', async () => {
    const { ctx, prices, run, advance } = await setup();
    await run();
    prices['600519.SH'] = 110;
    const batch = ctx.adapters.market.batchQuote.bind(ctx.adapters.market);
    ctx.adapters.market.batchQuote = async (ids) => {
      const result = await batch(ids);
      advance(121_000);
      await ctx.repos.watchTrigger.acquireExecution(
        'new-owner',
        ctx.clock(),
        new Date(ctx.clock().getTime() + 120_000),
      );
      return result;
    };
    expect(await intradayWatchWorkflow.run({ notify: true }, ctx)).toMatchObject({ ok: false });
    expect(await ctx.repos.notification.listRecent({})).toEqual([]);
    expect(await ctx.repos.watchTrigger.listRecent({})).toEqual([]);
    expect(
      await ctx.repos.watchTrigger.acquireExecution(
        'other-owner',
        ctx.clock(),
        new Date(ctx.clock().getTime() + 120_000),
      ),
    ).toBe(false);
  });

  it('失败后按退避重试原触发，成功后不再重试', async () => {
    const { ctx, prices, run } = await setup();
    await run();
    prices['600519.SH'] = 110;
    const manager = ctx.notification;
    if (!manager) throw new Error('missing fixture notification manager');
    const send = manager.send.bind(manager);
    manager.send = async (input) => {
      const result = await send(input);
      return {
        notification: {
          ...NotificationSchema.parse(result.notification),
          result: 'failed',
          errorMessage: 'fixture',
        },
      };
    };
    const failed = await run();
    expect(failed.triggers[0]?.deliveryStatus).toBe('failed');
    manager.send = send;
    const retry = await run();
    expect(retry.delivered).toBe(1);
    expect(retry.triggers[0]?.id).toBe(failed.triggers[0]?.id);
    expect((await run()).notified).toBe(0);
  });

  it('事件试跑不消耗去重，正式通知走飞书', async () => {
    const { ctx } = await setup('ANY', 'on-enter', true);
    expect(await evaluateEventRulesWorkflow.run({ dryRun: true }, ctx)).toMatchObject({
      ok: true,
      data: { triggered: 1, notified: 0 },
    });
    expect(await ctx.repos.watchTrigger.listRecent({})).toEqual([]);
    expect(await evaluateEventRulesWorkflow.run({}, ctx)).toMatchObject({
      ok: true,
      data: { triggered: 1, notified: 1 },
    });
    expect((await ctx.repos.notification.listRecent({}))[0]?.channel).toBe('feishu');
  });

  it.each(['suppressed', 'failed'] as const)(
    '事件投递 %s 保留真实送达状态及通知关联',
    async (delivery) => {
      const { ctx, advance } = await setup('ANY', 'on-enter', true);
      const manager = ctx.notification;
      if (!manager) throw new Error('missing manager');
      const send = manager.send.bind(manager);
      manager.send = async (input) => {
        const result = await send(input);
        return {
          notification: { ...NotificationSchema.parse(result.notification), result: delivery },
        };
      };
      expect(await evaluateEventRulesWorkflow.run({}, ctx)).toMatchObject({
        ok: true,
        data: { notified: 0 },
      });
      const trigger = (await ctx.repos.watchTrigger.listRecent({}))[0];
      expect(trigger).toMatchObject({
        deliveryStatus: delivery === 'failed' ? 'failed' : 'fallback-log',
      });
      expect(trigger?.notificationId).toBeDefined();
      manager.send = send;
      advance();
      expect(await evaluateEventRulesWorkflow.run({}, ctx)).toMatchObject({
        ok: true,
        data: { triggered: 0, notified: delivery === 'failed' ? 1 : 0 },
      });
    },
  );

  it('盘中循环接手事件失败投递，不需要等下一天的事件 cron', async () => {
    const { ctx, run } = await setup('ANY', 'on-enter', true);
    const manager = ctx.notification;
    if (!manager) throw new Error('missing manager');
    const send = manager.send.bind(manager);
    manager.send = async (input) => {
      const result = await send(input);
      return {
        notification: { ...NotificationSchema.parse(result.notification), result: 'failed' },
      };
    };
    await evaluateEventRulesWorkflow.run({}, ctx);
    const eventTrigger = (await ctx.repos.watchTrigger.listRecent({}))[0];
    manager.send = send;
    const retry = await run();
    expect(retry.delivered).toBe(1);
    expect(retry.triggers[0]?.id).toBe(eventTrigger?.id);
  });
});
