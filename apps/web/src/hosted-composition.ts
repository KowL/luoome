import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  FixtureEmailOtpAdapter,
  FixtureHostedNotificationAdapter,
  FixtureHostedPaymentAdapter,
} from '@luoome/adapters/hosted';
import { FakeLLMAdapter, FakeMarketAdapter, TEST_STOCKS } from '@luoome/adapters/testing';
import type {
  EmailOtpPort,
  HostedNotificationPort,
  HostedPaymentPort,
  MarketDataAdapterLike,
  PlanVersion,
  Stock,
  ToolContext,
} from '@luoome/core';
import {
  createDrizzlePlatformRepos,
  createSqliteMaintenanceGate,
  ensurePlatformSchema,
} from '@luoome/db';
import {
  buildPlatformContext,
  type PlatformContext,
  type PlatformPrincipal,
} from '@luoome/tools/platform';
import type { HostedConfig } from './hosted-config.js';
import { prepareDeletionLedger } from './hosted-privacy.js';
import { createHostedProviders } from './hosted-providers.js';
import { prepareHostedDataRoot, TenantRuntimeManager } from './hosted-runtime.js';

export interface HostedProviders {
  readonly emailOtp: EmailOtpPort;
  readonly notification: HostedNotificationPort;
  readonly payment: HostedPaymentPort;
  readonly market: MarketDataAdapterLike;
  readonly stockSeed: readonly Stock[];
  readonly trialPlan: PlanVersion;
  readonly jobPolicies: PlatformContext['jobPolicies'];
  readonly createTenantContext?: (base: ToolContext) => ToolContext;
}

export const loadConfiguredHostedProviders = async (
  config: HostedConfig,
  env: Record<string, string | undefined> = process.env,
): Promise<HostedProviders | undefined> => {
  const modulePath = env.HOSTED_PROVIDERS_MODULE;
  if (config.providerMode === 'fixture') {
    if (modulePath !== undefined)
      throw new Error('fixture mode cannot load a live provider module');
    return undefined;
  }
  if (modulePath === undefined) return createHostedProviders(config, env);
  if (!isAbsolute(modulePath)) throw new Error('HOSTED_PROVIDERS_MODULE must be an absolute path');
  const module = (await import(pathToFileURL(modulePath).href)) as {
    createHostedProviders?: (config: HostedConfig) => HostedProviders | Promise<HostedProviders>;
  };
  if (typeof module.createHostedProviders !== 'function')
    throw new Error('provider module must export createHostedProviders');
  return module.createHostedProviders(config);
};

export const hostedFixturePlan: PlanVersion = {
  id: 'hosted-fixture-v1',
  code: 'fixture',
  currency: 'CNY',
  priceMinor: 0,
  durationMonths: 1,
  productPolicyVersion: 'hosted-facts-v1',
  publishedAt: new Date('2026-10-10T00:00:00Z'),
  limits: {
    watchlistStocks: 100,
    enabledRules: 20,
    dailyJobs: 20,
    concurrentJobs: 1,
    queuedJobs: 10,
    researchUnits: 30,
  },
};

