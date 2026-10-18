import type { ToolContext, ToolResult } from '@luoome/core';
import { addWatchlistMemberTool, createAlertPlanTool, createWatchlistTool } from '@luoome/tools';
import {
  createHostedWatchNotificationManager,
  resolveHostedWatchNotificationTool,
} from '@luoome/tools/hosted';
import { buildTestContext } from '@luoome/tools/testing';
import { withFixedQuoteAdapter } from '@luoome/tools/testing/fixed-quote-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateEventRulesWorkflow } from './evaluate-event-rules.js';
import { intradayWatchWorkflow } from './intraday-watch.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const setup = async (event = false, configured = true) => {
  let now = new Date('2026-10-15T02:00:00Z');
  const prices = { '600519.SH': 90 };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const base = withFixedQuoteAdapter(await buildTestContext({ clock: () => now, logger }), prices);
  await createWatchlistTool.execute(
    { id: 'list', name: 'fixture', kind: 'personal', membershipPolicy: 'manual' },
    base,
  );
  await addWatchlistMemberTool.execute({ watchlistId: 'list', stockId: '600519.SH' }, base);
  await createAlertPlanTool.execute(
    {
      id: 'plan',
      name: 'fixture',
      watchlistId: 'list',
      rules: event
        ? [{ id: 'rule', kind: 'event-date', daysBefore: [3] }]
        : [{ id: 'rule', kind: 'price-level', level: 100, side: 'above' }],
      cooldownMinutes: 0,
    },
    base,
  );
  if (event)
    await base.repos.stockEvent.save({
      id: 'event',
      stockId: '600519.SH',
      kind: 'earnings',
      title: 'fixture earnings',
      occursAt: new Date('2026-10-18T02:00:00Z'),
      allDay: true,
      importance: 'important',
      status: 'scheduled',
      source: 'manual',
      stale: false,
      remindBeforeDays: [],
      createdAt: now,
      updatedAt: now,
    });
  const initial = await base.repos.watchDelivery.settings();
  if (configured)
    await base.repos.watchDelivery.saveSettings({
      ...initial,
      expectedRevision: initial.revision,
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/fixture-only',
      now,
    });
  const trusted: ToolContext = {
    ...base,
    identity: {
      mode: 'hosted',
      actor: 'worker',
      tenantId: 'tenant-A',
      tenantGeneration: 1,
      userId: 'user-A',
      requestId: 'fixture',
    },
    hostedAuthorization: async () => null,
  };
  let authorize: () => Promise<ToolResult<never> | null> = async () => null;
  const ctx = {
    ...trusted,
    notification: createHostedWatchNotificationManager(trusted, () => authorize()),
  };
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  const http = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ StatusCode: 0 })));
  // Response bodies are single-use; every transport attempt gets its own acknowledgement.
  http.mockImplementation(async () => new Response(JSON.stringify({ StatusCode: 0 })));
  const run = (notify = true) => intradayWatchWorkflow.run({ notify }, ctx);
  if (!event) await run();
  prices['600519.SH'] = 110;
  return {
    ctx,
    prices,
    run,
    advance,
    http,
    logger,
    setAuthorize: (next: typeof authorize) => {
      authorize = next;
    },
  };
};

