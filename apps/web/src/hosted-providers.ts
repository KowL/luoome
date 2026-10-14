import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  createAIStackFromEnv,
  createAShareSentimentManagerFromEnv,
  createDragonTigerManagerFromEnv,
  createLimitUpLadderManagerFromEnv,
  createMarketAdapterFromEnv,
  createNewsManagerFromEnv,
  createNorthboundFlowManagerFromEnv,
  createNotificationManagerFromEnv,
  createResearchRemoteDocumentAdapter,
  createSectorQuoteManagerFromEnv,
  createStockUniverseManagerFromEnv,
  EastmoneySource,
} from '@luoome/adapters';
import {
  SmtpEmailOtpAdapter,
  UnconfiguredEmailOtpAdapter,
  UnconfiguredHostedNotificationAdapter,
  UnconfiguredHostedPaymentAdapter,
} from '@luoome/adapters/hosted';
import { type EmailOtpPort, PlanVersionSchema } from '@luoome/core';
import { z } from 'zod';
import type { HostedProviders } from './hosted-composition.js';
import type { HostedConfig } from './hosted-config.js';

type Environment = Readonly<Record<string, string | undefined>>;

const readConfigurationFile = (path: string, maxBytes: number): string => {
  if (!isAbsolute(path)) throw new Error('service configuration paths must be absolute');
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error('invalid service configuration file');
  return readFileSync(path, 'utf8');
};

export const createEmailOtpFromEnv = (env: Environment): EmailOtpPort => {
  if (!env.SMTP_HOST) {
    if (env.SMTP_FROM || env.SMTP_USER || env.SMTP_PASSWORD)
      throw new Error('SMTP_HOST is required when configuring email delivery');
    return new UnconfiguredEmailOtpAdapter();
  }
  if (env.SMTP_PASSWORD !== undefined && env.SMTP_PASSWORD_FILE !== undefined)
    throw new Error('configure only one SMTP password source');
  const user = env.SMTP_USER?.trim() || undefined;
  const pass =
    (env.SMTP_PASSWORD_FILE === undefined
      ? env.SMTP_PASSWORD
      : readConfigurationFile(env.SMTP_PASSWORD_FILE, 4096).trimEnd()) || undefined;
  const port = z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(env.SMTP_PORT ?? '465');
  const secure =
    env.SMTP_SECURE === undefined
      ? port === 465
      : z.enum(['true', 'false']).parse(env.SMTP_SECURE) === 'true';
  if ((user === undefined) !== (pass === undefined))
    throw new Error('SMTP authentication requires both username and password');
  return new SmtpEmailOtpAdapter({
    host: env.SMTP_HOST,
    port,
    secure,
    starttls: !secure,
    from: env.SMTP_FROM ?? '',
    ...(user === undefined || pass === undefined ? {} : { auth: { user, pass } }),
  });
};

export const createHostedProviders = (
  config: HostedConfig,
  env: Environment = process.env,
): HostedProviders => {
  if (!env.HOSTED_PLAN_FILE) throw new Error('HOSTED_PLAN_FILE must specify the operator plan');
  const trialPlan = PlanVersionSchema.parse(
    JSON.parse(readConfigurationFile(env.HOSTED_PLAN_FILE, 65536)),
  );
  if (trialPlan.productPolicyVersion !== config.productPolicyVersion)
    throw new Error('operator plan must match the Web product policy');
  const budget = z.coerce.number().int().positive().safe().safeParse(env.HOSTED_JOB_BUDGET_MICRO);
  if (!budget.success)
    throw new Error('HOSTED_JOB_BUDGET_MICRO must be an explicit positive integer');
  const emailOtp = createEmailOtpFromEnv(env);
  if (config.registrationEnabled && !emailOtp.configured)
    throw new Error('registration requires a configured SMTP provider');
  const aiEnabled = z.enum(['true', 'false']).parse(env.HOSTED_AI_ENABLED ?? 'false') === 'true';
  if (aiEnabled && (!env.LUOOME_AI_CONFIG || !isAbsolute(env.LUOOME_AI_CONFIG)))
    throw new Error('AI requires an explicit absolute LUOOME_AI_CONFIG');
  const ai = aiEnabled ? createAIStackFromEnv(env, { logger: console }) : undefined;
  const clock = () => new Date();
  const sources = { eastmoney: new EastmoneySource({ clock }) };
  const deps = { clock, sources, logger: console };
  const market = createMarketAdapterFromEnv(env, { ...deps, quoteCacheTtlMs: 10_000 });
  const stockUniverse = createStockUniverseManagerFromEnv(env, deps);
  const limitUpLadder = createLimitUpLadderManagerFromEnv(env, deps);
  const dragonTiger = createDragonTigerManagerFromEnv(env, deps);
  const northboundFlow = createNorthboundFlowManagerFromEnv(env, deps);
  const news = createNewsManagerFromEnv(env, deps);
  const sectorQuote = createSectorQuoteManagerFromEnv(env, deps);
  const ashareSentiment = createAShareSentimentManagerFromEnv(env, { ...deps, market });
  return {
    emailOtp,
    notification: new UnconfiguredHostedNotificationAdapter(),
    payment: new UnconfiguredHostedPaymentAdapter(),
    market,
    stockSeed: [],
    trialPlan,
    jobPolicies: {
      'watchlist-facts': {
        units: 1,
        partialUnits: 0,
        budgetMicro: budget.data,
        priority: 20,
        acceptDeadlineMs: 900_000,
      },
      'watch-alerts': {
        units: 0,
        budgetMicro: budget.data,
        priority: 80,
        acceptDeadlineMs: 900_000,
      },
    },
    createTenantContext: (base) => ({
      ...base,
      adapters: {
        ...base.adapters,
        market,
        stockUniverse,
        llm: ai?.llm ?? {
          name: 'ai-unconfigured',
          generate: async (): Promise<never> => {
            throw new Error('服务尚未配置 AI 模型');
          },
        },
      },
      ...(ai === undefined ? {} : { agent: ai.agent }),
      limitUpLadder,
      dragonTiger,
      northboundFlow,
      news,
      sectorQuote,
      ashareSentiment,
      researchRemote: createResearchRemoteDocumentAdapter(),
      // Do not route different users' notifications to an operator's shared webhook.
      notification: createNotificationManagerFromEnv(
        {},
        { repos: base.repos, clock: base.clock, logger: base.logger },
      ),
    }),
  };
};
