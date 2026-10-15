import type { ToolContext, ToolResult } from '@luoome/core';
import { addWatchlistMemberTool, createAlertPlanTool, createWatchlistTool } from '@luoome/tools';
import { createHostedWatchNotificationManager } from '@luoome/tools/hosted';
import { buildTestContext } from '@luoome/tools/testing';
import { withFixedQuoteAdapter } from '@luoome/tools/testing/fixed-quote-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostedReportsWorkflow } from './hosted-reports.js';
import { intradayWatchWorkflow } from './intraday-watch.js';

const T0 = new Date('2026-10-15T02:00:00Z');
const data = <T>(result: ToolResult<T>): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.data;
};
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const setup = async (limit = 20, cooldown = 0) => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  let now = T0;
  const prices = { '600519.SH': 90 };
  const base = withFixedQuoteAdapter(await buildTestContext({ clock: () => now }), prices);
  const trusted: ToolContext = {
    ...base,
    identity: {
      mode: 'hosted',
      actor: 'worker',
      userId: base.user.id,
      tenantId: 'fault-tenant',
      tenantGeneration: 1,
      requestId: 'fault',
    },
    hostedAuthorization: async () => null,
  };
  const ctx = {
    ...trusted,
    notification: createHostedWatchNotificationManager(trusted, async () => null),
  };
  data(
    await createWatchlistTool.execute(
      { id: 'fault-list', name: 'fixture', kind: 'personal', membershipPolicy: 'manual' },
      ctx,
    ),
  );
  data(
    await addWatchlistMemberTool.execute({ watchlistId: 'fault-list', stockId: '600519.SH' }, ctx),
  );
  data(
    await createAlertPlanTool.execute(
      {
        id: 'fault-plan',
        name: 'fixture',
        watchlistId: 'fault-list',
        cooldownMinutes: cooldown,
        dailyNotificationLimit: limit,
        rules: [{ id: 'rule', kind: 'price-level', level: 100, side: 'above' }],
      },
      ctx,
    ),
  );
  const settings = await ctx.repos.watchDelivery.settings();
  await ctx.repos.watchDelivery.saveSettings({
    ...settings,
    expectedRevision: settings.revision,
    webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/ds4-fixture',
    now,
  });
  const http = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response('injected refusal', { status: 503 }));
  data(await intradayWatchWorkflow.run({ notify: true }, ctx));
  prices['600519.SH'] = 110;
  return {
    ctx,
    http,
    prices,
    watch: async () => data(await intradayWatchWorkflow.run({ notify: true }, ctx)),
    reports: async () => data(await hostedReportsWorkflow.run({}, ctx)),
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
};

