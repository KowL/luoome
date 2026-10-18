import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  AIModelCatalogConfigSchema,
  createAIStackFromEnv,
  createAShareSentimentManagerFromEnv,
  createDragonTigerManagerFromEnv,
  createHostedLLMExecution,
  createLimitUpLadderManagerFromEnv,
  createMarketAdapterFromEnv,
  createNewsManagerFromEnv,
  createNorthboundFlowManagerFromEnv,
  createNotificationManagerFromEnv,
  createResearchRemoteDocumentAdapter,
  createSectorQuoteManagerFromEnv,
  createStockUniverseManagerFromEnv,
  EastmoneySource,
  hostedLLMToolNames,
  MarketRequestCoordinator,
  marketRequestConfigFromEnv,
} from '@luoome/adapters';
import {
  SmtpEmailOtpAdapter,
  type SmtpEmailOtpOptions,
  type SmtpEmailTransport,
  SmtpHostedNotificationAdapter,
  UnconfiguredEmailOtpAdapter,
  UnconfiguredHostedNotificationAdapter,
  UnconfiguredHostedPaymentAdapter,
} from '@luoome/adapters/hosted';
import {
  type EmailOtpPort,
  HostedLLMError,
  type HostedNotificationPort,
  PlanVersionSchema,
  type PlatformRepositoryRegistry,
  type ToolContext,
} from '@luoome/core';
import { createDrizzlePublicMarketStore } from '@luoome/db';
import { z } from 'zod';
import type { HostedProviders } from './hosted-composition.js';
import type { HostedConfig } from './hosted-config.js';
import { prepareHostedDataRoot } from './hosted-runtime.js';

type Environment = Readonly<Record<string, string | undefined>>;

const readConfigurationFile = (path: string, maxBytes: number): string => {
  if (!isAbsolute(path)) throw new Error('service configuration paths must be absolute');
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error('invalid service configuration file');
  return readFileSync(path, 'utf8');
};

