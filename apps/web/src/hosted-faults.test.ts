import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixtureEmailOtpAdapter } from '@luoome/adapters/hosted';
import { QuoteSchema, type ToolContext, type ToolResult } from '@luoome/core';
import { buildContext } from '@luoome/tools';
import { claimHostedWatchTickTool, contextForHostedWebTools } from '@luoome/tools/hosted';
import { runHostedReportPass } from '../../worker/src/reports.js';
import { runHostedWatchPass } from '../../worker/src/watch.js';
import { openHostedService } from './hosted-composition.js';
import { loadHostedConfig } from './hosted-config.js';
import { createHostedWebApp } from './hosted-server.js';
import { runHostedWorkerOnce } from './hosted-worker.js';

const T0 = new Date('2026-10-15T02:00:00Z');
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const data = <T>(result: ToolResult<T>): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.data;
};
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'luoome-ds4-worker-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  let now = T0;
  let price = 90;
  const origin = 'https://ds4.example.invalid';
  const config = loadHostedConfig({
    HOSTED_ENVIRONMENT: 'development',
    HOSTED_DATA_ROOT: root,
    PUBLIC_ORIGIN: origin,
    HOSTED_AUTH_SECRET: 'ds4-fixture-auth-secret-32-characters',
    HOSTED_PRODUCT_POLICY: 'hosted-web-v2',
    HOSTED_PROVIDER_MODE: 'fixture',
    HOSTED_REGISTRATION_ENABLED: 'true',
    LUOOME_EXPOSE_WRITE: 'true',
    LUOOME_EXPOSE_EXTERNAL: 'true',
  });
  let service = openHostedService(config, undefined, () => now);
  cleanup.push(() => service.close());
  const installMarket = () => {
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
    cleanup.push(() => market.mockRestore());
  };
  installMarket();
  const app = () =>
    createHostedWebApp({
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
  ) => {
    const response = await app().fetch(
      new Request(`${origin}${path}`, {
        method: input === undefined ? 'GET' : 'POST',
        headers: {
          origin,
          'content-type': 'application/json',
          ...(auth === undefined ? {} : { cookie: auth.cookie, 'x-csrf-token': auth.csrf }),
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      }),
    );
    return data((await response.json()) as ToolResult<Record<string, unknown>>);
  };
  const login = async (suffix: string, stockId = '600519.SH') => {
    const challenge = await request('/api/auth/challenges', {
      email: `ds4-${suffix}@example.invalid`,
    });
    if (!(service.providers.emailOtp instanceof FixtureEmailOtpAdapter))
      throw new Error('fixture OTP missing');
    const code = service.providers.emailOtp.getMessage(challenge.challengeId as string)?.code;
    const session = await app().fetch(
      new Request(`${origin}/api/auth/sessions`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          code,
          password: 'ds4-fixture-password',
          acceptTerms: true,
        }),
      }),
    );
    expect(((await session.json()) as ToolResult<unknown>).ok).toBe(true);
    const cookie = session.headers.get('set-cookie')?.split(';')[0] as string;
    const me = await request('/api/me', undefined, { cookie, csrf: '' });
    await runHostedWorkerOnce(service, 'provisioner');
    const auth = {
      cookie,
      csrf: me.csrfToken as string,
      tenantId: (me.tenant as { id: string }).id,
    };
    await request(
      '/api/watchlists',
      { id: 'list', name: `list-${suffix}`, kind: 'personal', membershipPolicy: 'manual' },
      auth,
    );
    await request('/api/watchlists/list/members', { stockId }, auth);
    await request(
      '/api/alert-plans',
      {
        id: 'plan',
        name: `plan-${suffix}`,
        watchlistId: 'list',
        cooldownMinutes: 0,
        dailyNotificationLimit: 3,
        rules: [{ id: 'rule', kind: 'price-level', level: 100, side: 'above' }],
      },
      auth,
    );
    await request(
      '/api/notifications/feishu',
      { expectedRevision: 0, webhookUrl: `https://open.feishu.cn/open-apis/bot/v2/hook/${suffix}` },
      auth,
    );
    return auth;
  };
  const runtime = async (tenantId: string) => {
    const tenant = await service.repos.tenants.findById(tenantId);
    if (!tenant) throw new Error('fixture tenant missing');
    const lease = service.runtimes.acquire({
      tenantId,
      ownerUserId: tenant.ownerUserId,
      generation: tenant.generation,
      schemaVersion: tenant.schemaVersion,
    });
    const account = (await lease.runtime.repos.account.list())[0];
    if (!account) throw new Error('fixture account missing');
    const identity = {
      mode: 'hosted' as const,
      actor: 'worker' as const,
      tenantId,
      tenantGeneration: tenant.generation,
      userId: tenant.ownerUserId,
      requestId: 'fault-fixture',
    };
    const base = buildContext({
      mode: 'hosted',
      identity,
      repos: lease.runtime.repos,
      adapters: {
        market: service.providers.market,
        llm: {
          name: 'unused',
          generate: async () => {
            throw new Error('unexpected AI');
          },
        },
      },
      user: { id: tenant.ownerUserId, defaultAccountId: account.id },
      clock: () => now,
    });
    const ctx: ToolContext = contextForHostedWebTools({
      context: base,
      identity,
      entitlement: null,
      capabilities: { write: true, external: true },
      currentTenant: () => service.repos.tenants.findById(tenantId),
      currentEntitlement: () => service.repos.subscriptions.currentEntitlement({ tenantId, now }),
    });
    return { lease, ctx, repos: lease.runtime.repos };
  };
  return {
    login,
    runtime,
    request,
    service: () => service,
    watch: (id: string) => runHostedWatchPass(service, id),
    reports: (id: string) => runHostedReportPass(service, id),
    price: (value: number) => {
      price = value;
    },
    now: () => now,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    restart: () => {
      service.close();
      service = openHostedService(config, undefined, () => now);
      installMarket();
    },
  };
};

