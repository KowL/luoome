import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixtureEmailOtpAdapter } from '@luoome/adapters/hosted';
import type { ToolResult } from '@luoome/core';
import { type StrategyDslV1, strategyDefinitionHash, type ToolContext } from '@luoome/core';
import {
  buildContext,
  prepareStrategyDataTool,
  runStrategyTool,
  syncStockUniverseTool,
} from '@luoome/tools';
import { hostedStrategyExecutionTool } from '@luoome/tools/hosted';
import { runHostedStrategyPass } from '../../worker/src/strategy.js';
import { openHostedService } from './hosted-composition.js';
import { loadHostedConfig } from './hosted-config.js';
import { createHostedWebApp } from './hosted-server.js';
import { runHostedWorkerOnce } from './hosted-worker.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const setup = (envExtras: Record<string, string> = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'luoome-ds5-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  let now = new Date('2026-10-15T09:59:00Z');
  const origin = 'https://ds5.example.invalid';
  const config = loadHostedConfig({
    HOSTED_ENVIRONMENT: 'development',
    HOSTED_DATA_ROOT: root,
    PUBLIC_ORIGIN: origin,
    HOSTED_AUTH_SECRET: 'ds5-fixture-auth-secret-32-characters',
    HOSTED_PRODUCT_POLICY: 'hosted-web-v2',
    HOSTED_PROVIDER_MODE: 'fixture',
    HOSTED_REGISTRATION_ENABLED: 'true',
    LUOOME_EXPOSE_WRITE: 'true',
    LUOOME_EXPOSE_EXTERNAL: 'true',
    ...envExtras,
  });
  const initial = openHostedService(config, undefined, () => now);
  const defaults = initial.providers;
  initial.close();
  let onUniverse = () => {};
  const providers = {
    ...defaults,
    createTenantContext: (base: ToolContext): ToolContext => {
      expect(base.adapters.market).toBe(defaults.market);
      return {
        ...base,
        adapters: {
          ...base.adapters,
          llm: {
            name: 'fixture-offline',
            generate: async () => {
              throw new Error('fixture offline');
            },
          },
          stockUniverse: {
            name: 'stock-universe',
            sources: ['fixture'],
            fetchStockUniverse: async () => {
              onUniverse();
              return {
                source: 'fixture',
                coverage: 'CN_A_SHARES_SH_SZ',
                observedAt: now,
                complete: true,
                reportedTotal: 1,
                entries: defaults.stockSeed.slice(0, 1).map((stock) => ({
                  stockId: stock.id,
                  code: stock.code,
                  exchange: stock.exchange,
                  name: stock.name,
                  listingStatus: 'listed' as const,
                })),
              };
            },
          },
        },
      };
    },
  };
  let service = openHostedService(config, providers, () => now);
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
      password: 'ds5-fixture-password',
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
    beforeUniverse: (callback: () => void) => {
      onUniverse = callback;
    },
    privateRepos,
    pass: (id: string, signal?: AbortSignal) =>
      runHostedStrategyPass(service, id, () => signal?.aborted ?? false, signal),
    service: () => service,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    restart: () => {
      service.close();
      service = openHostedService(config, providers, () => now);
    },
  };
};

