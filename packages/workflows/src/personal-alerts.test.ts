import { createHash } from 'node:crypto';
import {
  money,
  PersonalAlertPlanConfigSchema,
  type ToolContext,
  WatchlistSchema,
} from '@luoome/core';
import {
  commitWatchlistImportTool,
  preparePersonalAlertRequestTool,
  previewWatchlistImportTool,
  savePersonalAlertPlanTool,
} from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it, vi } from 'vitest';
import { personalAlertsWorkflow } from './personal-alerts.js';

const initialNow = new Date('2026-10-12T02:00:00Z');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fixture = async () => {
  const state = { now: initialNow, close: 90 };
  const base = await buildTestContext({
    clock: () => state.now,
    marketTimestampSource: 'upstream',
    advices: [],
  });
  for (const account of await base.repos.account.list())
    await base.repos.account.remove(account.id);
  const ctx: ToolContext = {
    ...base,
    user: { id: 'owner', defaultAccountId: '' },
    identity: {
      mode: 'hosted',
      actor: 'worker',
      userId: 'owner',
      tenantId: 'tenant-one',
      tenantGeneration: 1,
      requestId: 'worker',
    },
    hostedAuthorization: async () => null,
  };
  await ctx.repos.watchlist.save(
    WatchlistSchema.parse({
      id: 'personal',
      name: '我的自选',
      kind: 'personal',
      membershipPolicy: 'mixed',
      enabled: true,
      createdAt: initialNow,
      updatedAt: initialNow,
    }),
  );
  const preview = await previewWatchlistImportTool.execute(
    { watchlistId: 'personal', content: '600519', format: 'text' },
    ctx,
  );
  if (!preview.ok) throw new Error('preview failed');
  const imported = await commitWatchlistImportTool.execute(
    {
      previewId: preview.data.preview.id,
      inputHash: preview.data.preview.inputHash,
      requestId: 'import',
      selections: [{ row: 1, stockId: '600519.SH' }],
      excludedRows: [],
      maxDistinctStocks: 50,
    },
    ctx,
  );
  if (!imported.ok) throw new Error('import failed');
  const plan = PersonalAlertPlanConfigSchema.parse({
    id: 'price-plan',
    name: '用户条件',
    watchlistId: 'personal',
    rules: [{ id: 'above', kind: 'price-level', level: 100, side: 'above' }],
    logic: 'ANY',
    triggerMode: 'on-enter',
    cooldownMinutes: 15,
    dailyNotificationLimit: 5,
    notifyOnRecovery: true,
    enabled: true,
  });
  const saved = await savePersonalAlertPlanTool.execute(
    {
      plan,
      expectedPlanRevision: null,
      requestId: 'enable',
      enableConfirmed: true,
      maxEnabledRules: 20,
      maxDailyNotifications: 20,
      minCooldownMinutes: 15,
    },
    ctx,
  );
  if (!saved.ok) throw new Error(JSON.stringify(saved.error));
  const provider = vi
    .spyOn(ctx.adapters.market, 'batchQuote')
    .mockImplementation(async (stockIds) => {
      const quotes = await Promise.all(
        stockIds.map(async (stockId) => {
          const quote = await ctx.adapters.market.fetchQuote(stockId);
          return [
            stockId,
            {
              ...quote,
              close: money(state.close),
              prevClose: money(100),
              high: money(Math.max(100, state.close)),
              low: money(Math.min(100, state.close)),
            },
          ] as const;
        }),
      );
      return new Map(quotes);
    });
  return { ctx, state, provider, saved: saved.data };
};
const claim = async (ctx: ToolContext, operationId: string) => {
  const prepared = await preparePersonalAlertRequestTool.execute(
    { watchlistId: 'personal', period: '2026-10-12', maxDailyNotifications: 20 },
    ctx,
  );
  const tenant = ctx.repos.hostedTenant;
  if (!prepared.ok || tenant === undefined) throw new Error('prepare failed');
  const inputHash = hash(prepared.data.input);
  await tenant.putExecutionRequest({
    operationId,
    inputHash,
    generation: 1,
    kind: 'watch-alerts',
    input: prepared.data.input,
    createdAt: ctx.clock(),
  });
  const lease = await tenant.claimExecution({
    operationId,
    generation: 1,
    attemptId: `${operationId}-attempt`,
    now: ctx.clock(),
    leaseMs: 120_000,
  });
  if (lease.kind !== 'claimed') throw new Error('claim failed');
  return {
    operationId,
    inputHash,
    generation: 1,
    fence: lease.lease.fence,
    attemptId: lease.lease.attemptId,
  };
};

