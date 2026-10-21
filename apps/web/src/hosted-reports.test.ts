import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixtureEmailOtpAdapter } from '@luoome/adapters/hosted';
import type { ToolResult } from '@luoome/core';
import { runHostedReportPass } from '../../worker/src/reports.js';
import { openHostedService } from './hosted-composition.js';
import { loadHostedConfig } from './hosted-config.js';
import { createHostedWebApp } from './hosted-server.js';
import { runHostedWorkerOnce } from './hosted-worker.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const setup = (envExtras: Record<string, string> = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'luoome-ds3-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  let now = new Date('2026-10-15T01:00:00Z');
  const origin = 'https://ds3.example.invalid';
  const config = loadHostedConfig({
    HOSTED_ENVIRONMENT: 'development',
    HOSTED_DATA_ROOT: root,
    PUBLIC_ORIGIN: origin,
    HOSTED_AUTH_SECRET: 'ds3-fixture-auth-secret-32-characters',
    HOSTED_PRODUCT_POLICY: 'hosted-web-v2',
    HOSTED_PROVIDER_MODE: 'fixture',
    HOSTED_REGISTRATION_ENABLED: 'true',
    LUOOME_EXPOSE_WRITE: 'true',
    LUOOME_EXPOSE_EXTERNAL: 'true',
    ...envExtras,
  });
  let service = openHostedService(config, undefined, () => now);
  cleanup.push(() => service.close());
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
    return { response, result: (await response.json()) as ToolResult<Record<string, unknown>> };
  };
  const login = async (email: string) => {
    const challenge = await request('/api/auth/challenges', { email });
    if (!challenge.result.ok || !(service.providers.emailOtp instanceof FixtureEmailOtpAdapter))
      throw new Error('fixture OTP failed');
    const code = service.providers.emailOtp.getMessage(
      challenge.result.data.challengeId as string,
    )?.code;
    const login = await request('/api/auth/sessions', {
      challengeId: challenge.result.data.challengeId,
      code,
      password: 'ds3-fixture-password',
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
  const privateRepos = (tenantId: string) => {
    const tenant = service.repos.tenants.findById(tenantId);
    return tenant.then((tenant) => {
      if (!tenant) throw new Error('fixture tenant missing');
      return service.runtimes.acquire({
        tenantId,
        ownerUserId: tenant.ownerUserId,
        generation: tenant.generation,
        schemaVersion: tenant.schemaVersion,
      });
    });
  };
  return {
    request,
    login,
    privateRepos,
    pass: (id: string) => runHostedReportPass(service, id),
    service: () => service,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    restart: () => {
      service.close();
      service = openHostedService(config, undefined, () => now);
    },
  };
};

test('concurrent report workers and a service restart preserve private reports, receipts and existing Web history', async () => {
  const h = setup();
  const first = await h.login('ds3-first@example.invalid');
  const second = await h.login('ds3-second@example.invalid');
  const webhookUrl = 'https://open.feishu.cn/open-apis/bot/v2/hook/ds3-first-fixture';
  expect(
    (await h.request('/api/notifications/feishu', { expectedRevision: 0, webhookUrl }, first))
      .result.ok,
  ).toBe(true);
  const calls: string[] = [];
  const http = spyOn(globalThis, 'fetch').mockImplementation((async (
    input: Parameters<typeof fetch>[0],
  ) => {
    calls.push(String(input));
    return Response.json({ StatusCode: 0 });
  }) as typeof fetch);
  cleanup.push(() => http.mockRestore());
  const results = await Promise.all([h.pass('worker-A'), h.pass('worker-B')]);
  expect(results.reduce((sum, pass) => sum + pass.created, 0)).toBe(2);
  expect(calls).toEqual([webhookUrl]);
  const a = await h.privateRepos(first.tenantId);
  const b = await h.privateRepos(second.tenantId);
  let firstReportId: string;
  try {
    const reports = await a.runtime.repos.report.list({});
    firstReportId = reports[0]?.id as string;
    expect(reports).toHaveLength(1);
    expect((await a.runtime.repos.reportAutomation.list())[0]).toMatchObject({
      tenantId: first.tenantId,
      state: 'accepted',
      deliveredAt: null,
    });
    expect((await b.runtime.repos.reportAutomation.list())[0]).toMatchObject({
      tenantId: second.tenantId,
      state: 'suppressed',
      errorKind: 'fallback-log',
    });
    expect(await b.runtime.repos.report.findById(firstReportId)).toBeNull();
  } finally {
    a.release();
    b.release();
  }
  const history = await h.request('/api/reports', undefined, first);
  expect(history.result.ok).toBe(true);
  expect(JSON.stringify(history.result)).toContain(firstReportId);
  expect(
    (await h.request(`/api/reports/${firstReportId}`, undefined, second)).response.status,
  ).toBe(404);
  h.restart();
  h.advance(60_000);
  expect(await h.pass('after-restart')).toMatchObject({ created: 0, accepted: 0 });
  expect(calls).toHaveLength(1);
});

test('订阅门禁关闭后试用到期仍生成报告', async () => {
  const h = setup({ HOSTED_ENTITLEMENT_REQUIRED: 'false' });
  const auth = await h.login('ds3-free@example.invalid');
  h.advance(8 * 86_400_000);
  expect(
    await h.service().repos.subscriptions.currentEntitlement({
      tenantId: auth.tenantId,
      now: h.service().clock(),
    }),
  ).toBeNull();
  const result = await h.pass('worker-free');
  expect(result.created).toBe(1);
  const lease = await h.privateRepos(auth.tenantId);
  try {
    const reports = await lease.runtime.repos.report.list({});
    expect(reports).toHaveLength(1);
    expect(reports[0]?.kind).toBe('opening');
  } finally {
    lease.release();
  }
});

test.each(['expired', 'suspended'] as const)(
  '%s entitlement suppresses an already saved pending report retry',
  async (condition) => {
    const h = setup();
    const auth = await h.login(`ds3-${condition}@example.invalid`);
    await h.request(
      '/api/notifications/feishu',
      {
        expectedRevision: 0,
        webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/ds3-retry-fixture',
      },
      auth,
    );
    const http = spyOn(globalThis, 'fetch').mockImplementation(
      (async () => new Response('rejected', { status: 503 })) as unknown as typeof fetch,
    );
    cleanup.push(() => http.mockRestore());
    await h.pass('first-worker');
    expect(http).toHaveBeenCalledTimes(1);
    if (condition === 'expired') h.advance(8 * 86_400_000);
    else {
      const tenant = await h.service().repos.tenants.findById(auth.tenantId);
      if (!tenant) throw new Error('fixture tenant missing');
      await h.service().repos.tenants.suspend({
        id: tenant.id,
        generation: tenant.generation,
        now: new Date('2026-10-15T01:00:30Z'),
      });
    }
    await h.pass('after-loss-of-entitlement');
    expect(http).toHaveBeenCalledTimes(1);
    const lease = await h.privateRepos(auth.tenantId);
    try {
      expect((await lease.runtime.repos.reportAutomation.list())[0]).toMatchObject({
        state: 'suppressed',
        errorKind: 'tenant-unavailable',
      });
      expect(await lease.runtime.repos.report.list({})).toHaveLength(1);
    } finally {
      lease.release();
    }
  },
);
