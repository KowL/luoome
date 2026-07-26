import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import {
  createGateway,
  createProviderRegistry,
  defaultSettingsMiddleware,
  type LanguageModel,
  wrapLanguageModel,
} from 'ai';
import { z } from 'zod';
import type { ProviderQuirks } from './provider-quirks.js';

const providerName = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-zA-Z0-9_-]+$/);
const positiveInt = z.number().int().positive();

const providerBase = z.object({
  apiKeyEnv: z
    .string()
    .trim()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'apiKeyEnv 必须是合法环境变量名'),
  baseURL: z.url().optional(),
  quirks: z.array(z.enum(['inject-schema', 'recover-malformed-text'])).default([]),
});

const ProviderConfigSchema = z.discriminatedUnion('type', [
  providerBase.extend({
    type: z.literal('anthropic'),
  }),
  providerBase.extend({
    type: z.literal('openai-compatible'),
    supportsStructuredOutputs: z.boolean().default(true),
  }),
  providerBase.extend({
    type: z.literal('gateway'),
  }),
]);

const ProfileConfigSchema = z.object({
  model: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_-]+:.+$/, 'model 必须使用 provider:model 格式'),
  temperature: z.number().min(0).max(2).default(0.2),
  maxOutputTokens: positiveInt.default(2_048),
  timeoutMs: positiveInt.default(30_000),
  maxRetries: z.number().int().min(0).max(5).default(0),
  reasoningEffort: z.enum(['off', 'low', 'medium', 'high']).default('off'),
  maxPromptChars: positiveInt.default(16_000),
  maxSteps: positiveInt.default(8),
  maxTotalTokens: positiveInt.default(30_000),
});

export const AIModelCatalogConfigSchema = z.object({
  version: z.literal(1),
  providers: z.record(providerName, ProviderConfigSchema),
  profiles: z.object({
    generation: ProfileConfigSchema,
    agent: ProfileConfigSchema.extend({
      timeoutMs: positiveInt.default(120_000),
    }),
  }),
});

export type AIModelCatalogConfig = z.infer<typeof AIModelCatalogConfigSchema>;
export type AIModelProfileName = keyof AIModelCatalogConfig['profiles'];

export interface ResolvedAIModelProfile {
  readonly name: AIModelProfileName;
  readonly modelRef: string;
  readonly providerName: string;
  readonly providerType: AIModelCatalogConfig['providers'][string]['type'];
  readonly model: LanguageModel;
  readonly quirks: ProviderQuirks;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly reasoningEffort: AIModelCatalogConfig['profiles']['generation']['reasoningEffort'];
  readonly maxPromptChars: number;
  readonly maxSteps: number;
  readonly maxTotalTokens: number;
}

type RegistryProviders = Parameters<typeof createProviderRegistry>[0];

const resolveApiKey = (
  providerNameValue: string,
  apiKeyEnv: string,
  env: Readonly<Record<string, string | undefined>>,
): string => {
  const apiKey = env[apiKeyEnv]?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(`AI provider "${providerNameValue}" 缺少密钥环境变量 ${apiKeyEnv}`);
  }
  return apiKey;
};

const toQuirks = (
  values: readonly ('inject-schema' | 'recover-malformed-text')[],
): ProviderQuirks => ({
  injectSchemaIntoSystem: values.includes('inject-schema'),
  recoverMalformedText: values.includes('recover-malformed-text'),
});

export class AIModelCatalog {
  private readonly config: AIModelCatalogConfig;
  private readonly registry: { languageModel(id: string): LanguageModelV3 };

  constructor(
    input: unknown,
    env: Readonly<Record<string, string | undefined>>,
    options: { readonly fetchImpl?: typeof fetch } = {},
  ) {
    this.config = AIModelCatalogConfigSchema.parse(input);
    const providers: RegistryProviders = {};
    const activeProviders = new Set(
      Object.values(this.config.profiles).map(({ model }) => model.slice(0, model.indexOf(':'))),
    );
    for (const [name, config] of Object.entries(this.config.providers)) {
      if (!activeProviders.has(name)) continue;
      const apiKey = resolveApiKey(name, config.apiKeyEnv, env);
      if (config.type === 'anthropic') {
        providers[name] = createAnthropic({
          apiKey,
          ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
          ...(options.fetchImpl === undefined ? {} : { fetch: options.fetchImpl }),
        });
      } else if (config.type === 'gateway') {
        providers[name] = createGateway({
          apiKey,
          ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
          ...(options.fetchImpl === undefined ? {} : { fetch: options.fetchImpl }),
        });
      } else {
        if (config.baseURL === undefined) {
          throw new Error(`openai-compatible provider "${name}" 必须配置 baseURL`);
        }
        providers[name] = createOpenAICompatible({
          name,
          apiKey,
          baseURL: config.baseURL,
          supportsStructuredOutputs: config.supportsStructuredOutputs,
          ...(options.fetchImpl === undefined ? {} : { fetch: options.fetchImpl }),
        });
      }
    }
    this.registry = createProviderRegistry(providers) as {
      languageModel(id: string): LanguageModelV3;
    };
  }

  resolve(name: AIModelProfileName): ResolvedAIModelProfile {
    const profile = this.config.profiles[name];
    const providerNameValue = profile.model.slice(0, profile.model.indexOf(':'));
    const provider = this.config.providers[providerNameValue];
    if (provider === undefined) {
      throw new Error(`AI profile "${name}" 引用了未注册 provider "${providerNameValue}"`);
    }
    const model = wrapLanguageModel({
      model: this.registry.languageModel(profile.model),
      middleware: defaultSettingsMiddleware({
        settings: {
          temperature: profile.temperature,
          maxOutputTokens: profile.maxOutputTokens,
          ...(provider.type === 'openai-compatible' && profile.reasoningEffort !== 'off'
            ? {
                providerOptions: {
                  [providerNameValue]: { reasoningEffort: profile.reasoningEffort },
                },
              }
            : {}),
        },
      }),
    });
    return {
      name,
      modelRef: profile.model,
      providerName: providerNameValue,
      providerType: provider.type,
      model,
      quirks: toQuirks(provider.quirks),
      timeoutMs: profile.timeoutMs,
      maxRetries: profile.maxRetries,
      reasoningEffort: profile.reasoningEffort,
      maxPromptChars: profile.maxPromptChars,
      maxSteps: profile.maxSteps,
      maxTotalTokens: profile.maxTotalTokens,
    };
  }
}

export const resolveAIModelCatalogPath = (
  env: Readonly<Record<string, string | undefined>>,
): string => {
  const explicit = env.LUOOME_AI_CONFIG?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return join(env.LUOOME_HOME?.trim() || join(homedir(), '.luoome'), 'ai-models.json');
};

export const loadAIModelCatalog = (
  env: Readonly<Record<string, string | undefined>>,
  options: {
    readonly fetchImpl?: typeof fetch;
    readonly readFile?: (path: string) => string;
  } = {},
): AIModelCatalog => {
  const path = resolveAIModelCatalogPath(env);
  let content: string;
  try {
    content = (options.readFile ?? ((target) => readFileSync(target, 'utf8')))(path);
  } catch (error) {
    throw new Error(`无法读取 AI 模型目录 ${path}`, { cause: error });
  }
  let input: unknown;
  try {
    input = JSON.parse(content);
  } catch (error) {
    throw new Error(`AI 模型目录 ${path} 不是合法 JSON`, { cause: error });
  }
  return new AIModelCatalog(input, env, {
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
};