export const openHostedService = (
  config: HostedConfig,
  supplied?: HostedProviders,
  clock: () => Date = () => new Date(),
) => {
  if (config.providerMode === 'configured' && supplied === undefined) {
    throw new Error(
      'hosted live providers, authorized stock universe, operator plan and pricing policies are required',
    );
  }
  const providers: HostedProviders =
    supplied ??
    ({
      emailOtp: new FixtureEmailOtpAdapter(),
      notification: new FixtureHostedNotificationAdapter(),
      payment: new FixtureHostedPaymentAdapter({ clock }),
      market: new FakeMarketAdapter({
        clock,
        source: 'hosted-fixture',
        timestampSource: 'upstream',
      }),
      stockSeed: TEST_STOCKS,
      trialPlan:
        config.productPolicyVersion === 'hosted-facts-v1'
          ? hostedFixturePlan
          : {
              ...hostedFixturePlan,
              id: 'hosted-fixture-web-v2',
              productPolicyVersion: config.productPolicyVersion,
            },
      createTenantContext: (base: ToolContext): ToolContext => ({
        ...base,
        adapters: { ...base.adapters, llm: new FakeLLMAdapter() },
      }),
      jobPolicies: {
        'watchlist-facts': {
          units: 1,
          partialUnits: 0,
          budgetMicro: 0,
          priority: 20,
          acceptDeadlineMs: 900_000,
        },
        'watch-alerts': { units: 0, budgetMicro: 0, priority: 80, acceptDeadlineMs: 900_000 },
      },
    } satisfies HostedProviders);
  const fixtureProvider =
    providers.emailOtp.providerKind === 'fixture' ||
    providers.notification.providerKind === 'fixture' ||
    providers.payment.providerKind === 'fixture' ||
    providers.market.name === 'fake-market' ||
    providers.trialPlan.code === 'fixture';
  if (config.providerMode === 'configured' && fixtureProvider)
    throw new Error('configured mode requires live providers and an operator plan');
  if (
    config.providerMode === 'fixture' &&
    (providers.emailOtp.providerKind !== 'fixture' ||
      providers.notification.providerKind !== 'fixture' ||
      providers.payment.providerKind !== 'fixture' ||
      providers.market.name !== 'fake-market')
  )
    throw new Error('fixture mode requires isolated fixture providers');
  if (
    config.providerMode === 'configured' &&
    Object.values(providers.jobPolicies).some((policy) => policy.budgetMicro <= 0)
  )
    throw new Error('configured jobs require explicit nonzero provider budgets');
  if (!providers.emailOtp.configured && config.registrationEnabled)
    throw new Error('registration requires a configured email OTP provider');
  if (providers.trialPlan.productPolicyVersion !== config.productPolicyVersion)
    throw new Error('hosted provider plan must match the configured product policy');
  const root = prepareHostedDataRoot(config.dataRoot);
  prepareDeletionLedger(config.deletionLedgerRoot);
  const deletionLedger = realpathSync(config.deletionLedgerRoot);
  if (
    config.environment === 'production' &&
    (deletionLedger === root || deletionLedger.startsWith(`${root}/`))
  )
    throw new Error('production deletion ledger must be independent of the canonical data root');
  for (const file of ['control.sqlite', 'control.sqlite-wal', 'control.sqlite-shm']) {
    const path = join(root, file);
    if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) {
      throw new Error('invalid hosted control storage');
    }
  }
  const handle = createDrizzlePlatformRepos(join(root, 'control.sqlite'), { migrate: false });
  try {
    const maintenance = createSqliteMaintenanceGate(handle.sqlite);
    const startup = maintenance.enterExclusive('startup-migration');
    if (startup === null) throw new Error('hosted startup paused for maintenance');
    try {
      ensurePlatformSchema(handle.db);
    } finally {
      startup.release();
    }
    const runtimes = new TenantRuntimeManager(root, config.runtimeLimit, Date.now, {
      maintenance,
      isCurrent: async (manifest) => {
        const current = await handle.repos.tenants.findById(manifest.tenantId);
        return (
          current !== null &&
          current.generation === manifest.generation &&
          ['active', 'suspended', 'provisioning'].includes(current.status)
        );
      },
    });
    const platformContext = (principal: PlatformPrincipal): PlatformContext =>
      buildPlatformContext({
        repos: handle.repos,
        principal,
        authSecret: config.authSecret,
        environment: config.environment,
        emailOtp: providers.emailOtp,
        notification: providers.notification,
        payment: providers.payment,
        publicOrigin: config.publicOrigin,
        registration: { enabled: config.registrationEnabled, maxUsers: config.registrationLimit },
        capabilities: { write: config.exposeWrite, external: config.exposeExternal },
        jobPolicies: providers.jobPolicies,
        clock,
      });
    return {
      config,
      root,
      handle,
      repos: handle.repos,
      maintenance,
      runtimes,
      providers,
      clock,
      platformContext,
      close: () => {
        runtimes.stop();
        handle.close();
      },
    };
  } catch (error) {
    handle.close();
    throw error;
  }
};
export type HostedService = ReturnType<typeof openHostedService>;
