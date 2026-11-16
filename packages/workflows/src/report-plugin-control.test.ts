import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginExecutionDenied, type ToolContext } from '@luoome/core';
import {
  createPluginExecutionPolicy,
  getReportTool,
  listReportsTool,
  renderReportTool,
  saveReportTool,
  sendNotificationTool,
  setReportDeliveryStatusTool,
} from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FeishuWebhookAdapter,
  NotificationManager,
  PluginConfigStore,
} from '../../adapters/src/index.js';
import { makeReport } from '../../db/src/repository/contract-tests.js';
import { closingReportOperation } from './closing-report.js';
import { closingReportCutoffWorkflow } from './closing-report-cutoff.js';
import { dailyReviewOperation } from './daily-review.js';
import { intradayWatchWorkflow } from './intraday-watch.js';
import { openingReportOperation } from './opening-report.js';
import { reportWorkflow } from './report.js';
import { riskReportWorkflow } from './risk-report.js';
import { weeklyReportOperation } from './weekly-report.js';

const id = 'business.report' as const;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const setup = async (transport?: () => Promise<Response>) => {
  const home = mkdtempSync(join(tmpdir(), 'luoome-report-plugin-'));
  roots.push(home);
  const store = new PluginConfigStore(join(home, 'plugins.json'));
  store.set('business.watch-monitoring', true, store.initialize());
  const policy = createPluginExecutionPolicy(
    store,
    new Set(['read', 'advice', 'write', 'external']),
  );
  const base = await buildTestContext({
    executionPolicy: policy,
    clock: () => new Date('2026-11-16T10:00:00Z'),
  });
  let sends = 0;
  const ctx: ToolContext = {
    ...base,
    adapters: {
      ...base.adapters,
      notification: new NotificationManager({
        repos: base.repos,
        logger: base.logger,
        clock: base.clock,
        feishu: new FeishuWebhookAdapter({
          webhookUrl: 'https://fixture.invalid',
          fetchImpl: async () => {
            sends++;
            return transport === undefined ? Response.json({ code: 0 }) : transport();
          },
        }),
      }),
    },
  };
  const set = (enabled: boolean) => {
    const current = store.read();
    if (!current.ok) throw new Error('fixture absent');
    store.set(id, enabled, current.config);
  };
  return { ctx, policy, store, set, sends: () => sends };
};
const denied = { ok: false, error: { kind: 'permission_denied' } };

