import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@luoome/core';
import {
  addWatchlistMemberTool,
  BUILTIN_PLUGIN_DEFAULTS,
  beginWatchDeliveryTool,
  createAlertPlanTool,
  createPluginExecutionPolicy,
  createWatchlistTool,
  getReportTool,
  listWatchTriggersTool,
  resolveWatchNotificationTool,
  saveReportTool,
  sendNotificationTool,
} from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { withFixedQuoteAdapter } from '@luoome/tools/testing/fixed-quote-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FeishuWebhookAdapter,
  NotificationManager,
  PluginConfigStore,
  ProviderRuntime,
} from '../../adapters/src/index.js';
import { makeReport, makeWatchTrigger } from '../../db/src/repository/contract-tests.js';
import { intradayWatchWorkflow } from './intraday-watch.js';
import { openingReportOperation } from './opening-report.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const id = 'business.notification' as const;
const denied = {
  ok: false,
  error: { kind: 'permission_denied', required: 'plugin:business.notification' },
};
const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const setup = async (transport?: () => Promise<Response>) => {
  const root = mkdtempSync(join(tmpdir(), 'luoome-notify-plugin-'));
  roots.push(root);
  const store = new PluginConfigStore(join(root, 'plugins.json'));
  let config = store.initialize(BUILTIN_PLUGIN_DEFAULTS);
  for (const plugin of ['business.report', 'business.watch-monitoring', 'source.sina'] as const)
    config = store.set(plugin, true, config);
  const policy = createPluginExecutionPolicy(
    store,
    new Set(['read', 'advice', 'write', 'external']),
  );
  let now = new Date('2026-11-16T02:00:00Z');
  const base = await buildTestContext({ executionPolicy: policy, clock: () => now });
  const prices = { '600519.SH': 90 };
  const fixed = withFixedQuoteAdapter(base, prices);
  let sends = 0;
  const manager = new NotificationManager({
    repos: base.repos,
    logger: base.logger,
    clock: () => now,
    executionPolicy: policy,
    feishu: new FeishuWebhookAdapter({
      webhookUrl: 'https://fixture.invalid',
      fetchImpl: async () => {
        sends++;
        return transport === undefined ? Response.json({ code: 0 }) : transport();
      },
    }),
  });
  const provider = new ProviderRuntime(store);
  const ctx: ToolContext = {
    ...fixed,
    dataScope: provider,
    adapters: {
      ...fixed.adapters,
      market: provider.wrap('market', ['sina'], () => fixed.adapters.market),
      notification: manager,
    },
  };
  const set = (enabled: boolean) => {
    const read = store.read();
    if (!read.ok) throw new Error('missing');
    store.set(id, enabled, read.config);
  };
  await createWatchlistTool.execute(
    { id: 'list', name: 'notification fixture', kind: 'personal', membershipPolicy: 'manual' },
    ctx,
  );
  await addWatchlistMemberTool.execute({ watchlistId: 'list', stockId: '600519.SH' }, ctx);
  await createAlertPlanTool.execute(
    {
      id: 'alert',
      name: 'fixture',
      watchlistId: 'list',
      rules: [{ id: 'above', kind: 'price-level', side: 'above', level: 100 }],
      cooldownMinutes: 0,
      priority: 'important',
    },
    ctx,
  );
  const edge = async () => {
    expect((await intradayWatchWorkflow.run({ notify: true }, ctx)).ok).toBe(true);
    now = new Date(now.getTime() + 60000);
    prices['600519.SH'] = 110;
  };
  return { ctx, manager, policy, store, set, edge, sends: () => sends };
};
const input = {
  notificationId: 'stable',
  channel: 'feishu',
  feishu: { title: 'fixture', content: 'controlled notification' },
} as const;