const enable = async (
  h: ReturnType<typeof setup>,
  auth: Awaited<ReturnType<ReturnType<typeof setup>['login']>>,
) => {
  const lease = await h.privateRepos(auth.tenantId);
  const now = h.service().clock();
  const definition: StrategyDslV1 = {
    schemaVersion: 1,
    metadata: {},
    universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
    selection: {
      logic: 'all',
      rules: [{ id: 'all', name: 'all', when: 'true', evidence: ['fixture'] }],
    },
    signals: {
      entry: [
        {
          id: 'entry',
          name: 'entry',
          when: 'quote.close > 0',
          score: '80',
          direction: 'bullish',
          evidence: ['fixture'],
        },
      ],
      exit: [],
      risk: [],
    },
  };
  try {
    await lease.runtime.repos.strategy.create({
      id: 'same-strategy',
      name: 'same name',
      description: 'fixture',
      owner: 'user',
      status: 'active',
      currentVersionId: 'same-version',
      createdAt: now,
      updatedAt: now,
    });
    await lease.runtime.repos.strategy.createVersion({
      id: 'same-version',
      strategyId: 'same-strategy',
      version: 1,
      definition,
      definitionHash: strategyDefinitionHash(definition),
      validationStatus: 'valid',
      validationErrors: [],
      publishedAt: now,
      createdAt: now,
    });
  } finally {
    lease.release();
  }
  expect(
    (
      await h.request(
        '/api/strategies/same-strategy/schedule',
        { cron: '0 18 * * 1-5', timezone: 'Asia/Shanghai', enabled: true },
        auth,
      )
    ).result.ok,
  ).toBe(true);
};

test('worker shutdown releases an interrupted strategy without publishing or advancing its schedule', async () => {
  const h = setup();
  const user = await h.login('shutdown@example.invalid');
  await enable(h, user);
  h.advance(60_000);
  const controller = new AbortController();
  h.beforeUniverse(() => controller.abort());
  await h.pass('stopping-worker', controller.signal);
  const lease = await h.privateRepos(user.tenantId);
  try {
    expect(await lease.runtime.repos.strategyRun.listRuns()).toHaveLength(0);
    const schedule = await lease.runtime.repos.strategySchedule.findByStrategyId('same-strategy');
    expect(schedule?.nextRunAt).toEqual(h.service().clock());
    const audits = await lease.runtime.repos.workflowRun.listStrategyDailyCycleAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.status).toBe('failed');
    expect(h.service().maintenance.state().activities).toBe(0);
  } finally {
    lease.release();
  }
  h.beforeUniverse(() => {});
  h.advance(60_000);
  const retried = await h.pass('replacement-worker');
  expect(retried.runs).toBe(1);
});

test('shutdown drains an atomic run and a restarted worker recovers observations without duplicate publication', async () => {
  const h = setup();
  const user = await h.login('shutdown-during-run@example.invalid');
  await enable(h, user);
  h.advance(60_000);
  const controller = new AbortController();
  const lease = await h.privateRepos(user.tenantId);
  const repository = lease.runtime.repos.strategyRun;
  const saveStartedRun = repository.saveStartedRun.bind(repository);
  repository.saveStartedRun = async (run) => {
    await saveStartedRun(run);
    controller.abort();
  };
  let runId: string | undefined;
  try {
    await h.pass('stopping-during-run', controller.signal);
    const runs = await repository.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('complete');
    expect(runs[0]?.publication?.status).toBe('published');
    runId = runs[0]?.id;
    expect(
      await lease.runtime.repos.signalObservation.list({ sourceKind: 'strategy-signal' }),
    ).toHaveLength(0);
    const audits = await lease.runtime.repos.workflowRun.listStrategyDailyCycleAudits();
    expect(audits[0]?.status).toBe('failed');
    expect(h.service().maintenance.state().activities).toBe(0);
  } finally {
    repository.saveStartedRun = saveStartedRun;
    lease.release();
  }
  h.restart();
  h.advance(60_000);
  await h.pass('restarted-after-drain');
  const recovered = await h.privateRepos(user.tenantId);
  try {
    const runs = await recovered.runtime.repos.strategyRun.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(runId);
    expect(
      await recovered.runtime.repos.signalObservation.list({ sourceKind: 'strategy-signal' }),
    ).toHaveLength(3);
    const schedule =
      await recovered.runtime.repos.strategySchedule.findByStrategyId('same-strategy');
    expect(schedule?.nextRunAt?.getTime()).toBeGreaterThan(h.service().clock().getTime());
  } finally {
    recovered.release();
  }
});

