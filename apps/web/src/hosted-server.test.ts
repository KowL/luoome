import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixtureEmailOtpAdapter, FixtureHostedPaymentAdapter } from '@luoome/adapters/hosted';
import { money, reportScopeKey, type ToolContext, type ToolResult } from '@luoome/core';
import { hashSessionToken } from '@luoome/tools/platform';
import { runHostedOperations } from '../../worker/src/operations.js';
import type { ChatStreamRuntime } from './chat.js';
import { createHostedBackup } from './hosted-backup.js';
import { openHostedService } from './hosted-composition.js';
import { loadHostedConfig } from './hosted-config.js';
import { readDeletionLedger } from './hosted-privacy.js';
import {
  prepareHostedRestore,
  reconcileHostedExternalResults,
  reconcileHostedRestoredData,
  resumeHostedRestoredService,
} from './hosted-recovery.js';
import { TenantRuntimeManager } from './hosted-runtime.js';
import { createHostedWebApp } from './hosted-server.js';
import { runHostedWorkerOnce } from './hosted-worker.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const origin = 'https://hosted.example.invalid';
const harness = (
  input: {
    exposeExternal?: boolean;
    productPolicy?: 'hosted-facts-v1' | 'hosted-web-v2';
    createTenantContext?: (base: ToolContext) => ToolContext;
    origin?: string;
    requestOrigin?: string;
    transportOrigin?: string;
    registrationEnabled?: boolean;
    adminEmails?: string;
  } = {},
) => {
  const root = mkdtempSync(join(tmpdir(), 'luoome-hosted-http-'));
  const publicOrigin = input.origin ?? origin;
  const inputOrigin = input.requestOrigin ?? publicOrigin;
  const transportOrigin = input.transportOrigin ?? inputOrigin;
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  let now = new Date('2026-10-12T06:00:00Z');
  const config = loadHostedConfig({
    LUOOME_MODE: 'hosted',
    HOSTED_ENVIRONMENT: 'development',
    HOSTED_DATA_ROOT: root,
    PUBLIC_ORIGIN: publicOrigin,
    HOSTED_ALLOW_INSECURE_HTTP: publicOrigin.startsWith('http:') ? 'true' : 'false',
    HOSTED_AUTH_SECRET: 'fixture-auth-secret-32-characters-minimum',
    HOSTED_PRODUCT_POLICY: input.productPolicy ?? 'hosted-facts-v1',
    HOSTED_PROVIDER_MODE: 'fixture',
    LUOOME_EXPOSE_WRITE: 'true',
    LUOOME_EXPOSE_EXTERNAL: input.exposeExternal === false ? 'false' : 'true',
    HOSTED_REGISTRATION_ENABLED: input.registrationEnabled === false ? 'false' : 'true',
    ...(input.adminEmails === undefined ? {} : { HOSTED_ADMIN_EMAILS: input.adminEmails }),
  });
  const service = openHostedService(config, undefined, () => now);
  cleanups.push(service.close);
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
    payment: service.providers.payment,
    ...(service.providers.createTenantContext === undefined
      ? {}
      : { createTenantContext: service.providers.createTenantContext }),
    ...(input.createTenantContext === undefined
      ? {}
      : { createTenantContext: input.createTenantContext }),
  });
  const request = async (
    path: string,
    method = 'GET',
    input?: unknown,
    cookie?: string,
    csrf?: string,
    headers?: Record<string, string>,
  ) => {
    const response = await app.fetch(
      new Request(`${transportOrigin}${path}`, {
        method,
        headers: {
          origin: inputOrigin,
          'content-type': 'application/json',
          ...(cookie === undefined ? {} : { cookie }),
          ...(csrf === undefined ? {} : { 'x-csrf-token': csrf }),
          ...headers,
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      }),
    );
    const result = (await response.json()) as ToolResult<Record<string, unknown>>;
    return { response, result };
  };
  const login = async (email: string) => {
    const challenge = await request('/api/auth/challenges', 'POST', { email });
    if (!challenge.result.ok) throw new Error('challenge failed');
    const emailAdapter = service.providers.emailOtp;
    if (!(emailAdapter instanceof FixtureEmailOtpAdapter)) throw new Error('fixture missing');
    const code = emailAdapter.getMessage(challenge.result.data.challengeId as string)?.code;
    const loggedIn = await request('/api/auth/sessions', 'POST', {
      challengeId: challenge.result.data.challengeId,
      code,
      password: 'fixture-login-password',
      acceptTerms: true,
    });
    expect(loggedIn.response.status).toBe(200);
    expect(loggedIn.result.ok && 'sessionToken' in loggedIn.result.data).toBe(false);
    const setCookie = loggedIn.response.headers.get('set-cookie');
    expect(setCookie).toContain('HttpOnly; SameSite=Lax; Path=/');
    if (publicOrigin.startsWith('https:')) expect(setCookie).toContain('Secure;');
    else expect(setCookie).not.toContain('Secure;');
    const cookie = setCookie?.split(';')[0] as string;
    const me = await request('/api/me', 'GET', undefined, cookie);
    if (!me.result.ok) throw new Error('me failed');
    return {
      cookie,
      csrf: me.result.data.csrfToken as string,
      tenant: me.result.data.tenant as { id: string; status: string },
    };
  };
  const relogin = async (email: string) => {
    const loggedIn = await request('/api/auth/password-sessions', 'POST', {
      email,
      password: 'fixture-login-password',
    });
    expect(loggedIn.response.status).toBe(200);
    const cookie = loggedIn.response.headers.get('set-cookie')?.split(';')[0] as string;
    const me = await request('/api/me', 'GET', undefined, cookie);
    if (!me.result.ok) throw new Error('me failed');
    return {
      cookie,
      csrf: me.result.data.csrfToken as string,
      tenant: me.result.data.tenant as { id: string; status: string },
    };
  };
  return {
    service,
    app,
    config,
    root,
    now: () => now,
    request,
    login,
    relogin,
    advance: (milliseconds: number) => {
      now = new Date(now.getTime() + milliseconds);
    },
  };
};

const importStocks = async (
  h: ReturnType<typeof harness>,
  auth: Awaited<ReturnType<ReturnType<typeof harness>['login']>>,
  name: string,
) => {
  const created = await h.request('/api/watchlists', 'POST', { name }, auth.cookie, auth.csrf);
  if (!created.result.ok) throw new Error(JSON.stringify(created.result));
  const watchlist = created.result.data.watchlist as { id: string };
  const preview = await h.request(
    `/api/watchlists/${watchlist.id}/import/preview`,
    'POST',
    { content: '600519.SH\n002594.SZ', format: 'text' },
    auth.cookie,
    auth.csrf,
  );
  if (!preview.result.ok) throw new Error(JSON.stringify(preview.result));
  const input = preview.result.data.preview as {
    id: string;
    inputHash: string;
    rows: Array<{ row: number; stockId: string }>;
  };
  const committed = await h.request(
    '/api/watchlists/import/commit',
    'POST',
    {
      previewId: input.id,
      inputHash: input.inputHash,
      requestId: crypto.randomUUID(),
      selections: input.rows.map(({ row, stockId }) => ({ row, stockId })),
      excludedRows: [],
      acknowledgeExtraColumns: false,
    },
    auth.cookie,
    auth.csrf,
  );
  expect(committed.response.status).toBe(200);
  return watchlist.id;
};

