import { afterEach, describe, expect, it, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInMemoryRepos } from '@luoome/db';
import { buildContext } from '@luoome/tools';
import { loadConfiguredHostedProviders, openHostedService } from './hosted-composition.js';
import { loadHostedConfig } from './hosted-config.js';
import {
  createEmailOtpFromEnv,
  createHostedNotificationFromEnv,
  createHostedProviders,
} from './hosted-providers.js';
import { createHostedWebApp } from './hosted-server.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'luoome-providers-'));
  roots.push(root);
  const planFile = join(root, 'plan.json');
  writeFileSync(
    planFile,
    JSON.stringify({
      id: 'operator-preview-v1',
      code: 'preview',
      currency: 'CNY',
      priceMinor: 0,
      durationMonths: 1,
      productPolicyVersion: 'hosted-web-v2',
      publishedAt: '2026-10-14T00:00:00Z',
      limits: {
        watchlistStocks: 20,
        enabledRules: 5,
        dailyJobs: 5,
        concurrentJobs: 1,
        queuedJobs: 5,
        researchUnits: 10,
      },
    }),
  );
  const config = loadHostedConfig({
    HOSTED_ENVIRONMENT: 'production',
    HOSTED_DATA_ROOT: join(root, 'data'),
    HOSTED_DELETION_LEDGER_ROOT: join(root, 'ledger'),
    PUBLIC_ORIGIN: 'https://example.invalid',
    HOSTED_AUTH_SECRET: 'provider-tests-only-auth-key-32-characters',
  });
  const env = {
    HOSTED_PLAN_FILE: planFile,
    HOSTED_JOB_BUDGET_MICRO: '1000',
    LUOOME_MARKET_PROVIDER: 'real',
  };
  return { root, config, env };
};

