import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixtureEmailOtpAdapter } from '@luoome/adapters/hosted';
import { money, QuoteSchema, type ToolResult, TradingPlanSchema } from '@luoome/core';
import {
  addHoldingTool,
  buildContext,
  createPortfolioCashFlowTool,
  getAccountFactsTool,
  getDecisionReviewContextTool,
  recordDecisionTradeTool,
} from '@luoome/tools';
import { resolveHostedWatchNotificationTool } from '@luoome/tools/hosted';
import { runHostedWatchPass } from '../../worker/src/watch.js';
import { openHostedService } from './hosted-composition.js';
import { loadHostedConfig } from './hosted-config.js';
import { createHostedWebApp } from './hosted-server.js';
import { runHostedWorkerOnce } from './hosted-worker.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'luoome-ds2-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  let now = new Date('2026-10-15T02:00:00Z');
  let price = 90;
  const origin = 'https://ds2.example.invalid';
  const config = loadHostedConfig({
    HOSTED_ENVIRONMENT: 'development',
    HOSTED_DATA_ROOT: root,
    PUBLIC_ORIGIN: origin,
    HOSTED_AUTH_SECRET: 'ds2-fixture-auth-secret-32-characters',
    HOSTED_PRODUCT_POLICY: 'hosted-web-v2',
    HOSTED_PROVIDER_MODE: 'fixture',
    HOSTED_REGISTRATION_ENABLED: 'true',
    LUOOME_EXPOSE_WRITE: 'true',
    LUOOME_EXPOSE_EXTERNAL: 'true',
  });
  const service = openHostedService(config, undefined, () => now);
  cleanups.push(service.close);
  const market = spyOn(service.providers.market, 'batchQuote').mockImplementation(
    async (ids) =>
      new Map(
        ids.map((stockId) => [
          stockId,
          QuoteSchema.parse({
            stockId,
            observedAt: now,
            fetchedAt: now,
            ts: now,
            timestampSource: 'upstream',
            open: price,
            high: price,
            low: price,
            close: price,
            volume: 100,
            source: 'fixture',
          }),
        ]),
      ),
  );
  cleanups.push(() => market.mockRestore());
  const app = createHostedWebApp({
    config,
    repos: service.repos,
    runtimes: service.runtimes,
    maintenance: service.maintenance,
    market: service.providers.market,
    emailOtp: service.providers.emailOtp,
    notification: service.providers.notification,
    jobPolicies: service.providers.jobPolicies,
    clock: () => now,
  });
  const request = async (
    path: string,
    input?: unknown,
    auth?: { cookie: string; csrf: string },
    method = input === undefined ? 'GET' : 'POST',
    extra: Record<string, string> = {},
  ) => {
    const response = await app.fetch(
      new Request(`${origin}${path}`, {
        method,
        headers: {
          origin,
          'content-type': 'application/json',
          ...(auth === undefined ? {} : { cookie: auth.cookie, 'x-csrf-token': auth.csrf }),
          ...extra,
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      }),
    );
    return { response, result: (await response.json()) as ToolResult<Record<string, unknown>> };
  };
  const login = async (email: string) => {
    const challenge = await request('/api/auth/challenges', { email });
    if (!challenge.result.ok) throw new Error('fixture challenge failed');
    if (!(service.providers.emailOtp instanceof FixtureEmailOtpAdapter))
      throw new Error('fixture email missing');
    const code = service.providers.emailOtp.getMessage(
      challenge.result.data.challengeId as string,
    )?.code;
    const login = await request('/api/auth/sessions', {
      challengeId: challenge.result.data.challengeId,
      code,
      password: 'ds2-fixture-password',
      acceptTerms: true,
    });
    if (!login.result.ok) throw new Error('fixture login failed');
    const cookie = login.response.headers.get('set-cookie')?.split(';')[0] as string;
    const me = await request('/api/me', undefined, { cookie, csrf: '' });
    if (!me.result.ok) throw new Error('fixture me failed');
    await runHostedWorkerOnce(service, 'fixture-provisioner');
    return {
      cookie,
      csrf: me.result.data.csrfToken as string,
      tenantId: (me.result.data.tenant as { id: string }).id,
    };
  };
  const seed = async (auth: Awaited<ReturnType<typeof login>>, event = false) => {
    expect(
      (
        await request(
          '/api/watchlists',
          { id: 'list', name: 'fixture', kind: 'personal', membershipPolicy: 'manual' },
          auth,
        )
      ).result.ok,
    ).toBe(true);
    expect(
      (await request('/api/watchlists/list/members', { stockId: '600519.SH' }, auth)).result.ok,
    ).toBe(true);
    expect(
      (
        await request(
          '/api/alert-plans',
          {
            id: 'plan',
            name: 'fixture',
            watchlistId: 'list',
            cooldownMinutes: 0,
            rules: event
              ? [{ id: 'rule', kind: 'event-date', daysBefore: [3] }]
              : [{ id: 'rule', kind: 'price-level', level: 100, side: 'above' }],
          },
          auth,
        )
      ).result.ok,
    ).toBe(true);
  };
  return {
    service,
    app,
    request,
    login,
    seed,
    market,
    price: (next: number) => {
      price = next;
    },
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    now: () => now,
  };
};