test('Web 已有 schedule 接入 worker；并发和重启不串租户，不重复运行或扣额', async () => {
  const h = setup();
  const users = await Promise.all([
    h.login('ds5-a@example.invalid'),
    h.login('ds5-b@example.invalid'),
  ]);
  for (const user of users) await enable(h, user);
  const usage = await Promise.all(
    users.map((user) => h.service().repos.jobs.listUsage({ tenantId: user.tenantId })),
  );
  h.advance(60_000);
  const passes = await Promise.all([h.pass('worker-A'), h.pass('worker-B')]);
  expect(passes.reduce((sum, pass) => sum + pass.runs, 0)).toBe(2);
  const runIds: string[] = [];
  for (const [index, user] of users.entries()) {
    const lease = await h.privateRepos(user.tenantId);
    try {
      const runs = await lease.runtime.repos.strategyRun.listRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]?.publication?.status).toBe('published');
      const id = runs[0]?.id as string;
      runIds.push(id);
      const signals = await lease.runtime.repos.strategyRun.signalsByRun(id);
      const observations = await lease.runtime.repos.signalObservation.list({
        sourceKind: 'strategy-signal',
      });
      expect(observations).toHaveLength(3);
      expect(observations.every((row) => row.sourceId === signals[0]?.id)).toBe(true);
      expect(await lease.runtime.repos.report.list({})).toHaveLength(0);
      expect(await lease.runtime.repos.reportAutomation.list()).toHaveLength(0);
      const execution = await lease.runtime.repos.workflowRun.findById('hosted-strategy-execution');
      expect(execution?.status).toBe('succeeded');
      expect(usage[index]).toEqual(
        await h.service().repos.jobs.listUsage({ tenantId: user.tenantId }),
      );
    } finally {
      lease.release();
    }
  }
  h.restart();
  h.advance(60_000);
  const repeated = await h.pass('restarted');
  expect(repeated.runs).toBe(0);
  for (const [index, user] of users.entries()) {
    const lease = await h.privateRepos(user.tenantId);
    try {
      expect(await lease.runtime.repos.strategyRun.listRuns()).toHaveLength(1);
      expect(
        await lease.runtime.repos.strategyRun.findRunById(runIds[1 - index] as string),
      ).toBeNull();
      expect(usage[index]).toEqual(
        await h.service().repos.jobs.listUsage({ tenantId: user.tenantId }),
      );
    } finally {
      lease.release();
    }
  }
});

test('订阅门禁关闭后试用到期不影响日循环运行', async () => {
  const h = setup({ HOSTED_ENTITLEMENT_REQUIRED: 'false' });
  const user = await h.login('ds5-free@example.invalid');
  await enable(h, user);
  h.advance(8 * 86_400_000);
  expect(
    await h.service().repos.subscriptions.currentEntitlement({
      tenantId: user.tenantId,
      now: h.service().clock(),
    }),
  ).toBeNull();
  const result = await h.pass('worker-free');
  expect(result.runs).toBe(1);
  const lease = await h.privateRepos(user.tenantId);
  try {
    expect(await lease.runtime.repos.strategyRun.listRuns()).toHaveLength(1);
  } finally {
    lease.release();
  }
});

test.each(['expired', 'suspended'] as const)(
  '执行前阻断 %s 租户，不领取运行或调用行情',
  async (condition) => {
    const h = setup();
    const user = await h.login(`ds5-${condition}@example.invalid`);
    await enable(h, user);
    if (condition === 'expired') h.advance(8 * 86_400_000);
    else {
      const tenant = await h.service().repos.tenants.findById(user.tenantId);
      if (!tenant) throw new Error('tenant fixture missing');
      await h.service().repos.tenants.suspend({
        id: tenant.id,
        generation: tenant.generation,
        now: h.service().clock(),
      });
      h.advance(60_000);
    }
    let requests = 0;
    h.beforeUniverse(() => {
      requests += 1;
    });
    expect((await h.pass('blocked')).acquired).toBe(0);
    expect(requests).toBe(0);
    const lease = await h.privateRepos(user.tenantId);
    try {
      expect(await lease.runtime.repos.strategyRun.listRuns()).toHaveLength(0);
    } finally {
      lease.release();
    }
  },
);