describe('personal-alerts worker workflow', () => {
  it('initializes then commits an account-free watch edge and recovers receipt without fetching again', async () => {
    const { ctx, state, provider } = await fixture();
    const model = vi.spyOn(ctx.adapters.llm, 'generate');
    const quotes = vi.spyOn(ctx.repos.quote, 'save');
    if (ctx.notification === undefined) throw new Error('notification fixture missing');
    const notifications = vi.spyOn(ctx.notification, 'send');
    const baseline = await personalAlertsWorkflow.run(await claim(ctx, 'baseline'), ctx);
    expect(baseline).toMatchObject({
      ok: true,
      data: { evaluation: { mode: 'formal', triggers: [], initializedCount: 1 } },
    });
    state.close = 110;
    state.now = new Date(initialNow.getTime() + 15_000);
    const input = await claim(ctx, 'entered');
    const entered = await personalAlertsWorkflow.run(input, ctx);
    if (!entered.ok) throw new Error(JSON.stringify(entered.error));
    expect(entered.data.evaluation.triggers).toHaveLength(1);
    const trigger = entered.data.evaluation.triggers[0];
    expect(trigger).toMatchObject({
      direction: 'watch',
      ruleKind: 'price-level',
      deliveryStatus: 'pending',
    });
    const event = (await ctx.repos.hostedTenant?.listOutbox())?.find(
      (event) => event.operationId === input.operationId,
    );
    expect(event).toMatchObject({
      notificationPolicy: 'never',
      deliveries: [{ resultRef: trigger?.id, notificationPolicy: 'eligible' }],
    });
    expect(await personalAlertsWorkflow.run(input, ctx)).toMatchObject({
      ok: true,
      data: { evaluation: entered.data.evaluation, receipt: entered.data.receipt, replayed: true },
    });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(model).not.toHaveBeenCalled();
    expect(notifications).not.toHaveBeenCalled();
    expect(quotes).not.toHaveBeenCalled();
    expect(await ctx.repos.account.list()).toHaveLength(0);
    expect(
      await ctx.repos.watchTrigger.acquireExecution(
        'after-workflow',
        state.now,
        new Date(state.now.getTime() + 60_000),
      ),
    ).toBe(true);
    await ctx.repos.watchTrigger.releaseExecution('after-workflow');
  });
  it('records unavailable quotes as partial while preserving the known edge and releasing the domain lease', async () => {
    const { ctx, state, provider } = await fixture();
    state.close = 110;
    const baseline = await personalAlertsWorkflow.run(await claim(ctx, 'baseline'), ctx);
    expect(baseline.ok).toBe(true);
    const previous = await ctx.repos.watchRuleState.listByPool('price-plan');
    state.now = new Date(initialNow.getTime() + 5000);
    provider.mockRejectedValueOnce(new Error('provider unavailable'));
    const missing = await personalAlertsWorkflow.run(await claim(ctx, 'missing'), ctx);
    expect(missing).toMatchObject({
      ok: true,
      data: {
        receipt: { status: 'partial' },
        evaluation: { triggers: [], conditions: [{ known: false }] },
      },
    });
    expect(await ctx.repos.watchRuleState.listByPool('price-plan')).toEqual(previous);
    expect(
      await ctx.repos.watchTrigger.acquireExecution(
        'after-partial',
        state.now,
        new Date(state.now.getTime() + 60_000),
      ),
    ).toBe(true);
    await ctx.repos.watchTrigger.releaseExecution('after-partial');
  });
  it('checks frozen members and rules before any provider call', async () => {
    const { ctx, provider, saved } = await fixture();
    const input = await claim(ctx, 'stale');
    const changed = await savePersonalAlertPlanTool.execute(
      {
        plan: {
          ...saved.plan,
          rules: [{ id: 'above', kind: 'price-level', level: 200, side: 'above' }],
        },
        expectedPlanRevision: saved.planRevision,
        requestId: 'edit',
        enableConfirmed: true,
        maxEnabledRules: 20,
        maxDailyNotifications: 20,
        minCooldownMinutes: 15,
      },
      ctx,
    );
    expect(changed.ok).toBe(true);
    expect(await personalAlertsWorkflow.run(input, ctx)).toMatchObject({
      ok: false,
      error: { kind: 'invalid_input' },
    });
    expect(provider).not.toHaveBeenCalled();
    expect(await ctx.repos.hostedTenant?.getReceipt(input.operationId)).toBeNull();
    expect(await ctx.repos.hostedTenant?.listOutbox()).toHaveLength(0);
  });
  it('cannot commit after a provider delay loses the tenant fence, and cannot release a newer domain owner', async () => {
    const { ctx, state, provider } = await fixture();
    const input = await claim(ctx, 'delayed');
    provider.mockImplementationOnce(async () => {
      state.now = new Date(initialNow.getTime() + 121_000);
      const next = await ctx.repos.hostedTenant?.claimExecution({
        operationId: input.operationId,
        generation: 1,
        attemptId: 'new-attempt',
        now: state.now,
        leaseMs: 120_000,
      });
      expect(next?.kind).toBe('claimed');
      expect(
        await ctx.repos.watchTrigger.acquireExecution(
          'new-domain-owner',
          state.now,
          new Date(state.now.getTime() + 120_000),
        ),
      ).toBe(true);
      return new Map([['600519.SH', await ctx.adapters.market.fetchQuote('600519.SH')]]);
    });
    expect(await personalAlertsWorkflow.run(input, ctx)).toMatchObject({
      ok: false,
      error: { kind: 'invariant_violation' },
    });
    expect(await ctx.repos.hostedTenant?.getReceipt(input.operationId)).toBeNull();
    expect(await ctx.repos.watchRuleState.listByPool('price-plan')).toHaveLength(0);
    expect(await ctx.repos.watchTrigger.listByPool('price-plan')).toHaveLength(0);
    expect(await ctx.repos.hostedTenant?.listOutbox()).toHaveLength(0);
    expect(
      await ctx.repos.watchTrigger.acquireExecution(
        'unexpected-owner',
        state.now,
        new Date(state.now.getTime() + 120_000),
      ),
    ).toBe(false);
    await ctx.repos.watchTrigger.releaseExecution('new-domain-owner');
  });
  it('refuses formal user workflow execution even with a persisted private request', async () => {
    const { ctx, provider } = await fixture();
    const input = await claim(ctx, 'private-request');
    const userCtx: ToolContext = {
      ...ctx,
      identity: {
        mode: 'hosted',
        actor: 'user',
        userId: 'owner',
        tenantId: 'tenant-one',
        tenantGeneration: 1,
        requestId: 'browser',
      },
    };
    expect(await personalAlertsWorkflow.run(input, userCtx)).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied', required: 'actor:worker' },
    });
    expect(provider).not.toHaveBeenCalled();
    expect(await ctx.repos.hostedTenant?.getReceipt(input.operationId)).toBeNull();
  });
});