const holdingPlanFixture = async (
  h: ReturnType<typeof setup>,
  auth: Awaited<ReturnType<ReturnType<typeof setup>['login']>>,
) => {
  const tenant = await h.service.repos.tenants.findById(auth.tenantId);
  if (tenant === null) throw new Error('fixture tenant missing');
  const lease = h.service.runtimes.acquire({
    tenantId: tenant.id,
    ownerUserId: tenant.ownerUserId,
    generation: tenant.generation,
    schemaVersion: tenant.schemaVersion,
  });
  cleanups.push(lease.release);
  const account = (await lease.runtime.repos.account.list())[0];
  if (account === undefined) throw new Error('fixture account missing');
  const ctx = buildContext({
    mode: 'hosted',
    identity: {
      mode: 'hosted',
      actor: 'worker',
      userId: tenant.ownerUserId,
      tenantId: tenant.id,
      tenantGeneration: tenant.generation,
      requestId: 'plan-fixture',
    },
    hostedAuthorization: async () => null,
    repos: lease.runtime.repos,
    user: { id: tenant.ownerUserId, defaultAccountId: account.id },
    adapters: {
      market: h.service.providers.market,
      llm: {
        name: 'no-ai',
        generate: async () => {
          throw new Error('unexpected AI');
        },
      },
    },
    clock: h.now,
  });
  expect(
    (
      await createPortfolioCashFlowTool.execute(
        { accountId: account.id, occurredAt: h.now(), kind: 'deposit', amount: 100_000 },
        ctx,
      )
    ).ok,
  ).toBe(true);
  expect(
    (await addHoldingTool.execute({ stockId: '600519.SH', quantity: 100, avgCost: 100 }, ctx)).ok,
  ).toBe(true);
  h.price(100);
  const quote = (await h.service.providers.market.batchQuote(['600519.SH'])).get('600519.SH');
  if (quote === undefined) throw new Error('fixture quote missing');
  await ctx.repos.quote.save(quote);
  const result = await getAccountFactsTool.execute({}, ctx);
  if (!result.ok || result.data.facts.status !== 'complete')
    throw new Error('fixture facts unavailable');
  const plan = TradingPlanSchema.parse({
    id: `account:${account.id}:stock:600519.SH`,
    version: 1,
    accountId: account.id,
    stockId: '600519.SH',
    stockName: 'fixture',
    status: 'active',
    action: 'hold',
    entryConditions: [],
    invalidEntryConditions: [],
    position: {
      currentPct: 10,
      targetPct: 10,
      deltaPct: 0,
      constraintStatus: 'passed',
      constraintReasons: [],
      prerequisiteActions: [],
    },
    holding: {
      minTradingDays: 1,
      maxTradingDays: 5,
      nextReviewAt: new Date('2026-10-16T08:00:00Z'),
      earlyExitConditions: [],
      extensionBasis: [],
    },
    exit: {
      stopLoss: 95,
      takeProfit: 120,
      conditions: ['跌破止损'],
      triggerConditions: [
        {
          id: 'stop',
          kind: 'price-threshold',
          phase: 'risk',
          metric: 'price',
          comparator: 'lte',
          value: 95,
          description: '跌破95',
        },
      ],
      canSellNow: true,
    },
    accountFactsDigest: result.data.facts.digest,
    accountFactsAsOf: h.now(),
    marketFacts: [],
    evidence: [],
    source: { strategyIds: [], strategyVersionIds: [], runIds: [], signalIds: [], adviceIds: [] },
    explanation: {
      supportingEvidenceIds: [],
      counterEvidence: ['波动可能恢复'],
      risks: ['缺口风险'],
      unknowns: [],
    },
    confidence: 60,
    invalidationConditions: ['账本变化'],
    validFrom: h.now(),
    validUntil: new Date('2026-10-20T07:00:00Z'),
    createdAt: h.now(),
  });
  await ctx.repos.tradingPlan.save(plan);
  return { ctx, plan };
};