describe('notification plugin lifecycle', () => {
  it('starts closed for every channel and direct host helper without creating synthetic receipts', async () => {
    const { ctx, manager, sends } = await setup();
    expect(await sendNotificationTool.execute(input, ctx)).toMatchObject(denied);
    expect(
      await sendNotificationTool.execute({ log: { title: 'log', content: 'disabled' } }, ctx),
    ).toMatchObject(denied);
    await expect(manager.sendLog({ title: 'log', content: 'disabled' })).rejects.toMatchObject({
      required: 'plugin:business.notification',
    });
    await expect(manager.info({ title: 'info', content: 'disabled' })).rejects.toMatchObject({
      required: 'plugin:business.notification',
    });
    const { executionPolicy: _policy, ...uncontrolled } = ctx;
    expect(await sendNotificationTool.execute(input, uncontrolled)).toMatchObject(denied);
    expect(sends()).toBe(0);
    expect(await ctx.repos.notification.listRecent()).toEqual([]);
  });

  it('retains report generation and real watch trigger/edge records without claiming attempts while disabled', async () => {
    const { ctx, edge, sends, set } = await setup();
    const begin = vi.spyOn(ctx.repos.watchTrigger, 'beginDelivery');
    const report = await openingReportOperation.run({ notify: true, mode: 'scheduled' }, ctx);
    expect(report).toMatchObject({
      ok: true,
      data: { notified: false, report: { deliveryStatus: 'not-requested' } },
    });
    await edge();
    const watch = await intradayWatchWorkflow.run({ notify: true }, ctx);
    expect(watch).toMatchObject({
      ok: true,
      data: {
        notified: 0,
        delivered: 0,
        notifyFailed: 0,
        triggers: [{ deliveryStatus: 'not-requested', notified: false }],
      },
    });
    const triggers = await ctx.repos.watchTrigger.listRecent({});
    expect(triggers).toHaveLength(1);
    expect(begin).not.toHaveBeenCalled();
    expect(triggers[0]?.deliveryAttempts).toBeUndefined();
    expect((await ctx.repos.watchRuleState.listByPool('alert'))[0]?.active).toBe(true);
    expect(sends()).toBe(0);
    expect(await ctx.repos.notification.listRecent()).toEqual([]);
    set(true);
    expect((await intradayWatchWorkflow.run({ notify: true }, ctx)).ok).toBe(true);
    expect(sends()).toBe(0);
  });

  it('rejects a saved tool and a paused lookup after off/on, then reuses successful history', async () => {
    const { ctx, policy, manager, set, sends } = await setup();
    set(true);
    const old = { ...ctx, executionPolicy: policy.bind() };
    const started = deferred(),
      release = deferred();
    const lookup = ctx.repos.notification.findById.bind(ctx.repos.notification);
    const spy = vi.spyOn(ctx.repos.notification, 'findById').mockImplementationOnce(async (key) => {
      started.resolve();
      await release.promise;
      return lookup(key);
    });
    const pending = sendNotificationTool.execute(input, old);
    await started.promise;
    set(false);
    expect(policy.activity().find((call) => call.id === id)?.revokedInFlight).toBeGreaterThan(0);
    set(true);
    release.resolve();
    expect(await pending).toMatchObject(denied);
    expect(sends()).toBe(0);
    expect(await sendNotificationTool.execute(input, old)).toMatchObject(denied);
    spy.mockRestore();
    expect((await sendNotificationTool.execute(input, ctx)).ok).toBe(true);
    set(false);
    set(true);
    expect((await sendNotificationTool.execute(input, ctx)).ok).toBe(true);
    expect(sends()).toBe(1);
    expect(await ctx.repos.notification.listRecent()).toHaveLength(1);
    const direct = manager.send({
      id: 'direct',
      channel: 'log',
      payload: { title: 'direct', content: 'same gate', level: 'info' },
    });
    expect((await direct).notification.result).toBe('success');
  });

  it('fences late report and watch claims without consuming attempts after off/on', async () => {
    const { ctx, policy, set, sends } = await setup();
    set(true);
    const old = { ...ctx, executionPolicy: policy.bind() };
    const history = await ctx.repos.report.upsertForPeriod(makeReport('claim-history'));
    const reportStarted = deferred(),
      reportRelease = deferred();
    const claim = ctx.repos.report.claimDelivery.bind(ctx.repos.report);
    vi.spyOn(ctx.repos.report, 'claimDelivery').mockImplementationOnce(async (input) => {
      reportStarted.resolve();
      await reportRelease.promise;
      return claim(input);
    });
    const reportPending = saveReportTool.execute(
      { report: history, deliveryAttemptId: 'late' },
      old,
    );
    await reportStarted.promise;
    set(false);
    set(true);
    reportRelease.resolve();
    expect(await reportPending).toMatchObject(denied);
    expect((await ctx.repos.report.findById(history.id))?.deliveryStatus).toBe('not-requested');
    const trigger = makeWatchTrigger('claim-trigger', {
      deliveryStatus: 'pending',
      notified: false,
    });
    await ctx.repos.watchTrigger.save(trigger);
    const watchOld = { ...ctx, executionPolicy: policy.bind() };
    const watchStarted = deferred(),
      watchRelease = deferred();
    const begin = ctx.repos.watchTrigger.beginDelivery.bind(ctx.repos.watchTrigger);
    vi.spyOn(ctx.repos.watchTrigger, 'beginDelivery').mockImplementationOnce(async (...input) => {
      watchStarted.resolve();
      await watchRelease.promise;
      return begin(...input);
    });
    const watchPending = beginWatchDeliveryTool.execute({ triggerIds: [trigger.id] }, watchOld);
    await watchStarted.promise;
    set(false);
    set(true);
    watchRelease.resolve();
    expect(await watchPending).toMatchObject(denied);
    expect((await ctx.repos.watchTrigger.findById(trigger.id))?.deliveryAttempts).toBeUndefined();
    expect(sends()).toBe(0);
  });

  it('records an already dispatched successful receipt while disabled and never replays it on re-enable', async () => {
    const started = deferred(),
      release = deferred();
    const { ctx, set, sends, policy } = await setup(async () => {
      started.resolve();
      await release.promise;
      return Response.json({ code: 0 });
    });
    set(true);
    const pending = sendNotificationTool.execute(input, ctx);
    await started.promise;
    set(false);
    expect(policy.activity().find((call) => call.id === id)?.revokedInFlight).toBeGreaterThan(0);
    release.resolve();
    expect((await pending).ok).toBe(true);
    expect((await ctx.repos.notification.findById('stable'))?.result).toBe('success');
    set(true);
    expect((await sendNotificationTool.execute(input, ctx)).ok).toBe(true);
    expect(sends()).toBe(1);
  });

  it('keeps a dispatched watch receipt and history readable while disabled without replay after re-enable', async () => {
    const started = deferred(),
      release = deferred();
    const { ctx, set, edge, sends } = await setup(async () => {
      started.resolve();
      await release.promise;
      return Response.json({ code: 0 });
    });
    set(true);
    await edge();
    const pending = intradayWatchWorkflow.run({ notify: true }, ctx);
    await started.promise;
    set(false);
    release.resolve();
    const result = await pending;
    const triggers = await ctx.repos.watchTrigger.listRecent({});
    expect(triggers[0]?.deliveryStatus).toBe('sent');
    expect(result).toMatchObject({ ok: true });
    expect((await listWatchTriggersTool.execute({}, ctx)).ok).toBe(true);
    expect(
      (await resolveWatchNotificationTool.execute({ triggerId: triggers[0]?.id }, ctx)).ok,
    ).toBe(true);
    set(true);
    expect((await intradayWatchWorkflow.run({ notify: true }, ctx)).ok).toBe(true);
    expect(sends()).toBe(1);
    expect(await ctx.repos.watchTrigger.listRecent({})).toHaveLength(1);
  });

  it('does not replay a dispatched report or remove its readable history after notification re-enable', async () => {
    const started = deferred(),
      release = deferred();
    const { ctx, set, sends } = await setup(async () => {
      started.resolve();
      await release.promise;
      return Response.json({ code: 0 });
    });
    set(true);
    const pending = openingReportOperation.run({ notify: true, mode: 'scheduled' }, ctx);
    await started.promise;
    set(false);
    release.resolve();
    const result = await pending;
    expect(result.ok).toBe(true);
    const history = await ctx.repos.report.list();
    expect(history[0]?.deliveryStatus).toBe('sent');
    expect((await getReportTool.execute({ id: history[0]?.id }, ctx)).ok).toBe(true);
    set(true);
    expect((await openingReportOperation.run({ notify: true, mode: 'scheduled' }, ctx)).ok).toBe(
      true,
    );
    expect(sends()).toBe(1);
  });
});