describe('production Web providers', () => {
  it('shares public quote cache and HTTP quota across independently assembled Web/worker providers', async () => {
    const { config, env } = setup();
    const fields = Array.from({ length: 39 }, () => '');
    Object.assign(fields, {
      2: '002594',
      3: '250',
      4: '249',
      5: '250',
      6: '10',
      30: '20261015100000',
      33: '251',
      34: '249',
    });
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      await Bun.sleep(20);
      return new Response(`v_sz002594="${fields.join('~')}";`);
    }) as unknown as typeof fetch);
    try {
      const settings = {
        ...env,
        LUOOME_MARKET_SOURCES: 'tencent',
        LUOOME_MARKET_REQUESTS_PER_WINDOW: '1',
      };
      const web = createHostedProviders(config, settings);
      const worker = createHostedProviders(config, settings);
      const [a, b] = await Promise.all([
        web.market.fetchQuote('002594.SZ'),
        worker.market.fetchQuote('002594.SZ'),
      ]);
      expect(a.observedAt).toEqual(b.observedAt);
      expect(Number(a.close)).toBe(250);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const restarted = createHostedProviders(config, settings);
      expect((await restarted.market.fetchQuote('002594.SZ')).observedAt).toEqual(a.observedAt);
      expect((await worker.market.batchQuote(['600519.SH', '600000.SH'])).size).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('uses built-in live providers without a custom module or fake data', async () => {
    const { config, env } = setup();
    const providers = await loadConfiguredHostedProviders(config, env);
    expect(providers?.market.name).not.toBe('fake-market');
    expect(providers?.stockSeed).toEqual([]);
    expect(providers?.payment.configured).toBe(false);
    expect(providers?.notification.configured).toBe(false);
    expect(providers?.emailOtp.providerKind).toBe('live');
    await expect(
      loadConfiguredHostedProviders(config, { ...env, HOSTED_PROVIDERS_MODULE: 'relative.ts' }),
    ).rejects.toThrow('absolute');
  });

  it('requires an explicit plan, budgets and AI configuration without reading local settings', () => {
    const { config, env } = setup();
    expect(() => createHostedProviders(config, {})).toThrow('HOSTED_PLAN_FILE');
    expect(() => createHostedProviders(config, { ...env, HOSTED_JOB_BUDGET_MICRO: '0' })).toThrow(
      'HOSTED_JOB_BUDGET_MICRO',
    );
    expect(() => createHostedProviders(config, { ...env, HOSTED_AI_ENABLED: 'true' })).toThrow(
      'LUOOME_AI_CONFIG',
    );
    expect(() => createHostedProviders({ ...config, registrationEnabled: true }, env)).toThrow(
      'SMTP',
    );
  });

  it('rebuilds the shared market stack when operator market settings change', async () => {
    const { config, env } = setup();
    // 请求协调器在装配时捕获 fetch，必须先装 mock 再建 providers。
    const hosts: string[] = [];
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (
      input: Parameters<typeof fetch>[0],
    ) => {
      hosts.push(new URL(input instanceof Request ? input.url : String(input)).hostname);
      return new Response('not-a-quote-payload', { status: 200 });
    }) as unknown as typeof fetch);
    try {
      const providers = createHostedProviders(config, {
        ...env,
        LUOOME_MARKET_SOURCES: 'eastmoney',
      });
      if (
        providers.marketSettings === undefined ||
        providers.reloadMarketSettings === undefined ||
        providers.syncMarketSettings === undefined
      )
        throw new Error('market settings surface missing');
      expect(providers.marketSettings.read().activeOrder).toEqual(['eastmoney']);
      await providers.market.fetchQuote('002594.SZ').catch(() => {});
      providers.marketSettings.save({ sources: ['tencent'] });
      providers.reloadMarketSettings();
      expect(providers.marketSettings.read().activeOrder).toEqual(['tencent']);
      // 不同股票避开协调器缓存/冷却，确保第二次真正发起上游请求
      await providers.market.fetchQuote('600519.SH').catch(() => {});
      expect(hosts.some((host) => host.endsWith('eastmoney.com'))).toBe(true);
      expect(hosts.some((host) => host.endsWith('gtimg.cn') || host.endsWith('qq.com'))).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('keeps tenant repositories and identity while leaving absent AI explicitly unavailable', async () => {
    const { config, env } = setup();
    const providers = createHostedProviders(config, {
      ...env,
      LUOOME_FEISHU_WEBHOOK_URL: 'https://example.invalid/private-hook',
    });
    const base = buildContext({
      repos: createInMemoryRepos(),
      adapters: {
        market: providers.market,
        llm: {
          name: 'unset',
          generate: async () => {
            throw new Error('unset');
          },
        },
      },
    });
    if (!providers.createTenantContext) throw new Error('tenant context factory missing');
    const bound = providers.createTenantContext(base);
    expect(bound.repos).toBe(base.repos);
    expect(bound.identity).toBe(base.identity);
    expect(bound.adapters.stockUniverse).toBeDefined();
    expect(bound.agent).toBeUndefined();
    expect(bound.adapters.llm.name).toBe('ai-unconfigured');
    expect(bound.researchVault).toBeUndefined();
  });

  it('can serve a closed deployment but reports login unready and denies business APIs without SMTP', async () => {
    const { config, env } = setup();
    const providers = createHostedProviders(config, env);
    expect(() => openHostedService({ ...config, registrationEnabled: true }, providers)).toThrow(
      'email OTP',
    );
    const service = openHostedService(config, providers);
    try {
      const app = createHostedWebApp({
        config,
        repos: service.repos,
        runtimes: service.runtimes,
        maintenance: service.maintenance,
        emailOtp: providers.emailOtp,
        market: providers.market,
        jobPolicies: providers.jobPolicies,
      });
      expect((await app.request('https://example.invalid/health/live')).status).toBe(200);
      const ready = await app.request('https://example.invalid/health/ready');
      expect(ready.status).toBe(503);
      expect(await ready.json()).toMatchObject({
        ok: false,
        error: { required: 'service:email-unconfigured' },
      });
      expect((await app.request('https://example.invalid/api/accounts')).status).toBe(401);
    } finally {
      service.close();
    }
  });
});

describe('SMTP environment boundary', () => {
  it('requires separate notification opt-in and SMTP configuration without sending mail', () => {
    const { config, env } = setup();
    const smtp = {
      ...env,
      SMTP_HOST: 'smtp.example.invalid',
      SMTP_PORT: '587',
      SMTP_FROM: 'notification@example.invalid',
    };
    const transport = {
      sendMail: async () => {
        throw new Error('unexpected SMTP IO');
      },
    };
    expect(
      createHostedProviders(config, smtp, { smtpTransport: transport }).notification.configured,
    ).toBe(false);
    const configured = createHostedProviders(
      config,
      { ...smtp, HOSTED_NOTIFICATION_PROVIDER: 'smtp' },
      { smtpTransport: transport },
    );
    expect(configured.notification).toMatchObject({
      configured: true,
      providerKind: 'live',
      name: 'hosted-email-smtp',
      idempotency: 'unsupported',
    });
    expect(configured.emailOtp.configured).toBe(true);
    expect(() =>
      createHostedNotificationFromEnv(config, { HOSTED_NOTIFICATION_PROVIDER: 'smtp' }),
    ).toThrow('SMTP_HOST');
    expect(() =>
      createHostedNotificationFromEnv(config, { HOSTED_NOTIFICATION_PROVIDER: 'private-value' }),
    ).toThrow('must be disabled or smtp');
    expect(() => createEmailOtpFromEnv({ SMTP_PASSWORD_FILE: '/fixture/absent' })).toThrow(
      'SMTP_HOST',
    );
  });
  it('keeps email unavailable until configured and rejects incomplete or ambiguous settings', () => {
    expect(createEmailOtpFromEnv({}).configured).toBe(false);
    expect(() => createEmailOtpFromEnv({ SMTP_FROM: 'login@example.invalid' })).toThrow(
      'SMTP_HOST',
    );
    expect(() =>
      createEmailOtpFromEnv({ SMTP_HOST: 'smtp.example.invalid', SMTP_USER: 'user' }),
    ).toThrow('both');
    expect(() =>
      createEmailOtpFromEnv({
        SMTP_HOST: 'smtp.example.invalid',
        SMTP_PASSWORD: 'private',
        SMTP_PASSWORD_FILE: '/absent',
      }),
    ).toThrow('only one');
  });
  it('loads a bounded password file and configures encrypted SMTP without sending mail', () => {
    const { root } = setup();
    const passwordFile = join(root, 'smtp-password');
    writeFileSync(passwordFile, 'test-password\n', { mode: 0o600 });
    expect(
      createEmailOtpFromEnv({
        SMTP_HOST: 'smtp.example.invalid',
        SMTP_PORT: '587',
        SMTP_FROM: 'login@example.invalid',
        SMTP_USER: 'user',
        SMTP_PASSWORD_FILE: passwordFile,
      }).configured,
    ).toBe(true);
    writeFileSync(passwordFile, 'x'.repeat(4097));
    expect(() =>
      createEmailOtpFromEnv({
        SMTP_HOST: 'smtp.example.invalid',
        SMTP_PASSWORD_FILE: passwordFile,
      }),
    ).toThrow('invalid service configuration');
  });
});

test('administrator changes apply to existing Web and worker providers without restart', async () => {
  const { config, env } = setup();
  const configured = { ...config, exposeWrite: true, exposeExternal: true };
  const web = createHostedProviders(configured, env);
  const worker = createHostedProviders(configured, env);
  const service = openHostedService(configured, web);
  const otherService = openHostedService(configured, worker);
  try {
    const base = buildContext({
      repos: createInMemoryRepos(),
      adapters: {
        market: web.market,
        llm: {
          name: 'unused',
          generate: async () => {
            throw new Error('unused');
          },
        },
      },
      user: { id: 'fixture', defaultAccountId: '' },
    });
    expect(web.createTenantContext?.(base).adapters.llm.name).toBe('ai-unconfigured');
    web.aiSettings!.save({
      settings: { ...web.aiSettings!.read().settings, enabled: true },
      apiKey: 'fixture-live-reload-key',
    });
    expect(web.createTenantContext?.(base).agent?.name).toBe('hosted-metered:deepseek-flash');
    expect(worker.createTenantContext?.(base).agent?.name).toBe('hosted-metered:deepseek-flash');
    web.aiSettings!.save({ settings: { ...web.aiSettings!.read().settings, enabled: false } });
    expect(worker.createTenantContext?.(base).agent).toBeUndefined();
  } finally {
    otherService.close();
    service.close();
  }
});