test('abandoned ticks and report leases recover after restart under concurrent tenant passes without duplicate facts or quota charges', async () => {
  const h = setup();
  const a = await h.login('tenant-a');
  const b = await h.login('tenant-b', '002594.SZ');
  const usage = async (tenantId: string) => {
    const entitlement = await h
      .service()
      .repos.subscriptions.currentEntitlement({ tenantId, now: h.now() });
    if (!entitlement) throw new Error('fixture entitlement missing');
    return {
      tenantId: entitlement.period.tenantId,
      captured: entitlement.capturedUnits,
      held: entitlement.heldUnits,
      available: entitlement.availableUnits,
    };
  };
  const baselineA = await usage(a.tenantId);
  const baselineB = await usage(b.tenantId);
  const sends: Array<{ url: string; body: string }> = [];
  const http = spyOn(globalThis, 'fetch').mockImplementation((async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url = String(input);
    sends.push({ url, body: String(init?.body) });
    return url.endsWith('/tenant-a')
      ? new Response('rejected', { status: 503 })
      : Response.json({ StatusCode: 0 });
  }) as typeof fetch);
  cleanup.push(() => http.mockRestore());
  await Promise.all([h.watch('worker-A'), h.watch('worker-B')]);
  h.price(110);
  h.advance(60_000);
  await Promise.all([h.watch('worker-A'), h.watch('worker-B')]);
  await Promise.all([h.reports('worker-A'), h.reports('worker-B')]);
  expect(sends).toHaveLength(4);
  const before = await h.runtime(a.tenantId);
  const aTrigger = (await before.repos.watchTrigger.listRecent({}))[0];
  const aReport = (await before.repos.report.list({}))[0];
  if (!aTrigger || !aReport) throw new Error('fixture facts missing');
  h.advance(60_000);
  const claimedTick = data(await claimHostedWatchTickTool.execute({}, before.ctx));
  expect(claimedTick).not.toBeNull();
  expect(
    await before.repos.watchTrigger.acquireExecution(
      'abandoned',
      h.now(),
      new Date(h.now().getTime() + 120_000),
    ),
  ).toBe(true);
  expect(await before.repos.watchTrigger.beginDelivery([aTrigger.id], h.now(), 'abandoned')).toBe(
    true,
  );
  expect(
    await before.repos.watchDelivery.claim({
      owner: 'abandoned',
      attemptId: 'interrupted-watch',
      triggerIds: [aTrigger.id],
      now: h.now(),
    }),
  ).toHaveLength(1);
  expect(await before.repos.reportAutomation.execution('acquire', 'abandoned', h.now())).toBe(true);
  expect(
    await before.repos.reportAutomation.claim(
      aReport.id,
      'abandoned',
      'interrupted-report',
      h.now(),
    ),
  ).not.toBeNull();
  expect(await before.repos.watchTrigger.countAttemptedSince(T0)).toBe(2);
  before.lease.release();
  // 仅释放 runtime 引用，业务租约、tick 与 sending 意图故意不释放。
  h.restart();
  h.advance(119_999);
  const blocked = await h.runtime(a.tenantId);
  expect(
    await blocked.repos.watchTrigger.acquireExecution(
      'too-early',
      h.now(),
      new Date(h.now().getTime() + 120_000),
    ),
  ).toBe(false);
  expect(await blocked.repos.reportAutomation.execution('acquire', 'too-early', h.now())).toBe(
    false,
  );
  blocked.lease.release();
  h.advance(1);
  await Promise.all([
    h.watch('successor-A'),
    h.watch('successor-B'),
    h.reports('successor-A'),
    h.reports('successor-B'),
  ]);
  h.advance(60_000);
  await Promise.all([h.watch('replay'), h.reports('replay')]);
  expect(sends).toHaveLength(4);
  const left = await h.runtime(a.tenantId);
  const right = await h.runtime(b.tenantId);
  try {
    expect(await left.repos.watchTrigger.listRecent({})).toMatchObject([
      {
        id: aTrigger.id,
        stockId: '600519.SH',
        deliveryAttempts: 2,
        deliveryStatus: 'unverifiable',
      },
    ]);
    expect(await right.repos.watchTrigger.listRecent({})).toMatchObject([
      { stockId: '002594.SZ', deliveryAttempts: 1, deliveryStatus: 'sent' },
    ]);
    expect(await left.repos.watchTrigger.countAttemptedSince(T0)).toBe(2);
    expect(await right.repos.watchTrigger.countAttemptedSince(T0)).toBe(1);
    expect(await right.repos.watchTrigger.findById(aTrigger.id)).toBeNull();
    expect(await right.repos.report.findById(aReport.id)).toBeNull();
    expect(await left.repos.report.list({})).toMatchObject([
      {
        id: aReport.id,
        sections: aReport.sections,
        evidence: aReport.evidence,
        generatedAt: aReport.generatedAt,
        dataAsOf: aReport.dataAsOf,
      },
    ]);
    expect(await right.repos.report.list({})).toHaveLength(1);
    expect(await left.repos.watchDelivery.list()).toMatchObject([
      { tenantId: a.tenantId, state: 'unknown', attempt: 2, deliveredAt: null },
    ]);
    expect(await left.repos.reportAutomation.list()).toMatchObject([
      { tenantId: a.tenantId, state: 'unknown', attempt: 2, deliveredAt: null },
    ]);
    expect(await right.repos.watchDelivery.list()).toMatchObject([
      { tenantId: b.tenantId, state: 'accepted', attempt: 1, deliveredAt: null },
    ]);
    expect(await right.repos.reportAutomation.list()).toMatchObject([
      { tenantId: b.tenantId, state: 'accepted', attempt: 1, deliveredAt: null },
    ]);
    expect(await left.repos.watchTrigger.beginDelivery([aTrigger.id], h.now(), 'abandoned')).toBe(
      false,
    );
    expect(
      await left.repos.reportAutomation.commit(
        { ...aReport, id: 'stale-writer' },
        'abandoned',
        h.now(),
      ),
    ).toBeNull();
  } finally {
    left.lease.release();
    right.lease.release();
  }
  expect(await usage(a.tenantId)).toEqual(baselineA);
  expect(await usage(b.tenantId)).toEqual(baselineB);
  for (const send of sends)
    if (send.body.includes('plan-tenant-a')) expect(send.url).toEndWith('/tenant-a');
    else if (send.body.includes('plan-tenant-b')) expect(send.url).toEndWith('/tenant-b');
});