describe('hosted HTTP boundary', () => {
  test('public login configuration reveals only service switches and is not a mutation exemption', async () => {
    const h = harness({ registrationEnabled: false });
    const config = await h.request('/api/auth/config');
    expect(config.result).toEqual({
      ok: true,
      data: { emailConfigured: true, registrationEnabled: false, secureTransport: true },
    });
    expect(config.response.headers.get('cache-control')).toBe('no-store');
    expect((await h.request('/api/auth/config', 'POST', {})).response.status).toBe(401);
    expect((await h.request('/api/accounts')).response.status).toBe(401);
  });

  test('temporary HTTP registration provisions one default account, preserves CSRF and revokes its own cookie', async () => {
    const h = harness({
      origin: 'http://hosted.example.invalid:5173',
      productPolicy: 'hosted-web-v2',
    });
    const auth = await h.login('http@example.invalid');
    expect(auth.cookie).toStartWith('luoome_http_session=');
    expect((await h.request('/api/auth/config')).result).toEqual({
      ok: true,
      data: { emailConfigured: true, registrationEnabled: true, secureTransport: false },
    });
    expect(
      (
        await h.request(
          '/api/me',
          'GET',
          undefined,
          auth.cookie.replace('luoome_http_session', '__Host-luoome_session'),
        )
      ).response.status,
    ).toBe(401);
    expect(
      (
        await h.request(
          '/api/auth/challenges',
          'POST',
          { email: 'other@example.invalid' },
          undefined,
          undefined,
          { origin: 'http://other.example.invalid' },
        )
      ).response.status,
    ).toBe(403);
    await runHostedWorkerOnce(h.service);
    const accounts = await h.request('/api/accounts', 'GET', undefined, auth.cookie);
    expect(accounts.result.ok && (accounts.result.data.accounts as unknown[]).length).toBe(1);
    expect((await h.request('/api/auth/session', 'DELETE', {}, auth.cookie)).response.status).toBe(
      403,
    );
    const logout = await h.request('/api/auth/session', 'DELETE', {}, auth.cookie, auth.csrf);
    expect(logout.response.headers.get('set-cookie')).toBe(
      'luoome_http_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
    );
    expect((await h.request('/api/me', 'GET', undefined, auth.cookie)).response.status).toBe(401);
  });

  test('HTTPS sessions never accept a temporary HTTP cookie', async () => {
    const h = harness();
    const auth = await h.login('https@example.invalid');
    expect(auth.cookie).toStartWith('__Host-luoome_session=');
    expect(
      (
        await h.request(
          '/api/me',
          'GET',
          undefined,
          auth.cookie.replace('__Host-luoome_session', 'luoome_http_session'),
        )
      ).response.status,
    ).toBe(401);
  });

  test('switching an existing workspace to HTTPS rejects HTTP sessions even if the cookie is renamed', async () => {
    const h = harness({ origin: 'http://hosted.example.invalid:5173' });
    const auth = await h.login('http-transition@example.invalid');
    const httpsApp = createHostedWebApp({
      config: { ...h.config, publicOrigin: origin, allowInsecureHttp: false },
      repos: h.service.repos,
      runtimes: h.service.runtimes,
      maintenance: h.service.maintenance,
      market: h.service.providers.market,
      emailOtp: h.service.providers.emailOtp,
      jobPolicies: h.service.providers.jobPolicies,
      clock: h.now,
    });
    const response = await httpsApp.fetch(
      new Request(`${origin}/api/me`, {
        headers: { cookie: auth.cookie.replace('luoome_http_session', '__Host-luoome_session') },
      }),
    );
    expect(response.status).toBe(401);
  });
  test.each([
    ['http://hosted.example.invalid', 'http://hosted.example.invalid:5173', undefined],
    ['http://hosted.example.invalid', 'http://another.example.invalid:8080', undefined],
    [origin, 'https://another.example.invalid:5443', undefined],
    [origin, 'https://alias.example.invalid', 'http://alias.example.invalid'],
  ])(
    'login and authenticated mutations use the actual address: %s → %s',
    async (configured, actual, transport) => {
      const h = harness({
        origin: configured,
        requestOrigin: actual,
        productPolicy: 'hosted-web-v2',
        ...(transport === undefined ? {} : { transportOrigin: transport }),
      });
      const auth = await h.login('address@example.invalid');
      await runHostedWorkerOnce(h.service);
      expect(
        (
          await h.request(
            '/api/watchlists',
            'POST',
            { name: 'alias', kind: 'personal', membershipPolicy: 'manual' },
            auth.cookie,
            auth.csrf,
          )
        ).response.status,
      ).toBe(200);
      expect(
        (await h.request('/api/auth/session', 'DELETE', {}, auth.cookie)).response.status,
      ).toBe(403);
      expect(
        (await h.request('/api/auth/session', 'DELETE', {}, auth.cookie, auth.csrf)).response
          .status,
      ).toBe(200);
      expect((await h.relogin('address@example.invalid')).cookie).toBeTruthy();
    },
  );

  test('proxy HTTP transport retains configured HTTPS policy and checks the requested host', async () => {
    const h = harness();
    const response = await h.app.fetch(
      new Request('http://alias.example.invalid/api/auth/password-sessions', {
        method: 'POST',
        headers: { origin: 'https://alias.example.invalid', 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
  });

  test.each([
    undefined,
    'null',
    'https://evil.invalid',
    `${origin}/`,
    'http://hosted.example.invalid',
  ])('rejects absent, malformed or cross-site Origin: %s', async (requestOrigin) => {
    const h = harness();
    const response = await h.app.fetch(
      new Request(`${origin}/api/auth/password-sessions`, {
        method: 'POST',
        headers: {
          ...(requestOrigin === undefined ? {} : { origin: requestOrigin }),
          'x-forwarded-host': 'evil.invalid',
          'x-forwarded-proto': 'http',
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    );
    expect(response.status).toBe(403);
  });

  test('same Origin, CSRF, no-store, anonymous auth and deny-by-default surfaces', async () => {
    const h = harness();
    expect((await h.request('/api/me')).response.status).toBe(401);
    const wrongOrigin = await h.request(
      '/api/auth/challenges',
      'POST',
      { email: 'first@example.invalid' },
      undefined,
      undefined,
      { origin: 'https://evil.invalid' },
    );
    expect(wrongOrigin.response.status).toBe(403);
    const auth = await h.login('first@example.invalid');
    expect(
      (await h.request('/api/watchlists', 'POST', { name: 'mine' }, auth.cookie)).response.status,
    ).toBe(403);
    await runHostedWorkerOnce(h.service);
    for (const path of [
      '/api/settings/ai',
      '/api/tools/get_advice/call',
      '/api/chat',
      '/api/holdings',
      '/api/agent',
    ]) {
      const result = await h.request(path, 'GET', undefined, auth.cookie);
      expect(result.response.status).toBe(403);
      expect(result.response.headers.get('cache-control')).toBe('no-store');
    }
    expect(
      (
        await h.request('/api/watchlists', 'GET', undefined, auth.cookie, undefined, {
          'x-luoome-account-id': 'other-account',
        })
      ).response.status,
    ).toBe(404);
    const logout = await h.request('/api/auth/session', 'DELETE', {}, auth.cookie, auth.csrf);
    expect(logout.response.status).toBe(200);
    expect((await h.request('/api/me', 'GET', undefined, auth.cookie)).response.status).toBe(401);
  });
  test('provisioning is asynchronous, idempotent and never creates a fake account', async () => {
    const h = harness();
    const auth = await h.login('first@example.invalid');
    expect(auth.tenant.status).toBe('provisioning');
    expect(
      (await h.request('/api/watchlists', 'GET', undefined, auth.cookie)).response.status,
    ).toBe(503);
    expect((await runHostedWorkerOnce(h.service)).kind).toBe('provision-tenant');
    const tenant = await h.service.repos.tenants.findById(auth.tenant.id);
    if (tenant === null) throw new Error('tenant missing');
    const lease = h.service.runtimes.acquire({
      tenantId: tenant.id,
      ownerUserId: tenant.ownerUserId,
      generation: tenant.generation,
      schemaVersion: tenant.schemaVersion,
    });
    expect(await lease.runtime.repos.account.list()).toEqual([]);
    lease.release();
    expect((await runHostedWorkerOnce(h.service)).processed).toBe(false);
    expect((await h.service.repos.subscriptions.listPeriods(tenant.id)).length).toBe(1);
  });
  test('server identity owns data and rejects client quota/identity injection', async () => {
    const h = harness();
    const a = await h.login('a@example.invalid');
    const b = await h.login('b@example.invalid');
    await runHostedWorkerOnce(h.service);
    await runHostedWorkerOnce(h.service);
    const id = await importStocks(h, a, 'A private');
    expect(
      (await h.request(`/api/watchlists/${id}`, 'GET', undefined, b.cookie)).response.status,
    ).toBe(404);
    expect(
      (
        await h.request(
          '/api/watchlists',
          'POST',
          { name: 'forged', tenantId: a.tenant.id },
          b.cookie,
          b.csrf,
        )
      ).response.status,
    ).toBe(400);
    expect(
      (
        await h.request(
          '/api/watchlists/import/commit',
          'POST',
          { maxDistinctStocks: 1000 },
          a.cookie,
          a.csrf,
        )
      ).response.status,
    ).toBe(400);
    expect(
      (
        await h.request(
          '/api/jobs',
          'POST',
          {
            operation: 'report.watchlist-facts',
            version: 1,
            requestId: 'bad',
            input: { watchlistId: id, userId: b.tenant.id },
          },
          a.cookie,
          a.csrf,
        )
      ).response.status,
    ).toBe(400);
  });
  test('facts use durable private input, original receipt and a single reservation', async () => {
    const h = harness();
    const auth = await h.login('first@example.invalid');
    await runHostedWorkerOnce(h.service);
    const watchlistId = await importStocks(h, auth, 'my facts');
    const body = {
      operation: 'report.watchlist-facts',
      version: 1,
      requestId: 'same-request',
      input: { watchlistId },
    };
    const submitted = await h.request('/api/jobs', 'POST', body, auth.cookie, auth.csrf);
    expect(submitted.response.status).toBe(202);
    expect((await h.request('/api/jobs', 'POST', body, auth.cookie, auth.csrf)).result.ok).toBe(
      true,
    );
    const worker = await runHostedWorkerOnce(h.service);
    expect(worker.kind).toBe('watchlist-facts');
    const reports = await h.request(
      `/api/reports?watchlistId=${watchlistId}`,
      'GET',
      undefined,
      auth.cookie,
    );
    expect(reports.result.ok).toBe(true);
    if (!reports.result.ok) return;
    const saved = reports.result.data.reports as Array<{
      kind: string;
      scope: { kind: string };
      sections: unknown[];
    }>;
    expect(saved.length).toBe(1);
    expect(saved[0]?.kind).toBe('watchlist-facts');
    expect(saved[0]?.scope.kind).toBe('watchlist');
    const jobs = await h.service.repos.jobs.list({ tenantId: auth.tenant.id });
    const factJob = jobs.find((job) => job.kind === 'watchlist-facts');
    expect(factJob?.state).toBe('partial');
    expect(
      factJob && (await h.service.repos.jobs.findReservation(factJob.operationId))?.state,
    ).toBe('captured');
    expect(
      factJob &&
        (await h.service.repos.jobs.listProviderAttempts(factJob.operationId))[0]
          ?.confirmedCostMicro,
    ).toBe(0);
    const replay = await h.request('/api/jobs', 'POST', body, auth.cookie, auth.csrf);
    expect(replay.result.ok && replay.result.data.replayed).toBe(true);
    expect((await h.service.repos.deliveries.list(auth.tenant.id)).length).toBe(0);
  });
  test.each(['afterBusinessCommit', 'afterPlatformCommit'] as const)(
    '%s interruption recovers without a second report or settlement',
    async (boundary) => {
      const h = harness();
      const auth = await h.login('first@example.invalid');
      await runHostedWorkerOnce(h.service);
      const watchlistId = await importStocks(h, auth, 'recovery');
      await h.request(
        '/api/jobs',
        'POST',
        {
          operation: 'report.watchlist-facts',
          version: 1,
          requestId: 'recovery',
          input: { watchlistId },
        },
        auth.cookie,
        auth.csrf,
      );
      await runHostedWorkerOnce(h.service, 'crashing-worker', {
        [boundary]: async () => {
          throw new Error('injected crash');
        },
      });
      h.advance(6_000);
      await runHostedWorkerOnce(h.service, 'recovered-worker');
      const jobs = await h.service.repos.jobs.list({ tenantId: auth.tenant.id });
      const job = jobs.find((candidate) => candidate.kind === 'watchlist-facts');
      expect(job?.state).toBe('partial');
      expect(job?.attempt).toBe(boundary === 'afterBusinessCommit' ? 2 : 1);
      const reports = await h.request(
        `/api/reports?watchlistId=${watchlistId}`,
        'GET',
        undefined,
        auth.cookie,
      );
      expect(reports.result.ok && (reports.result.data.reports as unknown[]).length).toBe(1);
    },
  );
  test('a terminated worker keeps the barrier closed until stopped-writer recovery settles its durable receipt', async () => {
    const h = harness();
    const auth = await h.login('process-crash@example.invalid');
    await runHostedWorkerOnce(h.service);
    const watchlistId = await importStocks(h, auth, 'process recovery');
    await h.request(
      '/api/jobs',
      'POST',
      {
        operation: 'report.watchlist-facts',
        version: 1,
        requestId: 'process-crash',
        input: { watchlistId },
      },
      auth.cookie,
      auth.csrf,
    );
    const fixtureEnv = {
      LUOOME_MODE: 'hosted',
      HOSTED_ENVIRONMENT: 'development',
      HOSTED_DATA_ROOT: h.root,
      PUBLIC_ORIGIN: origin,
      HOSTED_AUTH_SECRET: h.config.authSecret,
      HOSTED_PRODUCT_POLICY: 'hosted-facts-v1',
      HOSTED_PROVIDER_MODE: 'fixture',
      LUOOME_EXPOSE_WRITE: 'true',
      LUOOME_EXPOSE_EXTERNAL: 'true',
      HOSTED_REGISTRATION_ENABLED: 'true',
    };
    const source = `import {loadHostedConfig} from './apps/web/src/hosted-config.ts';
      import {openHostedService} from './apps/web/src/hosted-composition.ts';
      import {runHostedWorkerOnce} from './apps/web/src/hosted-worker.ts';
      const service=openHostedService(loadHostedConfig(process.env),undefined,()=>new Date('2026-10-12T06:00:00Z'));
      await runHostedWorkerOnce(service,'terminated-worker',{afterBusinessCommit:async()=>process.exit(17)}); process.exit(18);`;
    const child = Bun.spawn([process.execPath, '--no-env-file', '--eval', source], {
      cwd: new URL('../../../', import.meta.url).pathname,
      env: fixtureEnv,
      stdout: 'ignore',
      stderr: 'pipe',
    });
    expect(await child.exited).toBe(17);
    expect(h.service.maintenance.state().activities).toBeGreaterThan(0);
    await expect(
      createHostedBackup({
        dataRoot: h.root,
        destination: join(h.root, '..', `blocked-${crypto.randomUUID()}`),
        gate: h.service.maintenance,
        timeoutMs: 0,
      }),
    ).rejects.toThrow('writers_not_drained');
    h.service.close();
    const recovered = (await runHostedOperations(
      [
        'recover-stopped-writers',
        '--writers-stopped',
        '--deletion-ledger',
        h.config.deletionLedgerRoot,
      ],
      fixtureEnv,
    )) as { unresolvedResults: number; pendingReview: Record<string, number> };
    expect(recovered.unresolvedResults).toBe(0);
    expect(Object.values(recovered.pendingReview).every((count) => count === 0)).toBe(true);
    await runHostedOperations(['resume', '--writers-stopped'], fixtureEnv);
    const restored = openHostedService(h.config, undefined, h.now);
    cleanups.push(restored.close);
    const cookieToken = auth.cookie.split('=')[1];
    if (cookieToken === undefined) throw new Error('fixture token missing');
    expect(
      await restored.repos.auth.resolveSession({
        tokenHash: hashSessionToken(cookieToken),
        now: h.now(),
        touch: false,
      }),
    ).toBeNull();
    expect(
      (await restored.repos.jobs.list({ tenantId: auth.tenant.id })).find(
        (job) => job.kind === 'watchlist-facts',
      )?.state,
    ).toBe('partial');
    const tenant = await restored.repos.tenants.findById(auth.tenant.id);
    if (tenant === null) throw new Error('tenant missing');
    const lease = restored.runtimes.acquire({
      tenantId: tenant.id,
      ownerUserId: tenant.ownerUserId,
      generation: tenant.generation,
      schemaVersion: tenant.schemaVersion,
    });
    expect(
      await lease.runtime.repos.report.list({
        kind: 'watchlist-facts',
        scopeKey: reportScopeKey({ kind: 'watchlist', watchlistId }),
      }),
    ).toHaveLength(1);
    expect(await lease.runtime.repos.hostedTenant?.listOutbox()).toHaveLength(0);
    lease.release();
  });
  test('maintenance also blocks session touch and new worker claims', async () => {
    const h = harness();
    const auth = await h.login('first@example.invalid');
    h.service.maintenance.begin('backup');
    h.service.maintenance.freeze('backup');
    expect((await h.request('/api/me', 'GET', undefined, auth.cookie)).response.status).toBe(503);
    expect((await runHostedWorkerOnce(h.service)).processed).toBe(false);
    expect(h.service.maintenance.state().activities).toBe(0);
    h.service.maintenance.finish('backup');
    expect((await h.request('/api/me', 'GET', undefined, auth.cookie)).response.status).toBe(200);
  });
  test.each(['in-app', 'email', 'paused', 'restored'] as const)(
    'formal alerts with %s delivery preserve current rules and accountless feedback',
    async (deliveryMode) => {
      const h = harness();
      const auth = await h.login('alerts@example.invalid');
      await runHostedWorkerOnce(h.service);
      const watchlistId = await importStocks(h, auth, 'price conditions');
      if (deliveryMode !== 'in-app')
        expect(
          (
            await h.request(
              '/api/notifications/preferences',
              'PUT',
              {
                expectedRevision: 0,
                emailEnabled: true,
                detail: 'minimal',
                quietHours: {
                  enabled: true,
                  startMinutes: 1320,
                  endMinutes: 480,
                  timeZone: 'Asia/Shanghai',
                },
              },
              auth.cookie,
              auth.csrf,
            )
          ).response.status,
        ).toBe(200);
      const plan = {
        id: crypto.randomUUID(),
        name: 'my threshold',
        watchlistId,
        rules: [{ kind: 'price-level', id: crypto.randomUUID(), side: 'above', level: 1500 }],
        logic: 'ANY',
        triggerMode: 'on-enter',
        cooldownMinutes: 15,
        dailyNotificationLimit: 5,
        notifyOnRecovery: false,
        enabled: true,
      };
      const preview = await h.request(
        '/api/alerts/preview',
        'POST',
        { plan },
        auth.cookie,
        auth.csrf,
      );
      expect(preview.response.status).toBe(200);
      expect(
        (await h.request('/api/triggers', 'GET', undefined, auth.cookie)).result,
      ).toMatchObject({
        ok: true,
        data: { triggers: [] },
      });
      expect(
        (
          await h.request(
            '/api/alerts',
            'POST',
            { plan, expectedPlanRevision: null, requestId: 'enable', enableConfirmed: false },
            auth.cookie,
            auth.csrf,
          )
        ).response.status,
      ).toBe(409);
      expect(
        (
          await h.request(
            '/api/alerts',
            'POST',
            { plan, expectedPlanRevision: null, requestId: 'enable', enableConfirmed: true },
            auth.cookie,
            auth.csrf,
          )
        ).response.status,
      ).toBe(200);
      expect((await runHostedWorkerOnce(h.service)).kind).toBe('watch-alerts');
      expect(
        (await h.request('/api/triggers', 'GET', undefined, auth.cookie)).result,
      ).toMatchObject({
        ok: true,
        data: { triggers: [] },
      });
      const original = h.service.providers.market.batchQuote.bind(h.service.providers.market);
      h.service.providers.market.batchQuote = async (codes) => {
        const quotes = await original(codes);
        for (const [code, quote] of quotes)
          if (quote.stockId === '600519.SH') quotes.set(code, { ...quote, close: money(1600) });
        return quotes;
      };
      h.advance(15 * 60_000);
      expect((await runHostedWorkerOnce(h.service)).kind).toBe('watch-alerts');
      const triggerData = await h.request('/api/triggers', 'GET', undefined, auth.cookie);
      if (!triggerData.result.ok) throw new Error('trigger read failed');
      const triggers = triggerData.result.data.triggers as Array<{ id: string; ruleKind: string }>;
      expect(triggers).toHaveLength(1);
      expect(triggers[0]?.ruleKind).toBe('price-level');
      expect(JSON.stringify(triggers)).not.toContain('strategy-score');
      expect(await h.service.repos.deliveries.list(auth.tenant.id)).toHaveLength(
        deliveryMode === 'in-app' ? 1 : 2,
      );
      if (deliveryMode === 'restored') {
        const intent = (await h.service.repos.deliveries.list(auth.tenant.id)).find(
          (delivery) => delivery.channel === 'email',
        );
        if (intent === undefined) throw new Error('email intent missing');
        expect(
          await h.service.repos.deliveries.claim({
            id: intent.id,
            generation: intent.generation,
            bindingVersion: intent.bindingVersion,
            attemptId: 'interrupted-send',
            now: h.now(),
          }),
        ).not.toBeNull();
        await expect(
          reconcileHostedExternalResults({
            dataRoot: h.root,
            config: h.config,
            writersStopped: false,
            providers: h.service.providers,
          }),
        ).rejects.toThrow('reconciliation_requires_stopped_writers');
        await expect(
          reconcileHostedExternalResults({
            dataRoot: h.root,
            config: h.config,
            writersStopped: true,
            providers: h.service.providers,
          }),
        ).rejects.toThrow('not_a_prepared_restore');
        h.service.maintenance.begin('restore:external-reconciliation');
        h.service.maintenance.freeze('restore:external-reconciliation');
        h.service.close();
        const prepared = await reconcileHostedRestoredData({
          dataRoot: h.root,
          deletionLedger: h.config.deletionLedgerRoot,
          config: h.config,
          writersStopped: true,
          clock: h.now,
        });
        expect(prepared.pendingReview.unknownDeliveries).toBe(1);
        let sends = 0;
        h.service.providers.notification.send = async () => {
          sends++;
          throw new Error('restore must never send');
        };
        const reconciled = await reconcileHostedExternalResults({
          dataRoot: h.root,
          config: h.config,
          writersStopped: true,
          providers: h.service.providers,
          clock: h.now,
        });
        expect(reconciled).toMatchObject({
          mode: 'frozen',
          queriedDeliveries: 1,
          failedQueries: 0,
          pendingReview: { unknownDeliveries: 0 },
        });
        expect(sends).toBe(0);
        await resumeHostedRestoredService({ dataRoot: h.root, writersStopped: true });
        const restored = openHostedService(h.config, undefined, h.now);
        cleanups.push(restored.close);
        expect(
          (await restored.repos.deliveries.list(auth.tenant.id)).every(
            (delivery) => delivery.state === 'suppressed',
          ),
        ).toBe(true);
        return;
      }
      if (deliveryMode === 'paused') {
        const plans = await h.request(
          `/api/watchlists/${watchlistId}/alerts`,
          'GET',
          undefined,
          auth.cookie,
        );
        if (!plans.result.ok) throw new Error('plan read failed');
        const revision = (plans.result.data.plans as Array<{ planRevision: string }>)[0]
          ?.planRevision;
        expect(
          (
            await h.request(
              '/api/alerts/pause',
              'POST',
              {
                alertPlanId: plan.id,
                expectedPlanRevision: revision,
                requestId: 'pause-before-dispatch',
              },
              auth.cookie,
              auth.csrf,
            )
          ).response.status,
        ).toBe(200);
      }
      await runHostedWorkerOnce(h.service);
      const deliveries = await h.service.repos.deliveries.list(auth.tenant.id);
      expect(
        deliveries.every(
          (delivery) => delivery.state === (deliveryMode === 'paused' ? 'suppressed' : 'accepted'),
        ),
      ).toBe(true);
      expect(deliveries.every((delivery) => delivery.deliveredAt === null)).toBe(true);
      expect(deliveries.find((delivery) => delivery.channel === 'email')?.attempt).toBe(
        deliveryMode === 'email' ? 1 : deliveryMode === 'paused' ? 0 : undefined,
      );
      const feedback = await h.request(
        `/api/triggers/${triggers[0]?.id}/feedback`,
        'POST',
        {
          expectedRevision: 0,
          rating: 'useful',
          note: 'personal observation',
          requestId: 'feedback-once',
        },
        auth.cookie,
        auth.csrf,
      );
      expect(feedback.response.status).toBe(200);
      const tenant = await h.service.repos.tenants.findById(auth.tenant.id);
      if (tenant === null) throw new Error('tenant missing');
      const lease = h.service.runtimes.acquire({
        tenantId: tenant.id,
        ownerUserId: tenant.ownerUserId,
        generation: tenant.generation,
        schemaVersion: tenant.schemaVersion,
      });
      expect(await lease.runtime.repos.account.list()).toEqual([]);
      lease.release();
    },
  );
  test('existing workspaces migrate under the write barrier and preserve business rows', async () => {
    const h = harness();
    const auth = await h.login('migration@example.invalid');
    await runHostedWorkerOnce(h.service);
    const list = await importStocks(h, auth, 'retained list');
    expect(h.service.runtimes.drain(auth.tenant.id)).toBe(true);
    const db = new Database(join(h.root, 'tenants', auth.tenant.id, 'luoome.db'));
    db.exec('DROP TABLE tenant_export_snapshots');
    db.close();
    const tenant = await h.service.repos.tenants.findById(auth.tenant.id);
    if (tenant === null) throw new Error('tenant missing');
    const upgrade = new TenantRuntimeManager(h.root, 16, Date.now, {
      maintenance: h.service.maintenance,
      isCurrent: async () => true,
    });
    try {
      const lease = upgrade.acquire({
        tenantId: tenant.id,
        ownerUserId: tenant.ownerUserId,
        generation: tenant.generation,
        schemaVersion: tenant.schemaVersion,
      });
      lease.release();
    } finally {
      upgrade.stop();
    }
    expect(
      (await h.request(`/api/watchlists/${list}`, 'GET', undefined, auth.cookie)).response.status,
    ).toBe(200);
    const exportResult = await h.request(
      '/api/data/exports',
      'POST',
      { requestId: 'after-migration' },
      auth.cookie,
      auth.csrf,
    );
    if (!exportResult.result.ok) throw new Error('export request failed');
    await runHostedWorkerOnce(h.service);
    const metadata = exportResult.result.data.export as { id: string };
    expect(
      (await h.request(`/api/data/exports/${metadata.id}`, 'GET', undefined, auth.cookie)).result,
    ).toMatchObject({ ok: true, data: { export: { state: 'ready' } } });
    expect(h.service.maintenance.state().activities).toBe(0);
  });
  test('exports are private, asynchronous, verified and expire without refreshing providers', async () => {
    const h = harness();
    const a = await h.login('export-a@example.invalid');
    const b = await h.login('export-b@example.invalid');
    await runHostedWorkerOnce(h.service);
    await runHostedWorkerOnce(h.service);
    await importStocks(h, a, 'private export list');
    const submitted = await h.request(
      '/api/data/exports',
      'POST',
      { requestId: 'export-once' },
      a.cookie,
      a.csrf,
    );
    expect(submitted.response.status).toBe(202);
    if (!submitted.result.ok) throw new Error('export submit failed');
    const metadata = submitted.result.data.export as { id: string; state: string };
    expect(metadata.state).toBe('requested');
    expect(metadata).not.toHaveProperty('artifactRef');
    expect(metadata).not.toHaveProperty('inputHash');
    expect(
      (await h.request(`/api/data/exports/${metadata.id}`, 'GET', undefined, b.cookie)).response
        .status,
    ).toBe(404);
    await runHostedWorkerOnce(h.service);
    const download = await h.app.fetch(
      new Request(`${origin}/api/data/exports/${metadata.id}/download`, {
        headers: { cookie: a.cookie },
      }),
    );
    expect(download.status).toBe(200);
    expect(download.headers.get('cache-control')).toBe('no-store');
    expect(download.headers.get('content-disposition')).toContain('attachment');
    const snapshot = (await download.json()) as { format: string; watchlists: { name: string }[] };
    expect(snapshot.format).toBe('luoome-personal-data');
    expect(snapshot.watchlists[0]?.name).toBe('private export list');
    expect(snapshot).not.toHaveProperty('sessions');
    expect(snapshot).not.toHaveProperty('quotes');
    const artifact = join(h.root, 'tenants', a.tenant.id, 'exports', `${metadata.id}.json`);
    writeFileSync(artifact, '{}');
    expect(
      (
        await h.app.fetch(
          new Request(`${origin}/api/data/exports/${metadata.id}/download`, {
            headers: { cookie: a.cookie },
          }),
        )
      ).status,
    ).toBe(503);
    h.advance(24 * 60 * 60_000);
    await runHostedWorkerOnce(h.service);
    expect(existsSync(artifact)).toBe(false);
    expect(
      (
        await h.app.fetch(
          new Request(`${origin}/api/data/exports/${metadata.id}/download`, {
            headers: { cookie: a.cookie },
          }),
        )
      ).status,
    ).toBe(404);
  });
  test('deletion waits for another process runtime, then erases control PII and prevents old-backup resurrection', async () => {
    const h = harness();
    const auth = await h.login('delete@example.invalid');
    await runHostedWorkerOnce(h.service);
    await importStocks(h, auth, 'deleted private list');
    const survivor = await h.login('survivor@example.invalid');
    await runHostedWorkerOnce(h.service);
    await importStocks(h, survivor, 'surviving private list');
    const backup = `${h.root}-backup`;
    const restored = `${h.root}-restored`;
    cleanups.push(
      () => rmSync(backup, { recursive: true, force: true }),
      () => rmSync(restored, { recursive: true, force: true }),
    );
    await createHostedBackup({
      dataRoot: h.root,
      destination: backup,
      gate: h.service.maintenance,
      clock: h.now,
    });
    const second = openHostedService(h.config, undefined, h.now);
    cleanups.push(second.close);
    const tenant = await h.service.repos.tenants.findById(auth.tenant.id);
    if (tenant === null) throw new Error('tenant missing');
    const held = second.runtimes.acquire({
      tenantId: tenant.id,
      ownerUserId: tenant.ownerUserId,
      generation: tenant.generation,
      schemaVersion: tenant.schemaVersion,
    });
    const deletion = await h.request(
      '/api/me/deletion',
      'POST',
      { requestId: 'delete-once', confirmation: '删除我的数据' },
      auth.cookie,
      auth.csrf,
    );
    expect(deletion.response.status).toBe(202);
    expect(deletion.response.headers.get('set-cookie')).toContain('Max-Age=0');
    await runHostedWorkerOnce(h.service);
    expect((await h.service.repos.tenants.findById(auth.tenant.id))?.status).toBe('deleting');
    expect(existsSync(join(h.root, 'tenants', auth.tenant.id))).toBe(true);
    held.release();
    await second.runtimes.pruneUnavailable();
    await runHostedWorkerOnce(h.service);
    expect((await h.service.repos.tenants.findById(auth.tenant.id))?.status).toBe('deleted');
    expect((await h.service.repos.auth.findUserById(tenant.ownerUserId))?.email).toBeNull();
    expect(existsSync(join(h.root, 'tenants', auth.tenant.id))).toBe(false);
    expect(readDeletionLedger(h.config.deletionLedgerRoot)).toHaveLength(1);
    expect((await h.request('/api/me', 'GET', undefined, auth.cookie)).response.status).toBe(401);
    await runHostedWorkerOnce(h.service);
    expect(existsSync(join(h.root, 'tenants', auth.tenant.id))).toBe(false);
    const recovered = await prepareHostedRestore({
      source: backup,
      destination: restored,
      deletionLedger: h.config.deletionLedgerRoot,
      config: h.config,
      writersStopped: true,
      clock: h.now,
    });
    expect(recovered.appliedTombstones).toBe(1);
    expect(existsSync(join(restored, 'tenants', auth.tenant.id))).toBe(false);
    expect(recovered.pendingReview).toEqual({
      pendingJobs: 0,
      unknownCosts: 0,
      pendingPayments: 0,
      unknownDeliveries: 0,
      pendingDeletions: 0,
    });
    await resumeHostedRestoredService({ dataRoot: restored, writersStopped: true });
    const service = openHostedService({ ...h.config, dataRoot: restored }, undefined, h.now);
    cleanups.push(service.close);
    const oldSurvivorToken = survivor.cookie.split('=')[1] as string;
    expect(
      await service.repos.auth.resolveSession({
        tokenHash: hashSessionToken(oldSurvivorToken),
        now: h.now(),
      }),
    ).toBeNull();
    expect((await service.repos.tenants.findById(survivor.tenant.id))?.status).toBe('active');
    const raw = readFileSync(join(backup, 'manifest.json'), 'utf8');
    expect(raw).not.toContain('delete@example.invalid');
  });
  test('a busy old tenant fence retains quota even after retry exhaustion', async () => {
    const h = harness();
    const auth = await h.login('busy@example.invalid');
    await runHostedWorkerOnce(h.service);
    const watchlistId = await importStocks(h, auth, 'busy old worker');
    await h.request(
      '/api/jobs',
      'POST',
      {
        operation: 'report.watchlist-facts',
        version: 1,
        requestId: 'busy',
        input: { watchlistId },
      },
      auth.cookie,
      auth.csrf,
    );
    const old = await h.service.repos.jobs.claimJob({
      workerId: 'old',
      attemptId: 'old-attempt',
      now: h.now(),
      leaseMs: 120_000,
    });
    if (old === null) throw new Error('old job missing');
    const tenant = await h.service.repos.tenants.findById(auth.tenant.id);
    if (tenant === null) throw new Error('tenant missing');
    const lease = h.service.runtimes.acquire({
      tenantId: tenant.id,
      ownerUserId: tenant.ownerUserId,
      generation: tenant.generation,
      schemaVersion: tenant.schemaVersion,
    });
    await lease.runtime.repos.hostedTenant?.claimExecution({
      operationId: old.operationId,
      generation: old.generation,
      attemptId: 'old-attempt',
      now: h.now(),
      leaseMs: 300_000,
    });
    lease.release();
    h.advance(120_001);
    await runHostedWorkerOnce(h.service);
    h.advance(6_000);
    await runHostedWorkerOnce(h.service);
    expect((await h.service.repos.jobs.findById(old.id))?.state).toBe('needs-review');
    expect((await h.service.repos.jobs.findReservation(old.operationId))?.state).toBe('held');
  });
  test('worker polling recovers a lost payment callback without a browser or a second order', async () => {
    const h = harness();
    const auth = await h.login('payment-poll@example.invalid');
    await runHostedWorkerOnce(h.service);
    const submitted = await h.request(
      '/api/subscription/orders',
      'POST',
      { planVersionId: 'hosted-fixture-v1', requestId: 'poll-once' },
      auth.cookie,
      auth.csrf,
    );
    if (!submitted.result.ok) throw new Error('order missing');
    const order = submitted.result.data.order as { id: string; merchantOrderId: string };
    if (!(h.service.providers.payment instanceof FixtureHostedPaymentAdapter))
      throw new Error('fixture missing');
    h.service.providers.payment.confirmPayment(order.merchantOrderId);
    h.advance(60_001);
    await runHostedWorkerOnce(h.service);
    await runHostedWorkerOnce(h.service);
    expect(
      (await h.service.repos.payments.findOrder({ id: order.id, tenantId: auth.tenant.id }))?.state,
    ).toBe('paid');
    expect(
      (await h.service.repos.subscriptions.listPeriods(auth.tenant.id)).filter(
        (period) => period.sourceOrderId === order.id,
      ),
    ).toHaveLength(1);
    expect(await h.service.repos.payments.listOrders(auth.tenant.id)).toHaveLength(1);
  });
  test('frozen restore queries the original paid order once without creating payments or reopening writers', async () => {
    const h = harness();
    const auth = await h.login('restore-payment@example.invalid');
    await runHostedWorkerOnce(h.service);
    const submitted = await h.request(
      '/api/subscription/orders',
      'POST',
      { planVersionId: 'hosted-fixture-v1', requestId: 'restore-order' },
      auth.cookie,
      auth.csrf,
    );
    if (
      !submitted.result.ok ||
      !(h.service.providers.payment instanceof FixtureHostedPaymentAdapter)
    )
      throw new Error('payment fixture missing');
    const order = submitted.result.data.order as { id: string; merchantOrderId: string };
    h.service.providers.payment.confirmPayment(order.merchantOrderId);
    h.advance(60_001);
    h.service.maintenance.begin('restore:payment');
    h.service.maintenance.freeze('restore:payment');
    h.service.close();
    const prepared = await reconcileHostedRestoredData({
      dataRoot: h.root,
      deletionLedger: h.config.deletionLedgerRoot,
      config: h.config,
      writersStopped: true,
      clock: h.now,
    });
    expect(prepared.pendingReview.pendingPayments).toBe(1);
    const result = await reconcileHostedExternalResults({
      dataRoot: h.root,
      config: h.config,
      writersStopped: true,
      providers: h.service.providers,
      clock: h.now,
    });
    expect(result).toMatchObject({
      mode: 'frozen',
      queriedOrders: 1,
      failedQueries: 0,
      pendingReview: { pendingPayments: 0 },
    });
    expect(
      (
        await reconcileHostedExternalResults({
          dataRoot: h.root,
          config: h.config,
          writersStopped: true,
          providers: h.service.providers,
          clock: h.now,
        })
      ).queriedOrders,
    ).toBe(0);
    await resumeHostedRestoredService({ dataRoot: h.root, writersStopped: true });
    const restored = openHostedService(h.config, undefined, h.now);
    cleanups.push(restored.close);
    expect(await restored.repos.payments.listOrders(auth.tenant.id)).toHaveLength(1);
    expect(
      (await restored.repos.subscriptions.listPeriods(auth.tenant.id)).filter(
        (period) => period.sourceOrderId === order.id,
      ),
    ).toHaveLength(1);
  });
  test('signed payment callbacks are the only Origin exception and duplicates grant one paid period', async () => {
    const h = harness();
    const a = await h.login('billing-a@example.invalid');
    const b = await h.login('billing-b@example.invalid');
    await runHostedWorkerOnce(h.service);
    await runHostedWorkerOnce(h.service);
    expect(
      (await h.request('/api/watchlists', 'POST', { name: 'bad csrf' }, a.cookie, b.csrf)).response
        .status,
    ).toBe(403);
    const missingOrigin = await h.app.fetch(
      new Request(`${origin}/api/watchlists`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: a.cookie, 'x-csrf-token': a.csrf },
        body: JSON.stringify({ name: 'missing origin' }),
      }),
    );
    expect(missingOrigin.status).toBe(403);
    const created = await h.request(
      '/api/subscription/orders',
      'POST',
      { planVersionId: h.service.providers.trialPlan.id, requestId: 'buy-once' },
      a.cookie,
      a.csrf,
    );
    if (!created.result.ok) throw new Error('order create failed');
    const order = created.result.data.order as { id: string; merchantOrderId: string };
    expect(
      (
        await h.request(
          '/api/subscription/orders',
          'POST',
          {
            planVersionId: h.service.providers.trialPlan.id,
            requestId: 'buy-once',
            amountMinor: 1,
          },
          a.cookie,
          a.csrf,
        )
      ).response.status,
    ).toBe(400);
    const payment = h.service.providers.payment;
    if (!(payment instanceof FixtureHostedPaymentAdapter))
      throw new Error('payment fixture missing');
    const signed = payment.signWebhook(payment.confirmPayment(order.merchantOrderId));
    const callback = () =>
      h.app.fetch(
        new Request(`${origin}/api/webhooks/payment`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-luoome-payment-timestamp': signed.timestamp,
            'x-luoome-payment-signature': signed.signature,
          },
          body: signed.rawBody,
        }),
      );
    expect((await callback()).status).toBe(200);
    expect((await callback()).status).toBe(200);
    expect(
      (await h.service.repos.subscriptions.listPeriods(a.tenant.id)).filter(
        (period) => period.status === 'paid',
      ),
    ).toHaveLength(1);
    expect(
      (await h.service.repos.subscriptions.listPeriods(b.tenant.id)).filter(
        (period) => period.status === 'paid',
      ),
    ).toHaveLength(0);
    expect(
      (
        await h.app.fetch(
          new Request(`${origin}/api/webhooks/payment`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: signed.rawBody,
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await h.app.fetch(
          new Request(`${origin}/api/webhooks/payment`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-luoome-payment-timestamp': signed.timestamp,
              'x-luoome-payment-signature': '0'.repeat(64),
            },
            body: signed.rawBody,
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await h.app.fetch(
          new Request(`${origin}/api/webhooks/payment`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: new Uint8Array([255]),
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await h.app.fetch(
          new Request(`${origin}/api/webhooks/payment`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: ' '.repeat(65_537),
          }),
        )
      ).status,
    ).toBe(400);
  });
});

describe('hosted original Web subscription integration', () => {
  test('首页与确切提醒入口延续登录、租户隔离和草案来源保护', async () => {
    const h = harness({ productPolicy: 'hosted-web-v2' });
    expect((await h.request('/api/workspace')).response.status).toBe(401);
    expect((await h.request('/api/watch/notifications/foreign-trigger')).response.status).toBe(401);
    const first = await h.login('workspace-a@example.invalid');
    const second = await h.login('workspace-b@example.invalid');
    await runHostedWorkerOnce(h.service);
    await runHostedWorkerOnce(h.service);
    const workspace = await h.request('/api/workspace', 'GET', undefined, first.cookie);
    expect(workspace.result).toMatchObject({
      ok: true,
      data: { accountId: 'default-account', investment: { ok: true, data: { consensus: null } } },
    });
    const session = await h.request('/api/chat/sessions', 'POST', {}, first.cookie, first.csrf);
    if (!session.result.ok) throw new Error('fixture session missing');
    const sessionId = (session.result.data.session as { id: string }).id;
    const draft = {
      sessionId,
      tool: 'research_investment_directions',
      userText: '研究已有范围',
      input: { requestId: 'private-research', question: '研究已有范围' },
    };
    expect(
      (await h.request('/api/workspace/drafts', 'POST', draft, first.cookie)).response.status,
    ).toBe(403);
    expect(
      (await h.request('/api/workspace/drafts', 'POST', draft, second.cookie, second.csrf)).response
        .status,
    ).toBe(404);
    expect(
      (await h.request('/api/workspace/drafts', 'POST', draft, first.cookie, first.csrf)).result.ok,
    ).toBe(true);
    expect(
      (await h.request(`/api/chat/sessions/${sessionId}`, 'GET', undefined, second.cookie)).response
        .status,
    ).toBe(404);
    expect(
      (await h.request('/api/watch/notifications/foreign-trigger', 'GET', undefined, second.cookie))
        .response.status,
    ).toBe(404);
    expect(
      (
        await h.request(
          '/api/tools/resolve_hosted_watch_notification/call',
          'POST',
          { input: { triggerId: 'foreign-trigger' } },
          first.cookie,
          first.csrf,
        )
      ).response.status,
    ).toBe(404);
  });
  test('reuses the original shell and protects every business API before login', async () => {
    const h = harness({ productPolicy: 'hosted-web-v2' });
    const shell = await h.app.fetch(new Request(`${origin}/`));
    const html = await shell.text();
    expect(html).toContain('data-runtime="hosted"');
    expect(html).toContain('/js/app.js');
    expect(html).not.toContain('/hosted.js');
    for (const route of ['watchlists', 'strategies', 'alerts', 'review', 'holdings'])
      expect(html).toContain(`id="route-${route}"`);
    for (const path of [
      '/api/accounts',
      '/api/strategies',
      '/api/watchlists',
      '/api/review',
      '/api/notifications/preferences',
      '/api/subscription',
    ])
      expect((await h.request(path)).response.status).toBe(401);
  });

  test('creates one default account, preserves edits and denies account creation or switching', async () => {
    const h = harness({ productPolicy: 'hosted-web-v2' });
    const auth = await h.login('account@example.invalid');
    await runHostedWorkerOnce(h.service);
    const accounts = await h.request('/api/accounts', 'GET', undefined, auth.cookie);
    expect(accounts.result).toMatchObject({
      ok: true,
      data: {
        accounts: [
          {
            id: 'default-account',
            kind: 'real',
            currency: 'CNY',
            initialCapital: 0,
            cashBalance: 0,
          },
        ],
      },
    });
    const edit = await h.request(
      '/api/tools/update_account/call',
      'POST',
      {
        input: { name: '我的投资记录' },
      },
      auth.cookie,
      auth.csrf,
    );
    expect(edit.result).toMatchObject({ ok: true, data: { account: { name: '我的投资记录' } } });
    const reads = await Promise.all(
      Array.from({ length: 5 }, () => h.request('/api/accounts', 'GET', undefined, auth.cookie)),
    );
    for (const read of reads)
      expect(read.result).toMatchObject({
        ok: true,
        data: { accounts: [{ name: '我的投资记录' }] },
      });
    expect(
      (
        await h.request(
          '/api/tools/create_account/call',
          'POST',
          {
            input: { name: '额外账户', currency: 'CNY', initialCapital: 0 },
          },
          auth.cookie,
          auth.csrf,
        )
      ).response.status,
    ).toBe(403);
    expect(
      (
        await h.request(
          '/api/account/select',
          'POST',
          { accountId: 'default-account' },
          auth.cookie,
          auth.csrf,
        )
      ).response.status,
    ).toBe(403);
    expect(
      (
        await h.request(
          '/api/tools/update_account/call',
          'POST',
          {
            input: { name: '不可改资金', initialCapital: 1000 },
          },
          auth.cookie,
          auth.csrf,
        )
      ).response.status,
    ).toBe(400);
  });

  test('original watchlist and strategy routes isolate concurrent users and account edits', async () => {
    const h = harness({ productPolicy: 'hosted-web-v2' });
    const a = await h.login('a-web@example.invalid');
    const b = await h.login('b-web@example.invalid');
    await runHostedWorkerOnce(h.service);
    await runHostedWorkerOnce(h.service);
    const make = async (auth: typeof a, name: string) => {
      const list = await h.request(
        '/api/watchlists',
        'POST',
        { id: 'same-list', name, kind: 'personal', membershipPolicy: 'manual' },
        auth.cookie,
        auth.csrf,
      );
      expect(list.result.ok).toBe(true);
      const strategy = await h.request(
        '/api/strategies',
        'POST',
        { id: 'same-strategy', name, description: `${name}策略` },
        auth.cookie,
        auth.csrf,
      );
      expect(strategy.result.ok).toBe(true);
    };
    await Promise.all([make(a, 'A 自选'), make(b, 'B 自选')]);
    const checks = await Promise.all(
      [a, b].map(async (auth) => ({
        watchlist: (await h.request('/api/watchlists/same-list', 'GET', undefined, auth.cookie))
          .result,
        strategy: (await h.request('/api/strategies/same-strategy', 'GET', undefined, auth.cookie))
          .result,
        review: (await h.request('/api/review', 'GET', undefined, auth.cookie)).result,
      })),
    );
    expect(checks[0]?.watchlist).toMatchObject({
      ok: true,
      data: { watchlist: { name: 'A 自选' } },
    });
    expect(checks[1]?.watchlist).toMatchObject({
      ok: true,
      data: { watchlist: { name: 'B 自选' } },
    });
    expect(checks[0]?.strategy).toMatchObject({ ok: true, data: { strategy: { name: 'A 自选' } } });
    expect(checks[1]?.strategy).toMatchObject({ ok: true, data: { strategy: { name: 'B 自选' } } });
    expect(checks.every((check) => check.review.ok)).toBe(true);
    const aMe = await h.request('/api/me', 'GET', undefined, a.cookie);
    if (!aMe.result.ok) throw new Error('missing session');
    const user = aMe.result.data.user as { id: string };
    expect(
      (
        await h.request('/api/watchlists', 'GET', undefined, b.cookie, undefined, {
          'x-luoome-user-id': user.id,
        })
      ).response.status,
    ).toBe(401);
    expect(
      (await h.request('/api/strategies', 'POST', { name: 'No CSRF' }, a.cookie)).response.status,
    ).toBe(403);
    for (const path of [
      '/api/settings/ai',
      '/api/settings/market',
      '/api/settings/research-vault',
      '/api/data/categories',
    ])
      expect((await h.request(path, 'GET', undefined, a.cookie)).response.status).toBe(403);
  });

  test('expiry keeps original history and billing accessible, but blocks business writes', async () => {
    const h = harness({ productPolicy: 'hosted-web-v2' });
    const auth = await h.login('expiry@example.invalid');
    await runHostedWorkerOnce(h.service);
    const original = await h.service.repos.subscriptions.currentEntitlement({
      tenantId: auth.tenant.id,
      now: h.now(),
    });
    if (original === null) throw new Error('missing trial');
    h.advance(original.period.endsAt.getTime() - h.now().getTime() + 1);
    const current = await h.relogin('expiry@example.invalid');
    for (const path of [
      '/api/accounts',
      '/api/watchlists',
      '/api/strategies',
      '/api/review',
      '/api/subscription',
    ])
      expect((await h.request(path, 'GET', undefined, current.cookie)).result.ok).toBe(true);
    const blocked = await h.request(
      '/api/tools/update_account/call',
      'POST',
      { input: { name: 'expired edit' } },
      current.cookie,
      current.csrf,
    );
    expect(blocked.result).toMatchObject({
      ok: false,
      error: { required: 'entitlement:hosted-web-v2' },
    });
    expect(
      (await h.request('/api/subscription/orders', 'GET', undefined, current.cookie)).result.ok,
    ).toBe(true);
  });
});

test.each(['completion', 'client cancellation'] as const)(
  'hosted SSE retains the tenant runtime through %s and assistant persistence',
  async (ending) => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let finish: Parameters<ChatStreamRuntime['createUIMessageStreamResponse']>[0]['onFinish'];
    const agent = {
      name: 'test-stream',
      run: async () => {
        throw new Error('not used');
      },
      createUIMessageStreamResponse: async (
        request: Parameters<ChatStreamRuntime['createUIMessageStreamResponse']>[0],
      ) => {
        finish = request.onFinish;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    };
    const h = harness({
      productPolicy: 'hosted-web-v2',
      createTenantContext: (base) => ({ ...base, agent }),
    });
    const auth = await h.login('stream@example.invalid');
    await runHostedWorkerOnce(h.service);
    const session = await h.request(
      '/api/chat/sessions',
      'POST',
      { title: '流租约测试' },
      auth.cookie,
      auth.csrf,
    );
    expect(session.result.ok).toBe(true);
    if (!session.result.ok) throw new Error('session missing');
    const id = (session.result.data.session as { id: string }).id;
    const response = await h.app.fetch(
      new Request(`${origin}/api/chat`, {
        method: 'POST',
        headers: {
          origin,
          cookie: auth.cookie,
          'x-csrf-token': auth.csrf,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sessionId: id,
          messages: [{ id: 'hello', role: 'user', parts: [{ type: 'text', text: '你好' }] }],
        }),
      }),
    );
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(h.service.runtimes.drain(auth.tenant.id)).toBe(false);
    if (streamController === undefined || finish === undefined || response.body === null)
      throw new Error('stream missing');
    if (ending === 'client cancellation') {
      await response.body.cancel();
      expect(h.service.runtimes.drain(auth.tenant.id)).toBe(false);
    }
    await finish({
      id: 'reply',
      cancelled: ending === 'client cancellation',
      parts: [{ type: 'text', text: '你好，已保存。' }],
    });
    if (ending === 'completion') {
      streamController.close();
      await response.text();
    }
    expect(h.service.runtimes.drain(auth.tenant.id)).toBe(true);
    const history = await h.request(`/api/chat/sessions/${id}`, 'GET', undefined, auth.cookie);
    expect(history.result).toMatchObject({
      ok: true,
      data: { messages: [{ role: 'user' }, { role: 'assistant' }] },
    });
  },
);

describe('hosted admin console boundary', () => {
  test('admin lists users, records one operator payment and toggles user status', async () => {
    const h = harness({ adminEmails: 'boss@example.invalid' });
    const boss = await h.login('boss@example.invalid');
    const member = await h.login('member@example.invalid');
    await runHostedWorkerOnce(h.service);
    await runHostedWorkerOnce(h.service);

    const me = await h.request('/api/me', 'GET', undefined, boss.cookie);
    expect(me.result.ok && me.result.data.admin).toBe(true);
    const memberMe = await h.request('/api/me', 'GET', undefined, member.cookie);
    expect(memberMe.result.ok && memberMe.result.data.admin).toBe(false);

    expect(
      (await h.request('/api/admin/users', 'GET', undefined, member.cookie)).response.status,
    ).toBe(403);
    const listed = await h.request('/api/admin/users', 'GET', undefined, boss.cookie);
    expect(listed.result.ok).toBe(true);
    if (!listed.result.ok) throw new Error('list failed');
    const rows = listed.result.data.users as Array<{
      user: { emailKey: string };
      tenant: { id: string };
      entitlement: { period: { status: string; endsAt: string } } | null;
    }>;
    expect(rows.map((row) => row.user.emailKey).sort()).toEqual([
      'boss@example.invalid',
      'member@example.invalid',
    ]);
    const memberRow = rows.find((row) => row.user.emailKey === 'member@example.invalid');
    if (memberRow === undefined) throw new Error('member row missing');
    expect(memberRow.entitlement?.period.status).toBe('trial');

    const detail = await h.request(
      `/api/admin/users/${memberRow.tenant.id}`,
      'GET',
      undefined,
      boss.cookie,
    );
    expect(detail.result.ok).toBe(true);
    if (!detail.result.ok) throw new Error('detail failed');
    const plans = await h.service.repos.subscriptions.listPlans();
    const plan = plans[0];
    if (plan === undefined) throw new Error('plan missing');

    const recorded = await h.request(
      `/api/admin/users/${memberRow.tenant.id}/operator-payments`,
      'POST',
      {
        planVersionId: plan.id,
        reference: '微信转账 2026-10-15',
        requestId: 'operator-http-1',
      },
      boss.cookie,
      boss.csrf,
    );
    expect(recorded.result.ok).toBe(true);
    if (!recorded.result.ok) throw new Error(JSON.stringify(recorded.result));
    expect(recorded.result.data.order).toMatchObject({
      state: 'paid',
      provider: 'operator-manual',
      reconciliation: 'none',
    });
    expect(recorded.result.data.period).toMatchObject({
      status: 'paid',
      startsAt: memberRow.entitlement?.period.endsAt,
    });
    const replay = await h.request(
      `/api/admin/users/${memberRow.tenant.id}/operator-payments`,
      'POST',
      {
        planVersionId: plan.id,
        reference: '微信转账 2026-10-15',
        requestId: 'operator-http-1',
      },
      boss.cookie,
      boss.csrf,
    );
    expect(replay.result.ok && replay.result.data.replayed).toBe(true);

    const memberId = (detail.result.data.user as { id: string }).id;
    expect(
      (
        await h.request(
          `/api/admin/users/${memberId}/status`,
          'POST',
          { status: 'disabled' },
          member.cookie,
          member.csrf,
        )
      ).response.status,
    ).toBe(403);
    const disabled = await h.request(
      `/api/admin/users/${memberId}/status`,
      'POST',
      { status: 'disabled' },
      boss.cookie,
      boss.csrf,
    );
    expect(disabled.result.ok && disabled.result.data.user).toMatchObject({ status: 'disabled' });
    expect((await h.request('/api/me', 'GET', undefined, member.cookie)).response.status).toBe(401);
    const enabled = await h.request(
      `/api/admin/users/${memberId}/status`,
      'POST',
      { status: 'active' },
      boss.cookie,
      boss.csrf,
    );
    expect(enabled.result.ok && enabled.result.data.user).toMatchObject({ status: 'active' });

    const csrfMissing = await h.request(
      `/api/admin/users/${memberId}/status`,
      'POST',
      { status: 'disabled' },
      boss.cookie,
    );
    expect(csrfMissing.response.status).toBe(403);
  });
});