test('worker monitors held trading plans without a browser, fences retries and links a tenant-owned trigger', async () => {
  const h = setup();
  const first = await h.login('held-plan@example.invalid');
  const other = await h.login('other-plan@example.invalid');
  const { ctx, plan } = await holdingPlanFixture(h, first);
  await h.request(
    '/api/notifications/feishu',
    { expectedRevision: 0, webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/held-plan' },
    first,
  );
  await runHostedWatchPass(h.service, 'before-risk');
  h.price(90);
  h.advance(60_000);
  const payloads: string[] = [];
  const http = spyOn(globalThis, 'fetch').mockImplementation((async (_input, init) => {
    payloads.push(String(init?.body));
    return new Response(JSON.stringify({ StatusCode: 0 }));
  }) as typeof fetch);
  cleanups.push(() => http.mockRestore());
  await Promise.all([
    runHostedWatchPass(h.service, 'held-A'),
    runHostedWatchPass(h.service, 'held-B'),
  ]);
  const triggers = await ctx.repos.watchTrigger.listRecent({});
  expect(triggers).toHaveLength(1);
  const trigger = triggers[0];
  if (trigger === undefined) throw new Error('plan trigger missing');
  expect(trigger).toMatchObject({ direction: 'sell', priority: 'urgent', deliveryStatus: 'sent' });
  expect(await ctx.repos.watchDelivery.list()).toMatchObject([
    { state: 'accepted', attempt: 1, deliveredAt: null },
  ]);
  expect(payloads).toHaveLength(1);
  expect(payloads[0]).toContain(
    `https://ds2.example.invalid/#alerts?triggerId=${encodeURIComponent(trigger.id)}`,
  );
  expect(payloads[0]).toContain('缺口风险');
  expect((await h.request('/api/watch/triggers', undefined, other)).result).toMatchObject({
    ok: true,
    data: { triggers: [] },
  });
  h.advance(60_000);
  await runHostedWatchPass(h.service, 'held-after-restart');
  expect(payloads).toHaveLength(1);
  expect(await ctx.repos.trade.listByAccount(plan.accountId)).toEqual([]);
  const runs = await ctx.repos.workflowRun.listRecent({ workflowName: 'hosted-alerts', limit: 10 });
  expect(
    runs.some(
      (run) =>
        (run.outputSummary?.tradingPlans as { checkedPlans?: number } | undefined)?.checkedPlans ===
        1,
    ),
  ).toBe(true);
  const current = await resolveHostedWatchNotificationTool.execute({ triggerId: trigger.id }, ctx);
  expect(current).toMatchObject({
    ok: true,
    data: {
      state: 'requires-recheck',
      currentActionAllowed: false,
      monitoring: { status: 'ready' },
    },
  });
  expect(
    (
      await createPortfolioCashFlowTool.execute(
        { accountId: plan.accountId, occurredAt: h.now(), kind: 'deposit', amount: 1 },
        ctx,
      )
    ).ok,
  ).toBe(true);
  expect(
    await resolveHostedWatchNotificationTool.execute({ triggerId: trigger.id }, ctx),
  ).toMatchObject({
    ok: true,
    data: {
      state: 'changed',
      currentActionAllowed: false,
      monitoring: { status: 'account-changed' },
      trigger: { evalSnapshot: { accountFactsDigest: plan.accountFactsDigest } },
    },
  });
  const subject = { kind: 'watch-trigger', id: trigger.id } as const;
  const preview = await getDecisionReviewContextTool.execute({ subject }, ctx);
  if (!preview.ok || preview.data.context === null)
    throw new Error('fixture review context unavailable');
  const ledger = await ctx.repos.decisionTrade.getLedgerState(plan.accountId);
  if (ledger === null) throw new Error('fixture ledger unavailable');
  const before = await ctx.repos.account.findById(plan.accountId);
  const input = {
    requestId: crypto.randomUUID(),
    expectedLedgerStateHash: ledger.hash,
    confirmedNotRecorded: true,
    stockId: plan.stockId,
    side: 'sell',
    quantity: 25,
    price: 90,
    fee: 0,
    executedAt: h.now().toISOString(),
    sources: [{ subject, contextHash: preview.data.context.contextHash, expectedRevision: 0 }],
  };
  const recorded = await recordDecisionTradeTool.execute(input, ctx);
  expect(recorded).toMatchObject({
    ok: true,
    data: {
      replayed: false,
      result: {
        trade: { quantity: 25 },
        reviews: [
          {
            review: { subject },
            revision: { content: { triggerFeedback: null, adviceFeedback: null } },
          },
        ],
      },
    },
  });
  expect(await recordDecisionTradeTool.execute(input, ctx)).toMatchObject({
    ok: true,
    data: { replayed: true },
  });
  expect(
    (await ctx.repos.holding.findByAccountAndStock(plan.accountId, plan.stockId))?.quantity,
  ).toBe(75);
  const after = await ctx.repos.account.findById(plan.accountId);
  expect(after?.cashBalance).toBe(money((before?.cashBalance ?? 0) + 2250));
  expect(await ctx.repos.trade.listByAccount(plan.accountId)).toHaveLength(1);
});

test.each(['account-changed', 'version-revoked', 'binding-revoked'] as const)(
  'held plan notification rechecks %s after claim and stops before external send',
  async (condition) => {
    const h = setup();
    const auth = await h.login(`race-${condition}@example.invalid`);
    const { ctx, plan } = await holdingPlanFixture(h, auth);
    await h.request(
      '/api/notifications/feishu',
      { expectedRevision: 0, webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/race' },
      auth,
    );
    await runHostedWatchPass(h.service, 'before-race');
    h.price(90);
    h.advance(60_000);
    const claim = ctx.repos.watchDelivery.claim.bind(ctx.repos.watchDelivery);
    const hook = spyOn(ctx.repos.watchDelivery, 'claim').mockImplementationOnce(async (input) => {
      const claimed = await claim(input);
      if (condition === 'account-changed') {
        const result = await createPortfolioCashFlowTool.execute(
          { accountId: plan.accountId, occurredAt: h.now(), kind: 'deposit', amount: 1 },
          ctx,
        );
        if (!result.ok) throw new Error('fixture race deposit failed');
      } else if (condition === 'version-revoked') {
        await ctx.repos.tradingPlan.save({
          ...plan,
          version: 2,
          status: 'revoked',
          createdAt: h.now(),
        });
      } else {
        const settings = await ctx.repos.watchDelivery.settings();
        await ctx.repos.watchDelivery.saveSettings({
          ...settings,
          expectedRevision: settings.revision,
          enabled: false,
          now: h.now(),
        });
      }
      return claimed;
    });
    cleanups.push(() => hook.mockRestore());
    const http = spyOn(globalThis, 'fetch').mockImplementation(
      (async () => new Response(JSON.stringify({ StatusCode: 0 }))) as unknown as typeof fetch,
    );
    cleanups.push(() => http.mockRestore());
    await runHostedWatchPass(h.service, 'raced-worker');
    expect(http).not.toHaveBeenCalled();
    expect(await ctx.repos.watchDelivery.list()).toMatchObject([
      {
        state: 'suppressed',
        errorKind: condition === 'binding-revoked' ? 'recipient-unavailable' : 'conditions-changed',
        deliveredAt: null,
      },
    ]);
    expect(await ctx.repos.watchTrigger.listRecent({})).toMatchObject([
      { deliveryStatus: 'invalidated' },
    ]);
  },
);

test('authenticated tenant settings stay private and worker concurrency/restart does not duplicate triggers or acceptance', async () => {
  const h = setup();
  const first = await h.login('ds2-first@example.invalid');
  const second = await h.login('ds2-second@example.invalid');
  await h.seed(first);
  await h.seed(second);
  const settings = {
    expectedRevision: 0,
    webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/fixture-first',
    enabled: true,
  };
  expect((await h.request('/api/notifications/feishu', settings, first)).result.ok).toBe(true);
  const read = await h.request('/api/notifications/feishu', undefined, first);
  expect(read.result).toMatchObject({ ok: true, data: { configured: true, revision: 1 } });
  expect(JSON.stringify(read.result)).not.toContain('fixture-first');
  expect((await h.request('/api/notifications/feishu', undefined, second)).result).toMatchObject({
    ok: true,
    data: { configured: false },
  });
  expect(
    (
      await h.request(
        '/api/notifications/feishu',
        { ...settings, expectedRevision: 1 },
        first,
        'POST',
        { origin: 'https://evil.invalid' },
      )
    ).response.status,
  ).toBe(403);
  expect(
    (
      await h.request(
        '/api/notifications/feishu',
        { ...settings, webhookUrl: 'https://evil.invalid' },
        second,
      )
    ).result.ok,
  ).toBe(false);
  const preview = await h.request('/api/watch/run-once', { notify: false }, first);
  expect(preview.result.ok).toBe(true);
  expect((await h.request('/api/watch/triggers', undefined, first)).result).toMatchObject({
    ok: true,
    data: { triggers: [] },
  });
  await runHostedWatchPass(h.service, 'worker-A');
  h.price(110);
  h.advance(60_000);
  const sent: string[] = [];
  const http = spyOn(globalThis, 'fetch').mockImplementation((async (
    input: Parameters<typeof fetch>[0],
  ) => {
    sent.push(String(input));
    return new Response(JSON.stringify({ StatusCode: 0 }));
  }) as typeof fetch);
  cleanups.push(() => http.mockRestore());
  await Promise.all([
    runHostedWatchPass(h.service, 'worker-A'),
    runHostedWatchPass(h.service, 'worker-B'),
  ]);
  expect(sent).toEqual([settings.webhookUrl]);
  expect(
    (await h.request('/api/notifications/watch-deliveries', undefined, first)).result,
  ).toMatchObject({
    ok: true,
    data: [{ tenantId: first.tenantId, state: 'accepted', attempt: 1, deliveredAt: null }],
  });
  expect(
    (await h.request('/api/notifications/watch-deliveries', undefined, second)).result,
  ).toMatchObject({
    ok: true,
    data: [{ tenantId: second.tenantId, state: 'suppressed', errorKind: 'fallback-log' }],
  });
  h.advance(60_000);
  await runHostedWatchPass(h.service, 'worker-after-restart');
  expect(sent).toHaveLength(1);
  const triggers = await h.request('/api/watch/triggers', undefined, first);
  expect(triggers.result.ok && (triggers.result.data.triggers as unknown[]).length).toBe(1);
});

test('subscription expiry stops a pending retry and disables external sends', async () => {
  const h = setup();
  const auth = await h.login('ds2-expiry@example.invalid');
  await h.seed(auth);
  await h.request(
    '/api/notifications/feishu',
    {
      expectedRevision: 0,
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/fixture-expiry',
    },
    auth,
  );
  await runHostedWatchPass(h.service, 'worker-A');
  h.price(110);
  h.advance(60_000);
  const http = spyOn(globalThis, 'fetch').mockImplementation(
    (async () => new Response('rejected', { status: 503 })) as unknown as typeof fetch,
  );
  cleanups.push(() => http.mockRestore());
  await runHostedWatchPass(h.service, 'worker-A');
  expect(http).toHaveBeenCalledTimes(1);
  expect(
    (await h.request('/api/notifications/watch-deliveries', undefined, auth)).result,
  ).toMatchObject({ ok: true, data: [{ state: 'failed' }] });
  h.advance(8 * 86_400_000);
  await runHostedWatchPass(h.service, 'worker-after-expiry');
  expect(http).toHaveBeenCalledTimes(1);
  const tenant = await h.service.repos.tenants.findById(auth.tenantId);
  if (!tenant) throw new Error('fixture tenant missing');
  const runtime = h.service.runtimes.acquire({
    tenantId: tenant.id,
    ownerUserId: tenant.ownerUserId,
    generation: tenant.generation,
    schemaVersion: tenant.schemaVersion,
  });
  try {
    expect((await runtime.runtime.repos.watchDelivery.list())[0]?.state).toBe('suppressed');
  } finally {
    runtime.release();
  }
});

test('the pre-market event loop stays tenant-scoped without requesting quote batches', async () => {
  const h = setup();
  h.advance(-70 * 60_000);
  const first = await h.login('ds2-event@example.invalid');
  const other = await h.login('ds2-no-event@example.invalid');
  await h.seed(first, true);
  await h.seed(other, true);
  const added = await h.request(
    '/api/tools/add_stock_event/call',
    {
      input: {
        stockId: '600519.SH',
        kind: 'earnings',
        title: 'fixture earnings',
        occursAt: '2026-10-18T00:00:00+08:00',
        importance: 'important',
      },
    },
    first,
  );
  expect(added.result.ok).toBe(true);
  const pass = await runHostedWatchPass(h.service, 'pre-market-worker');
  expect(pass).toEqual({ tenants: 2, ticks: 2, quoteBatches: 0 });
  expect(h.market).not.toHaveBeenCalled();
  expect(
    (await h.request('/api/notifications/watch-deliveries', undefined, first)).result,
  ).toMatchObject({
    ok: true,
    data: [{ tenantId: first.tenantId, state: 'suppressed', errorKind: 'fallback-log' }],
  });
  expect(
    (await h.request('/api/notifications/watch-deliveries', undefined, other)).result,
  ).toMatchObject({ ok: true, data: [] });
  h.advance(60_000);
  await runHostedWatchPass(h.service, 'event-worker-after-restart');
  const triggers = await h.request('/api/watch/triggers', undefined, first);
  expect(triggers.result.ok && (triggers.result.data.triggers as unknown[]).length).toBe(1);
});