test.each(['expired', 'paused', 'revoked', 'next-day'] as const)(
  '%s blocks both old watch and report retries without recharging the original attempts',
  async (condition) => {
    const h = setup();
    const auth = await h.login('blocked');
    const sends: string[] = [];
    const http = spyOn(globalThis, 'fetch').mockImplementation((async (
      _input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      sends.push(String(init?.body));
      return new Response('rejected', { status: 503 });
    }) as typeof fetch);
    cleanup.push(() => http.mockRestore());
    await h.watch('prime');
    h.price(110);
    h.advance(60_000);
    await h.watch('failed');
    await h.reports('failed');
    expect(sends).toHaveLength(2);
    const before = await h.runtime(auth.tenantId);
    const originalWatch = (await before.repos.watchDelivery.list())[0];
    const originalReport = (await before.repos.reportAutomation.list())[0];
    before.lease.release();
    if (condition === 'expired') h.advance(8 * 86_400_000);
    else if (condition === 'next-day') h.advance(86_400_000);
    else if (condition === 'paused') {
      const tenant = await h.service().repos.tenants.findById(auth.tenantId);
      if (!tenant) throw new Error('fixture tenant missing');
      await h
        .service()
        .repos.tenants.suspend({ id: tenant.id, generation: tenant.generation, now: h.now() });
    } else
      await h.request('/api/notifications/feishu', { expectedRevision: 1, enabled: false }, auth);
    h.advance(60_000);
    await Promise.all([h.watch('after-fault'), h.reports('after-fault')]);
    const after = await h.runtime(auth.tenantId);
    try {
      expect(
        (await after.repos.watchDelivery.list()).find((item) => item.id === originalWatch?.id),
      ).toMatchObject({ state: 'suppressed', attempt: 1 });
      expect(
        (await after.repos.reportAutomation.list()).find((item) => item.id === originalReport?.id),
      ).toMatchObject({ state: 'suppressed', attempt: 1 });
      expect(await after.repos.watchTrigger.countAttemptedSince(T0)).toBe(1);
    } finally {
      after.lease.release();
    }
    expect(sends.filter((body) => body.includes('2026-10-15 收盘复盘'))).toHaveLength(0);
    expect(sends.filter((body) => body.includes('2026-10-15 开盘简报'))).toHaveLength(1);
    expect(sends).toHaveLength(condition === 'next-day' ? 3 : 2);
  },
);