describe('hosted watch delivery', () => {
  it('opens the exact trigger with current AlertPlan state and refuses a foreign account source', async () => {
    const { ctx, run } = await setup();
    await run();
    const trigger = (await ctx.repos.watchTrigger.listRecent({}))[0];
    if (trigger === undefined) throw new Error('fixture trigger missing');
    expect(
      await resolveHostedWatchNotificationTool.execute({ triggerId: trigger.id }, ctx),
    ).toMatchObject({
      ok: true,
      data: {
        trigger: { id: trigger.id },
        alertPlan: { id: 'plan', enabled: true },
        state: 'requires-recheck',
        currentActionAllowed: false,
      },
    });
    const plan = await ctx.repos.alertPlan.findById('plan');
    if (plan === null) throw new Error('fixture plan missing');
    await ctx.repos.alertPlan.save({ ...plan, enabled: false });
    expect(
      await resolveHostedWatchNotificationTool.execute({ triggerId: trigger.id }, ctx),
    ).toMatchObject({
      ok: true,
      data: { alertPlan: { enabled: false }, state: 'changed', currentActionAllowed: false },
    });
    const foreign = {
      ...trigger,
      id: 'foreign-source',
      poolId: 'trading-plan-watch:other-account',
    };
    await ctx.repos.watchTrigger.save(foreign);
    expect(
      await resolveHostedWatchNotificationTool.execute({ triggerId: foreign.id }, ctx),
    ).toMatchObject({ ok: false, error: { kind: 'not_found' } });
    expect(
      await resolveHostedWatchNotificationTool.execute({ triggerId: 'missing' }, ctx),
    ).toMatchObject({ ok: false, error: { kind: 'not_found' } });
  });
  it('heartbeats retain exclusive execution while an upstream request is in flight', async () => {
    const { ctx, run, advance, http } = await setup();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const batch = ctx.adapters.market.batchQuote.bind(ctx.adapters.market);
    ctx.adapters.market.batchQuote = async (ids) => {
      const quotes = await batch(ids);
      for (let tick = 0; tick < 5; tick += 1) {
        advance(30_000);
        await vi.advanceTimersByTimeAsync(30_000);
      }
      expect(
        await ctx.repos.watchTrigger.acquireExecution(
          'competing-worker',
          ctx.clock(),
          new Date(ctx.clock().getTime() + 120_000),
        ),
      ).toBe(false);
      return quotes;
    };
    expect((await run()).ok).toBe(true);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('preview preserves edges; concurrent execution and restart retain one trigger and accepted intent', async () => {
    const { ctx, run, http } = await setup();
    expect((await run(false)).ok).toBe(true);
    expect(await ctx.repos.watchTrigger.listRecent({})).toEqual([]);
    expect(await ctx.repos.watchDelivery.list()).toEqual([]);
    const outcomes = await Promise.all([run(), run()]);
    expect(outcomes.filter((result) => result.ok)).toHaveLength(1);
    expect(await ctx.repos.watchTrigger.listRecent({})).toHaveLength(1);
    expect(http).toHaveBeenCalledTimes(1);
    expect((await ctx.repos.watchDelivery.list())[0]).toMatchObject({
      state: 'accepted',
      attempt: 1,
      deliveredAt: null,
      providerMessageId: null,
      tenantId: 'tenant-A',
    });
    const restarted = {
      ...ctx,
      notification: createHostedWatchNotificationManager(ctx, async () => null),
    };
    await intradayWatchWorkflow.run({ notify: true }, restarted);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('uses fallback-log without configuration and never automatically retries it', async () => {
    const { ctx, run, http, advance, logger } = await setup(false, false);
    const result = await run();
    expect(result.ok).toBe(true);
    expect((await ctx.repos.watchTrigger.listRecent({}))[0]?.deliveryStatus).toBe('fallback-log');
    expect((await ctx.repos.watchDelivery.list())[0]).toMatchObject({
      state: 'suppressed',
      errorKind: 'fallback-log',
      deliveredAt: null,
    });
    advance(600_000);
    await run();
    expect(http).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'watch notification fallback-log',
      expect.objectContaining({ triggerCount: 1 }),
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('600519');
  });

  it('bounds confirmed failures to three attempts with one/five minute backoff', async () => {
    const { ctx, run, http, advance } = await setup();
    http.mockImplementation(async () => new Response('rejected', { status: 503 }));
    await run();
    advance(59_999);
    await run();
    expect(http).toHaveBeenCalledTimes(1);
    advance(1);
    await run();
    expect(http).toHaveBeenCalledTimes(2);
    advance(299_999);
    await run();
    expect(http).toHaveBeenCalledTimes(2);
    advance(1);
    await run();
    expect(http).toHaveBeenCalledTimes(3);
    advance(300_000);
    await run();
    expect(http).toHaveBeenCalledTimes(3);
    expect((await ctx.repos.watchDelivery.list())[0]).toMatchObject({
      state: 'failed',
      attempt: 3,
    });
    expect((await ctx.repos.watchTrigger.listRecent({}))[0]?.deliveryAttempts).toBe(3);
  });

  it('keeps an uncertain provider outcome unknown without blind retries', async () => {
    const { ctx, run, http, advance } = await setup();
    http.mockRejectedValue(new TypeError('fixture transport interrupted'));
    await run();
    expect((await ctx.repos.watchDelivery.list())[0]?.state).toBe('unknown');
    advance(600_000);
    await run();
    expect(http).toHaveBeenCalledTimes(1);
    expect((await ctx.repos.watchTrigger.listRecent({}))[0]?.deliveryStatus).toBe('unverifiable');
  });

  it.each(['expired', 'paused', 'member-left', 'revoked'] as const)(
    'blocks an unsent reminder when %s occurs after evaluation',
    async (condition) => {
      const { ctx, run, http, setAuthorize } = await setup();
      setAuthorize(async () => {
        if (condition === 'expired')
          return {
            ok: false,
            error: { kind: 'permission_denied', required: 'entitlement:expired' },
          };
        if (condition === 'paused') {
          const plan = await ctx.repos.alertPlan.findById('plan');
          if (!plan) throw new Error('fixture plan missing');
          await ctx.repos.alertPlan.save({ ...plan, enabled: false });
        } else if (condition === 'member-left') {
          const member = (await ctx.repos.watchlistMember.listMembers('list'))[0];
          if (!member) throw new Error('fixture member missing');
          await ctx.repos.watchlistMember.saveMember({
            ...member,
            stage: 'archived',
            archivedAt: ctx.clock(),
          });
        } else {
          const settings = await ctx.repos.watchDelivery.settings();
          await ctx.repos.watchDelivery.saveSettings({
            ...settings,
            expectedRevision: settings.revision,
            enabled: false,
            now: ctx.clock(),
          });
        }
        return null;
      });
      await run();
      expect(http).not.toHaveBeenCalled();
      expect((await ctx.repos.watchDelivery.list())[0]?.state).toBe('suppressed');
    },
  );

  it('keeps quiet-hour pending attempts unconsumed until the quiet interval ends', async () => {
    const { ctx, run, http, advance } = await setup();
    const settings = await ctx.repos.watchDelivery.settings();
    await ctx.repos.watchDelivery.saveSettings({
      ...settings,
      expectedRevision: settings.revision,
      quietHours: { enabled: true, startMinutes: 600, endMinutes: 601, timeZone: 'Asia/Shanghai' },
      now: ctx.clock(),
    });
    await run();
    expect((await ctx.repos.watchTrigger.listRecent({}))[0]?.deliveryAttempts).toBeUndefined();
    expect(http).not.toHaveBeenCalled();
    advance(60_000);
    await run();
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('deduplicates event facts and lets the intraday loop compensate an event send failure', async () => {
    const { ctx, http, advance, run } = await setup(true);
    http.mockImplementationOnce(async () => new Response('rejected', { status: 503 }));
    const first = await evaluateEventRulesWorkflow.run({ mode: 'daemon' }, ctx);
    expect(first.ok).toBe(true);
    expect(http).toHaveBeenCalledTimes(1);
    advance(60_000);
    await run();
    expect(http).toHaveBeenCalledTimes(2);
    await evaluateEventRulesWorkflow.run({ mode: 'daemon' }, ctx);
    expect(http).toHaveBeenCalledTimes(2);
    expect(await ctx.repos.watchTrigger.listRecent({})).toHaveLength(1);
    expect((await ctx.repos.watchDelivery.list())[0]).toMatchObject({
      state: 'accepted',
      attempt: 2,
      deliveredAt: null,
    });
  });
});