const smtpOptionsFromEnv = (env: Environment): SmtpEmailOtpOptions | undefined => {
  if (!env.SMTP_HOST) {
    if (env.SMTP_FROM || env.SMTP_USER || env.SMTP_PASSWORD || env.SMTP_PASSWORD_FILE)
      throw new Error('SMTP_HOST is required when configuring email delivery');
    return undefined;
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
  return {
    host: env.SMTP_HOST,
    port,
    secure,
    starttls: !secure,
    from: env.SMTP_FROM ?? '',
    ...(user === undefined || pass === undefined ? {} : { auth: { user, pass } }),
  };
};

export const createEmailOtpFromEnv = (
  env: Environment,
  dependencies: { readonly transport?: SmtpEmailTransport } = {},
): EmailOtpPort => {
  const options = smtpOptionsFromEnv(env);
  return options === undefined
    ? new UnconfiguredEmailOtpAdapter()
    : new SmtpEmailOtpAdapter(options, dependencies);
};

export const createHostedNotificationFromEnv = (
  config: Pick<HostedConfig, 'publicOrigin' | 'allowInsecureHttp'>,
  env: Environment,
  dependencies: { readonly transport?: SmtpEmailTransport } = {},
): HostedNotificationPort => {
  const provider = z
    .enum(['disabled', 'smtp'])
    .safeParse(env.HOSTED_NOTIFICATION_PROVIDER ?? 'disabled');
  if (!provider.success) throw new Error('HOSTED_NOTIFICATION_PROVIDER must be disabled or smtp');
  if (provider.data === 'disabled') return new UnconfiguredHostedNotificationAdapter();
  const smtp = smtpOptionsFromEnv(env);
  if (smtp === undefined) throw new Error('SMTP_HOST is required for hosted SMTP notifications');
  return new SmtpHostedNotificationAdapter(
    { ...smtp, publicOrigin: config.publicOrigin, allowInsecureHttp: config.allowInsecureHttp },
    dependencies,
  );
};

export const createHostedProviders = (
  config: HostedConfig,
  env: Environment = process.env,
  options: { readonly fetchImpl?: typeof fetch; readonly smtpTransport?: SmtpEmailTransport } = {},
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
  const smtpDependencies =
    options.smtpTransport === undefined ? {} : { transport: options.smtpTransport };
  const emailOtp = createEmailOtpFromEnv(env, smtpDependencies);
  const notification = createHostedNotificationFromEnv(config, env, smtpDependencies);
  if (config.registrationEnabled && !emailOtp.configured)
    throw new Error('registration requires a configured SMTP provider');
  const aiEnabled = z.enum(['true', 'false']).parse(env.HOSTED_AI_ENABLED ?? 'false') === 'true';
  if (aiEnabled && (!env.LUOOME_AI_CONFIG || !isAbsolute(env.LUOOME_AI_CONFIG)))
    throw new Error('AI requires an explicit absolute LUOOME_AI_CONFIG');
  let ledger: PlatformRepositoryRegistry['llm'] | undefined;
  const callBudget = z.coerce
    .number()
    .int()
    .positive()
    .safe()
    .parse(env.HOSTED_LLM_CALL_BUDGET_MICRO ?? '1000000');
  const periodBudget = z.coerce
    .number()
    .int()
    .positive()
    .safe()
    .parse(env.HOSTED_LLM_PERIOD_BUDGET_MICRO ?? '20000000');
  if (callBudget > periodBudget) throw new Error('LLM call budget exceeds period budget');
  if (aiEnabled) {
    const catalog = AIModelCatalogConfigSchema.parse(
      JSON.parse(readConfigurationFile(env.LUOOME_AI_CONFIG!, 65536)),
    );
    if (
      Object.keys(catalog.providers).length !== 1 ||
      catalog.providers.deepseek?.type !== 'openai-compatible' ||
      catalog.providers.deepseek.baseURL !== 'https://api.deepseek.com' ||
      Object.values(catalog.profiles).some((profile) => profile.model !== 'deepseek:deepseek-flash')
    )
      throw new Error(
        'hosted metered AI requires deepseek:deepseek-flash at the official API endpoint',
      );
    createAIStackFromEnv(env, { logger: console, fallback: 'throw' });
  }
  const scopedAI = (base: ToolContext): Partial<ToolContext> => {
    if (!aiEnabled)
      return {
        llmExecution: {
          run: async (name, _input, context, work) => {
            if (hostedLLMToolNames.has(name)) throw new HostedLLMError('unconfigured');
            return work(context);
          },
        },
        adapters: {
          ...base.adapters,
          llm: {
            name: 'ai-unconfigured',
            generate: async () => {
              throw new HostedLLMError('unconfigured');
            },
          },
        },
      };
    if (!config.exposeWrite || !config.exposeExternal)
      return {
        adapters: {
          ...base.adapters,
          llm: {
            name: 'ai-disabled',
            generate: async () => {
              throw new HostedLLMError('operation_closed');
            },
          },
        },
      };
    if (!ledger) throw new Error('hosted LLM ledger is not bound');
    const execution = createHostedLLMExecution({
      ledger,
      budgetMicro: callBudget,
      periodBudgetMicro: periodBudget,
      timeoutMs: 60_000,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      createStack: (fetchImpl) =>
        createAIStackFromEnv(env, {
          fetchImpl,
          fallback: 'throw',
          logger: {
            debug: () => {},
            info: () => {},
            warn: (message) => base.logger.warn(message),
            error: (message) => base.logger.error(message),
          },
        }),
    });
    const agent = {
      name: 'hosted-metered:deepseek-flash',
      run: (request: Parameters<NonNullable<ToolContext['agent']>['run']>[0]) =>
        execution.run(
          'agent_run',
          { instructions: request.instructions, prompt: request.prompt },
          base,
          async (ctx) => ctx.agent!.run(request),
        ),
      createUIMessageStreamResponse: async (
        request: import('@luoome/adapters').AgentUIStreamRequest,
      ) => {
        const result = await execution.run(
          'hosted_chat_stream',
          { instructions: request.instructions, uiMessages: request.uiMessages },
          base,
          async (ctx) => {
            const runtime = ctx.agent as import('@luoome/adapters').AISDKAgentRuntime;
            const response = await runtime.createUIMessageStreamResponse(request);
            const body = await response.text();
            if (
              body
                .split('\n')
                .some((line) => line.startsWith('data: ') && line.includes('"type":"error"'))
            )
              throw new HostedLLMError('provider_failed');
            return {
              body,
              status: response.status,
              contentType: response.headers.get('content-type') ?? 'text/event-stream',
            };
          },
        );
        return new Response(result.body, {
          status: result.status,
          headers: { 'content-type': result.contentType, 'x-vercel-ai-ui-message-stream': 'v1' },
        });
      },
    };
    return {
      llmExecution: execution,
      agent,
      adapters: {
        ...base.adapters,
        llm: {
          name: 'hosted-metered:deepseek-flash',
          generate: async () => {
            throw new HostedLLMError('operation_closed');
          },
        },
      },
    };
  };
  const clock = () => new Date();
  const requestCoordinator = new MarketRequestCoordinator(
    createDrizzlePublicMarketStore(
      join(prepareHostedDataRoot(config.dataRoot), 'public-market.sqlite'),
    ),
    marketRequestConfigFromEnv(env),
  );
  const sources = {
    eastmoney: new EastmoneySource({ clock, fetchImpl: requestCoordinator.fetchFor('eastmoney') }),
  };
  const marketDeps = { clock, sources, logger: console };
  const deps = { ...marketDeps, fetchImpl: requestCoordinator.fetchFor('eastmoney') };
  const market = createMarketAdapterFromEnv(env, {
    ...marketDeps,
    requestCoordinator,
    quoteCacheTtlMs: requestCoordinator.config.cacheTtlMs,
  });
  const stockUniverse = createStockUniverseManagerFromEnv(env, deps);
  const limitUpLadder = createLimitUpLadderManagerFromEnv(env, deps);
  const dragonTiger = createDragonTigerManagerFromEnv(env, deps);
  const northboundFlow = createNorthboundFlowManagerFromEnv(env, deps);
  const news = createNewsManagerFromEnv(env, deps);
  const sectorQuote = createSectorQuoteManagerFromEnv(env, deps);
  const ashareSentiment = createAShareSentimentManagerFromEnv(env, { ...deps, market });
  return {
    bindPlatform: (repos) => {
      ledger = repos.llm;
    },
    emailOtp,
    notification,
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
    createTenantContext: (base) => {
      const aiContext = scopedAI(base);
      const { agent: _agent, llmExecution: _execution, ...context } = base;
      return {
        ...context,
        ...aiContext,
        adapters: {
          ...base.adapters,
          ...aiContext.adapters,
          market,
          stockUniverse,
        },
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
      };
    },
  };
};