describe('report plugin revocation', () => {
  it('starts closed at every generation entrance, while history and watch remain available', async () => {
    const { ctx, sends } = await setup();
    const list = vi.spyOn(ctx.repos.account, 'list');
    for (const [operation, input] of [
      [reportWorkflow, { kind: 'opening' }],
      [openingReportOperation, {}],
      [closingReportOperation, {}],
      [weeklyReportOperation, {}],
      [dailyReviewOperation, {}],
      [riskReportWorkflow, {}],
      [closingReportCutoffWorkflow, {}],
    ] as const)
      expect(await operation.run(input, ctx)).toMatchObject(denied);
    expect(list).not.toHaveBeenCalled();
    expect(await saveReportTool.execute({ report: makeReport('new') }, ctx)).toMatchObject(denied);
    const history = await ctx.repos.report.upsertForPeriod(makeReport('history'));
    expect((await getReportTool.execute({ id: history.id }, ctx)).ok).toBe(true);
    expect((await listReportsTool.execute({}, ctx)).ok).toBe(true);
    expect(
      (await renderReportTool.execute({ reportId: history.id, format: 'markdown' }, ctx)).ok,
    ).toBe(true);
    expect((await intradayWatchWorkflow.run({ notify: false }, ctx)).ok).toBe(true);
    expect(
      (
        await sendNotificationTool.execute(
          { channel: 'log', log: { title: 'general', content: 'independent' } },
          ctx,
        )
      ).ok,
    ).toBe(true);
    expect(sends()).toBe(0);
    expect(await ctx.repos.report.list()).toHaveLength(1);
  });

  it('rejects a late database publication and saved tool/workflow calls after off/on', async () => {
    const { ctx, policy, set, sends } = await setup();
    set(true);
    const old = { ...ctx, executionPolicy: policy.bind() };
    const started = deferred(),
      release = deferred();
    const save = ctx.repos.report.upsertForPeriod.bind(ctx.repos.report);
    vi.spyOn(ctx.repos.report, 'upsertForPeriod').mockImplementation(async (report) => {
      started.resolve();
      await release.promise;
      return save(report);
    });
    const pending = openingReportOperation.run({ notify: true }, old);
    await started.promise;
    set(false);
    expect(policy.activity().find((call) => call.id === id)?.revokedInFlight).toBeGreaterThan(0);
    set(true);
    release.resolve();
    expect(await pending).toMatchObject(denied);
    expect(await ctx.repos.report.list()).toEqual([]);
    expect(sends()).toBe(0);
    expect(await openingReportOperation.run({}, old)).toMatchObject(denied);
    expect(await saveReportTool.execute({ report: makeReport('old') }, old)).toMatchObject(denied);
    expect(
      await setReportDeliveryStatusTool.execute(
        { reportId: 'old', deliveryStatus: 'pending' },
        old,
      ),
    ).toMatchObject(denied);
    expect(
      await sendNotificationTool.execute(
        {
          notificationId: 'report-notification:old',
          reportDelivery: { reportId: 'old', attemptId: 'old' },
          channel: 'log',
          log: { title: 'report', content: 'old' },
        },
        old,
      ),
    ).toMatchObject(denied);
    const { executionPolicy: _policy, ...uncontrolled } = ctx;
    expect(
      await saveReportTool.execute({ report: makeReport('no-policy') }, uncontrolled),
    ).toMatchObject(denied);
    expect((await openingReportOperation.run({ notify: false }, ctx)).ok).toBe(true);
  });

  it('rejects late section results before creating a report, without waiting for a write', async () => {
    const { ctx, set, sends } = await setup();
    set(true);
    const started = deferred(),
      release = deferred();
    const list = ctx.repos.account.list.bind(ctx.repos.account);
    vi.spyOn(ctx.repos.account, 'list').mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return list();
    });
    const pending = openingReportOperation.run({ notify: true }, ctx);
    await started.promise;
    set(false);
    release.resolve();
    expect(await pending).toMatchObject(denied);
    expect(await ctx.repos.report.list()).toEqual([]);
    expect(sends()).toBe(0);
  });

  it('waits for every cutoff worker to drain after one observes revocation', async () => {
    const { ctx, set } = await setup();
    set(true);
    const accounts = await ctx.repos.account.list();
    expect(accounts.length).toBeGreaterThan(1);
    const allStarted = deferred(),
      first = deferred(),
      rest = deferred(),
      deniedAtGuard = deferred();
    const lookup = ctx.repos.report.findByPeriod.bind(ctx.repos.report);
    let calls = 0,
      revoked = false,
      settled = false;
    vi.spyOn(ctx.repos.report, 'findByPeriod').mockImplementation(async (input) => {
      const index = calls++;
      if (calls === accounts.length) allStarted.resolve();
      await (index === 0 ? first.promise : rest.promise);
      return lookup(input);
    });
    const pending = closingReportCutoffWorkflow
      .run(
        {},
        {
          ...ctx,
          executionGuard: () => {
            if (revoked) {
              deniedAtGuard.resolve();
              throw new PluginExecutionDenied('plugin:business.report');
            }
          },
        },
      )
      .then((result) => {
        settled = true;
        return result;
      });
    await allStarted.promise;
    revoked = true;
    set(false);
    first.resolve();
    await deniedAtGuard.promise;
    expect(settled).toBe(false);
    rest.resolve();
    expect(await pending).toMatchObject(denied);
    expect(await ctx.repos.report.list()).toEqual([]);
  });

  it('checks report notification after async lookup before actual transport', async () => {
    const { ctx, set, sends } = await setup();
    set(true);
    const started = deferred(),
      release = deferred();
    const lookup = ctx.repos.notification.findById.bind(ctx.repos.notification);
    vi.spyOn(ctx.repos.notification, 'findById').mockImplementation(async (key) => {
      started.resolve();
      await release.promise;
      return lookup(key);
    });
    const pending = openingReportOperation.run({ notify: true }, ctx);
    await started.promise;
    set(false);
    release.resolve();
    expect(await pending).toMatchObject(denied);
    expect(sends()).toBe(0);
    expect(await ctx.repos.notification.listRecent({})).toEqual([]);
    expect(await ctx.repos.report.list()).toHaveLength(1);
  });

  it('finishes only the actual dispatched receipt while disabled and never resends it after re-enable', async () => {
    const started = deferred(),
      release = deferred();
    const { ctx, policy, set, sends } = await setup(async () => {
      started.resolve();
      await release.promise;
      return Response.json({ code: 0 });
    });
    set(true);
    const pending = openingReportOperation.run({ notify: true, mode: 'scheduled' }, ctx);
    await started.promise;
    set(false);
    expect(policy.activity().find((call) => call.id === id)?.revokedInFlight).toBeGreaterThan(0);
    release.resolve();
    await pending;
    const history = await ctx.repos.report.list();
    expect(history).toHaveLength(1);
    expect(history[0]?.deliveryStatus).toBe('sent');
    expect(await ctx.repos.notification.listRecent({})).toHaveLength(1);
    set(true);
    expect((await openingReportOperation.run({ notify: true, mode: 'scheduled' }, ctx)).ok).toBe(
      true,
    );
    expect(sends()).toBe(1);
    expect(await ctx.repos.report.list()).toHaveLength(1);
  });
});
