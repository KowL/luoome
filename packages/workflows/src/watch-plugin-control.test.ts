import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@luoome/core';
import {
  addWatchlistMemberTool,
  createAlertPlanTool,
  createPluginExecutionPolicy,
  createWatchlistTool,
  listWatchTriggersTool,
  saveWatchTriggerTool,
  sendNotificationTool,
  setWatchTriggerFeedbackTool,
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
import { makeWatchTrigger } from '../../db/src/repository/contract-tests.js';
import { intradayWatchWorkflow } from './intraday-watch.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const id = 'business.watch-monitoring' as const;
const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const setup = async (transport?: (input: string, init?: RequestInit) => Promise<Response>) => {
  const home = mkdtempSync(join(tmpdir(), 'luoome-watch-plugin-'));
  roots.push(home);
  const store = new PluginConfigStore(join(home, 'plugins.json'));
  store.set('source.sina', true, store.set('business.notification', true, store.initialize()));
  const policy = createPluginExecutionPolicy(
    store,
    new Set(['read', 'advice', 'write', 'external']),
  );
  let now = new Date('2026-11-16T02:00:00Z');
  const base = await buildTestContext({ executionPolicy: policy, clock: () => now });
  const prices = { '600519.SH': 90 };
  const quoted = withFixedQuoteAdapter(base, prices);
  const quotes = vi.spyOn(quoted.adapters.market, 'batchQuote');
  const providerRuntime = new ProviderRuntime(store);
  let sends = 0;
  const ctx: ToolContext = {
    ...quoted,
    dataScope: providerRuntime,
    adapters: {
      ...quoted.adapters,
      market: providerRuntime.wrap('market', ['sina'], () => quoted.adapters.market),
      notification: new NotificationManager({
        repos: base.repos,
        logger: base.logger,
        clock: () => now,
        feishu: new FeishuWebhookAdapter({
          webhookUrl: 'https://fixture.invalid',
          fetchImpl: async (...args) => {
            sends++;
            return transport === undefined ? Response.json({ code: 0 }) : transport(...args);
          },
        }),
      }),
    },
  };
  expect(
    (
      await createWatchlistTool.execute(
        { id: 'watch-list', name: 'fixture', kind: 'personal', membershipPolicy: 'manual' },
        ctx,
      )
    ).ok,
  ).toBe(true);
  await addWatchlistMemberTool.execute({ watchlistId: 'watch-list', stockId: '600519.SH' }, ctx);
  expect(
    (
      await createAlertPlanTool.execute(
        {
          id: 'watch-alert',
          name: 'fixture alert',
          watchlistId: 'watch-list',
          rules: [{ id: 'above', kind: 'price-level', side: 'above', level: 100 }],
          cooldownMinutes: 0,
          priority: 'important',
        },
        ctx,
      )
    ).ok,
  ).toBe(true);
  const set = (enabled: boolean) => {
    const current = store.read();
    if (!current.ok) throw new Error('fixture absent');
    return store.set(id, enabled, current.config);
  };
  const advance = () => {
    now = new Date(now.getTime() + 60000);
  };
  const bootstrap = async () => {
    set(true);
    expect((await intradayWatchWorkflow.run({ notify: true }, ctx)).ok).toBe(true);
    advance();
    prices['600519.SH'] = 110;
  };
  return { ctx, quotes, policy, store, set, advance, prices, bootstrap, sends: () => sends };
};

describe('watch plugin revocation', () => {
  it('starts closed, preserves configuration/history/feedback and leaves unrelated notifications available', async () => {
    const { ctx, sends, quotes } = await setup();
    for (const notify of [false, true])
      expect(await intradayWatchWorkflow.run({ notify }, ctx)).toMatchObject({
        ok: false,
        error: { kind: 'permission_denied' },
      });
    expect(quotes).not.toHaveBeenCalled();
    expect(sends()).toBe(0);
    expect(await saveWatchTriggerTool.execute(makeWatchTrigger('new'), ctx)).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
    await ctx.repos.watchTrigger.save(
      makeWatchTrigger('history', {
        poolId: 'watch-alert',
        alertPlanId: 'watch-alert',
        stockId: '600519.SH',
      }),
    );
    expect(await listWatchTriggersTool.execute({}, ctx)).toMatchObject({
      ok: true,
      data: { triggers: [{ id: 'history' }] },
    });
    expect(
      (await setWatchTriggerFeedbackTool.execute({ triggerId: 'history', feedback: 'useful' }, ctx))
        .ok,
    ).toBe(true);
    expect(
      (
        await sendNotificationTool.execute(
          { channel: 'log', log: { title: 'report', content: 'independent report' } },
          ctx,
        )
      ).ok,
    ).toBe(true);
  });

  it('fences late trigger/state commits and saved contexts after off/on', async () => {
    const { ctx, policy, set, bootstrap, sends } = await setup();
    await bootstrap();
    const before = await ctx.repos.watchRuleState.listByPool('watch-alert');
    const started = deferred(),
      release = deferred();
    const commit = ctx.repos.watchTrigger.commitEvaluation.bind(ctx.repos.watchTrigger);
    vi.spyOn(ctx.repos.watchTrigger, 'commitEvaluation').mockImplementation(async (input) => {
      started.resolve();
      await release.promise;
      return commit(input);
    });
    const old = { ...ctx, executionPolicy: policy.bind() };
    const pending = intradayWatchWorkflow.run({ notify: true }, old);
    await started.promise;
    set(false);
    set(true);
    release.resolve();
    expect(await pending).toMatchObject({ ok: false, error: { kind: 'permission_denied' } });
    expect(await ctx.repos.watchTrigger.listRecent({})).toEqual([]);
    expect(await ctx.repos.watchRuleState.listByPool('watch-alert')).toEqual(before);
    expect(sends()).toBe(0);
    expect(await intradayWatchWorkflow.run({ notify: false }, old)).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
    expect(await saveWatchTriggerTool.execute(makeWatchTrigger('old'), old)).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
  });

  it('rechecks after asynchronous notification lookup before actual transport', async () => {
    const { ctx, set, bootstrap, sends } = await setup();
    await bootstrap();
    const started = deferred(),
      release = deferred();
    const lookup = ctx.repos.notification.findById.bind(ctx.repos.notification);
    vi.spyOn(ctx.repos.notification, 'findById').mockImplementation(async (key) => {
      started.resolve();
      await release.promise;
      return lookup(key);
    });
    const pending = intradayWatchWorkflow.run({ notify: true }, ctx);
    await started.promise;
    set(false);
    release.resolve();
    expect(await pending).toMatchObject({ ok: false, error: { kind: 'permission_denied' } });
    expect(sends()).toBe(0);
    expect(await ctx.repos.notification.listRecent({})).toEqual([]);
  });

  it('finishes only the already dispatched receipt while disabled and never resends it after re-enable', async () => {
    const started = deferred(),
      release = deferred();
    const { ctx, policy, set, bootstrap, sends, advance } = await setup(async () => {
      started.resolve();
      await release.promise;
      return Response.json({ code: 0 });
    });
    await bootstrap();
    const pending = intradayWatchWorkflow.run({ notify: true }, ctx);
    await started.promise;
    set(false);
    expect(policy.activity().find((call) => call.id === id)?.revokedInFlight).toBeGreaterThan(0);
    release.resolve();
    expect(await pending).toMatchObject({ ok: false, error: { kind: 'permission_denied' } });
    const history = await ctx.repos.watchTrigger.listRecent({});
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ deliveryStatus: 'sent', deliveryAttempts: 1 });
    expect(await ctx.repos.notification.listRecent({})).toHaveLength(1);
    set(true);
    advance();
    expect((await intradayWatchWorkflow.run({ notify: true }, ctx)).ok).toBe(true);
    expect(sends()).toBe(1);
    expect(await ctx.repos.watchTrigger.listRecent({})).toHaveLength(1);
  });

  it('rejects an old marked notification call without affecting general send permissions', async () => {
    const { ctx, policy, set } = await setup();
    set(true);
    const old = { ...ctx, executionPolicy: policy.bind() };
    set(false);
    set(true);
    expect(
      await sendNotificationTool.execute(
        {
          channel: 'log',
          log: { title: 'watch', content: 'old' },
          watchDelivery: { owner: 'intraday-watch', triggerIds: ['old'] },
        },
        old,
      ),
    ).toMatchObject({ ok: false, error: { kind: 'permission_denied' } });
    const { executionPolicy: _policy, ...uncontrolled } = ctx;
    expect(
      await saveWatchTriggerTool.execute(makeWatchTrigger('no-policy'), uncontrolled),
    ).toMatchObject({ ok: false, error: { kind: 'permission_denied' } });
  });
});