test('数据准备期间权益到期，正式运行前重新授权，不生成报告或新运行', async () => {
  const h = setup();
  const user = await h.login('ds5-mid-expiry@example.invalid');
  await enable(h, user);
  h.advance(60_000);
  h.beforeUniverse(() => h.advance(8 * 86_400_000));
  expect((await h.pass('expiry-during-data')).runs).toBe(0);
  const lease = await h.privateRepos(user.tenantId);
  try {
    expect(await lease.runtime.repos.strategyRun.listRuns()).toHaveLength(0);
    expect(await lease.runtime.repos.report.list({})).toHaveLength(0);
  } finally {
    lease.release();
  }
});

test('SQLite 重开后接管未释放租约：恢复同周期已发布运行的观察，不重复扣额', async () => {
  const h = setup();
  const user = await h.login('ds5-crashed@example.invalid');
  await enable(h, user);
  h.advance(60_000);
  const lease = await h.privateRepos(user.tenantId);
  const tenant = await h.service().repos.tenants.findById(user.tenantId);
  if (!tenant) throw new Error('tenant fixture missing');
  const now = h.service().clock();
  let originalId = '';
  const usage = await h.service().repos.jobs.listUsage({ tenantId: user.tenantId });
  try {
    const account = (await lease.runtime.repos.account.list())[0];
    if (!account) throw new Error('account fixture missing');
    const base = buildContext({
      mode: 'hosted',
      repos: lease.runtime.repos,
      identity: {
        mode: 'hosted',
        actor: 'worker',
        tenantId: tenant.id,
        tenantGeneration: tenant.generation,
        userId: tenant.ownerUserId,
        requestId: 'crash-fixture',
      },
      user: { id: tenant.ownerUserId, defaultAccountId: account.id },
      adapters: {
        market: h.service().providers.market,
        llm: {
          name: 'offline',
          generate: async () => {
            throw new Error('fixture offline');
          },
        },
      },
      clock: h.service().clock,
    });
    const context = h.service().providers.createTenantContext;
    if (!context) throw new Error('provider fixture missing');
    const ctx = { ...context(base), hostedAuthorization: async () => null };
    expect(
      await hostedStrategyExecutionTool.execute({ action: 'acquire', owner: 'crashed' }, ctx),
    ).toMatchObject({ ok: true, data: { acquired: true } });
    expect(
      await lease.runtime.repos.strategySchedule.claimDueWithFence({
        now,
        owner: 'crashed',
        leaseUntil: new Date(now.getTime() + 300_000),
        limit: 1,
      }),
    ).toHaveLength(1);
    expect((await syncStockUniverseTool.execute({}, ctx)).ok).toBe(true);
    const prepared = await prepareStrategyDataTool.execute({ strategyId: 'same-strategy' }, ctx);
    if (!prepared.ok) throw new Error('checkpoint fixture missing');
    const run = await runStrategyTool.execute(
      {
        strategyId: 'same-strategy',
        mode: 'scheduled',
        dataCheckpointId: prepared.data.checkpoint.id,
      },
      ctx,
    );
    if (!run.ok) throw new Error('published fixture missing');
    originalId = run.data.run.id;
    expect(
      await lease.runtime.repos.signalObservation.list({ sourceKind: 'strategy-signal' }),
    ).toHaveLength(0);
  } finally {
    lease.release();
  }
  h.restart();
  expect((await h.pass('before-expiry')).acquired).toBe(0);
  h.advance(6 * 60_000);
  expect(await h.pass('successor')).toMatchObject({ acquired: 1, runs: 0 });
  const successor = await h.privateRepos(user.tenantId);
  try {
    const runs = await successor.runtime.repos.strategyRun.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(originalId);
    expect(
      await successor.runtime.repos.signalObservation.list({ sourceKind: 'strategy-signal' }),
    ).toHaveLength(3);
    expect(await h.service().repos.jobs.listUsage({ tenantId: user.tenantId })).toEqual(usage);
  } finally {
    successor.release();
  }
});