describe('DS-4 delivery faults and accounting', () => {
  it('a failure consumes the tenant global limit once and blocks other plans and due retries without consuming their plan limits', async () => {
    const h = await setup(20);
    const limited = { ...h.ctx, config: { globalDailyLimit: 1 } };
    expect(data(await intradayWatchWorkflow.run({ notify: true }, limited))).toMatchObject({
      notified: 1,
      notifyFailed: 1,
    });
    h.advance(60_000);
    h.prices['600519.SH'] = 90;
    data(
      await createAlertPlanTool.execute(
        {
          id: 'second-plan',
          name: 'second',
          watchlistId: 'fault-list',
          cooldownMinutes: 0,
          dailyNotificationLimit: 20,
          rules: [{ id: 'rule', kind: 'price-level', level: 100, side: 'above' }],
        },
        h.ctx,
      ),
    );
    data(await intradayWatchWorkflow.run({ notify: true }, limited));
    h.prices['600519.SH'] = 110;
    h.advance(1);
    expect(data(await intradayWatchWorkflow.run({ notify: true }, limited))).toMatchObject({
      suppressedByDailyLimit: 2,
      notified: 0,
      notifyFailed: 0,
    });
    expect(await h.ctx.repos.watchTrigger.countAttemptedSince(T0)).toBe(1);
    expect(await h.ctx.repos.watchTrigger.countAttemptedSince(T0, 'fault-plan')).toBe(1);
    expect(await h.ctx.repos.watchTrigger.countAttemptedSince(T0, 'second-plan')).toBe(0);
    expect(h.http).toHaveBeenCalledTimes(1);
    expect((await h.ctx.repos.watchDelivery.list())[0]).toMatchObject({
      attempt: 1,
      state: 'failed',
    });
  });

  it('failed retries, cooldown edges and daily-limit edges charge only actual begun attempts', async () => {
    const h = await setup(3, 10);
    const first = await h.watch();
    expect(first).toMatchObject({ notifyFailed: 1, notified: 1, delivered: 0 });
    const trigger = (await h.ctx.repos.watchTrigger.listRecent({}))[0];
    const counts = async (expected: number) => {
      expect(await h.ctx.repos.watchTrigger.countAttemptedSince(T0)).toBe(expected);
      expect(await h.ctx.repos.watchTrigger.countAttemptedSince(T0, 'fault-plan')).toBe(expected);
      expect(
        (await h.ctx.repos.watchTrigger.findById(trigger?.id as string))?.deliveryAttempts,
      ).toBe(expected);
      expect((await h.ctx.repos.watchDelivery.list())[0]?.attempt).toBe(expected);
      expect(h.http).toHaveBeenCalledTimes(expected);
    };
    await counts(1);
    h.advance(59_999);
    expect(await h.watch()).toMatchObject({ notifyFailed: 0, notified: 0 });
    await counts(1);
    h.advance(1);
    expect(await h.watch()).toMatchObject({ notifyFailed: 1, notified: 1 });
    await counts(2);
    h.advance(299_999);
    expect(await h.watch()).toMatchObject({ notifyFailed: 0, notified: 0 });
    await counts(2);
    h.advance(1);
    expect(await h.watch()).toMatchObject({ notifyFailed: 1, notified: 1 });
    await counts(3);
    expect(
      (await h.ctx.repos.watchTrigger.listRecent({})).filter(
        (item) => item.triggerType === 'triggered',
      ),
    ).toHaveLength(1);
    h.prices['600519.SH'] = 90;
    h.advance(1);
    await h.watch();
    h.prices['600519.SH'] = 110;
    h.advance(1);
    expect(await h.watch()).toMatchObject({
      suppressedByCooldown: 1,
      suppressedByDailyLimit: 0,
      notifyFailed: 0,
      notified: 0,
    });
    await counts(3);
    expect(await h.watch()).toMatchObject({
      suppressedByCooldown: 0,
      suppressedByDailyLimit: 0,
      notifyFailed: 0,
    });
    h.advance(11 * 60_000);
    h.prices['600519.SH'] = 90;
    await h.watch();
    h.prices['600519.SH'] = 110;
    h.advance(1);
    expect(await h.watch()).toMatchObject({
      suppressedByCooldown: 0,
      suppressedByDailyLimit: 1,
      notifyFailed: 0,
      notified: 0,
    });
    await counts(3);
    expect(await h.watch()).toMatchObject({ suppressedByDailyLimit: 0, notifyFailed: 0 });
    await counts(3);
  });

  it('report rejection retries reuse the same frozen facts at 1/5 minutes and never exceed three sends', async () => {
    const h = await setup();
    const first = await h.reports();
    expect(first.created).toHaveLength(1);
    const original = await h.ctx.repos.report.findById(first.created[0] as string);
    for (const [delay, attempts] of [
      [59_999, 1],
      [1, 2],
      [299_999, 2],
      [1, 3],
      [600_000, 3],
    ] as const) {
      h.advance(delay);
      expect(await h.reports()).toMatchObject({ created: [], accepted: [] });
      expect(h.http).toHaveBeenCalledTimes(attempts);
      expect((await h.ctx.repos.reportAutomation.list())[0]).toMatchObject({
        resultRef: original?.id,
        attempt: attempts,
        state: 'failed',
        deliveredAt: null,
      });
      expect(await h.ctx.repos.report.findById(original?.id as string)).toMatchObject({
        sections: original?.sections,
        evidence: original?.evidence,
        dataAsOf: original?.dataAsOf,
        generatedAt: original?.generatedAt,
      });
    }
    expect(await h.ctx.repos.report.list({})).toHaveLength(1);
  });

  it.each(['watch', 'report'] as const)(
    '%s pending without a transport attempt is suppressed by preference revocation',
    async (kind) => {
      const h = await setup();
      const settings = await h.ctx.repos.watchDelivery.settings();
      await h.ctx.repos.watchDelivery.saveSettings({
        ...settings,
        expectedRevision: settings.revision,
        quietHours: {
          enabled: true,
          startMinutes: 600,
          endMinutes: 605,
          timeZone: 'Asia/Shanghai',
        },
        now: h.ctx.clock(),
      });
      if (kind === 'watch')
        expect(await intradayWatchWorkflow.run({ notify: true }, h.ctx)).toMatchObject({
          ok: false,
          error: { kind: 'permission_denied', required: 'notification:quiet-hours' },
        });
      else await h.reports();
      const pending =
        kind === 'watch'
          ? await h.ctx.repos.watchDelivery.list()
          : await h.ctx.repos.reportAutomation.list();
      expect(pending[0]).toMatchObject({ state: 'pending', attempt: 0 });
      expect(h.http).not.toHaveBeenCalled();
      const current = await h.ctx.repos.watchDelivery.settings();
      await h.ctx.repos.watchDelivery.saveSettings({
        ...current,
        expectedRevision: current.revision,
        enabled: false,
        now: h.ctx.clock(),
      });
      h.advance(6 * 60_000);
      if (kind === 'watch') await h.watch();
      else await h.reports();
      const stopped =
        kind === 'watch'
          ? await h.ctx.repos.watchDelivery.list()
          : await h.ctx.repos.reportAutomation.list();
      expect(stopped[0]).toMatchObject({ state: 'suppressed', attempt: 0 });
      expect(h.http).not.toHaveBeenCalled();
      expect(await h.ctx.repos.watchTrigger.countAttemptedSince(T0)).toBe(0);
    },
  );

  it.each(['watch', 'report'] as const)(
    '%s rejects previous Shanghai-day compensation while preserving the original attempted count',
    async (kind) => {
      const h = await setup();
      if (kind === 'watch') await h.watch();
      else await h.reports();
      const original = (
        kind === 'watch'
          ? await h.ctx.repos.watchDelivery.list()
          : await h.ctx.repos.reportAutomation.list()
      )[0];
      expect(original).toMatchObject({ state: 'failed', attempt: 1 });
      h.advance(86_400_000);
      if (kind === 'watch') await h.watch();
      else await h.reports();
      const intents =
        kind === 'watch'
          ? await h.ctx.repos.watchDelivery.list()
          : await h.ctx.repos.reportAutomation.list();
      expect(intents.find((item) => item.id === original?.id)).toMatchObject({
        state: 'suppressed',
        attempt: 1,
        deliveredAt: null,
      });
      if (kind === 'watch') {
        expect(h.http).toHaveBeenCalledTimes(1);
        expect(await h.ctx.repos.watchTrigger.countAttemptedSince(T0)).toBe(1);
      } else {
        // 新交易日的报告可正常发送；旧报告的通知正文只出现一次。
        const oldSends = h.http.mock.calls.filter(([, init]) =>
          String(init?.body).includes('2026-10-15'),
        );
        expect(oldSends).toHaveLength(1);
      }
    },
  );

  it.each(['watch', 'report'] as const)(
    '%s accepted receipts remain distinct from device delivery and do not consume another attempt on replay',
    async (kind) => {
      const h = await setup();
      h.http.mockImplementation(async () => Response.json({ StatusCode: 0 }));
      if (kind === 'watch') await h.watch();
      else await h.reports();
      h.advance(60_000);
      if (kind === 'watch') await h.watch();
      else await h.reports();
      const intents =
        kind === 'watch'
          ? await h.ctx.repos.watchDelivery.list()
          : await h.ctx.repos.reportAutomation.list();
      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject({
        state: 'accepted',
        attempt: 1,
        deliveredAt: null,
        providerMessageId: null,
      });
      expect(h.http).toHaveBeenCalledTimes(1);
      expect(await h.ctx.repos.watchTrigger.countAttemptedSince(T0)).toBe(kind === 'watch' ? 1 : 0);
    },
  );
});
