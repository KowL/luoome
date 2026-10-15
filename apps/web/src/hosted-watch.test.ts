import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixtureEmailOtpAdapter } from '@luoome/adapters/hosted';
import { QuoteSchema, type ToolResult } from '@luoome/core';
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
