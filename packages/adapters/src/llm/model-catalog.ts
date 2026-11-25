import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import {
  createGateway,
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

/**
 * 推理 token 计入 max_tokens，低于该值时供应商会在推理阶段耗尽输出预算并返回空回答。
 * 仅约束 reasoningEffort!=off 的 profile；显式配置更高时保留原值。
 */
export const MIN_REASONING_MAX_OUTPUT_TOKENS = 8_192;

const effectiveMaxOutputTokens = (profile: {
  readonly reasoningEffort: 'off' | 'low' | 'medium' | 'high' | 'max';
  readonly maxOutputTokens: number;
}): number =>
  profile.reasoningEffort === 'off'
    ? profile.maxOutputTokens
    : Math.max(profile.maxOutputTokens, MIN_REASONING_MAX_OUTPUT_TOKENS);

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
  /** 单次模型请求预算；聊天运行时会另按步数派生整轮预算。 */
  timeoutMs: positiveInt.default(30_000),
  maxRetries: z.number().int().min(0).max(5).default(0),
  reasoningEffort: z.enum(['off', 'low', 'medium', 'high', 'max']).default('off'),
  maxPromptChars: positiveInt.default(16_000),
  /** 请求前投影后的对话上下文预算（字符，含历史 Tool 输出）。 */
  maxContextChars: positiveInt.default(48_000),
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
      maxTotalTokens: positiveInt.default(120_000),
    }),
  }),
});

export const DEFAULT_AI_MODEL_CATALOG_CONFIG = AIModelCatalogConfigSchema.parse({
  version: 1,
  providers: {
    minimax: {
      type: 'openai-compatible',
      baseURL: 'https://api.minimaxi.com/v1',
      apiKeyEnv: 'MINIMAX_API_KEY',
      supportsStructuredOutputs: true,
      quirks: ['inject-schema', 'recover-malformed-text'],
    },
    anthropic: {
      type: 'anthropic',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
    },
    gateway: {
      type: 'gateway',
      apiKeyEnv: 'AI_GATEWAY_API_KEY',
    },
    kimi: {
      type: 'openai-compatible',
      baseURL: 'https://api.moonshot.cn/v1',
      apiKeyEnv: 'MOONSHOT_API_KEY',
      supportsStructuredOutputs: false,
      quirks: ['inject-schema', 'recover-malformed-text'],
    },
    deepseek: {
      type: 'openai-compatible',
      baseURL: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      supportsStructuredOutputs: false,
      quirks: ['inject-schema', 'recover-malformed-text'],
    },
  },
  profiles: {
    generation: {
      model: 'minimax:MiniMax-M3',
      temperature: 0.2,
      maxOutputTokens: 2_048,
      timeoutMs: 30_000,
      maxRetries: 0,
      reasoningEffort: 'off',
      maxPromptChars: 16_000,
      maxContextChars: 48_000,
      maxSteps: 8,
      maxTotalTokens: 30_000,
    },
    agent: {
      model: 'minimax:MiniMax-M3',
      temperature: 0.2,
      maxOutputTokens: 2_048,
      timeoutMs: 120_000,
      maxRetries: 0,
      reasoningEffort: 'off',
      maxPromptChars: 16_000,
      maxContextChars: 48_000,
      maxSteps: 8,
      maxTotalTokens: 120_000,
    },
  },
});

export type AIModelCatalogConfig = z.infer<typeof AIModelCatalogConfigSchema>;
export type AIModelProfileName = keyof AIModelCatalogConfig['profiles'];

export interface ResolvedAIModelProfile {
  readonly name: AIModelProfileName;
  readonly modelRef: string;
  readonly providerName: string;
  readonly providerType: AIModelCatalogConfig['providers'][string]['type'];
  readonly supportsStructuredOutputs: boolean;
  readonly model: LanguageModel;
  readonly quirks: ProviderQuirks;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly maxRetries: number;
  readonly reasoningEffort: AIModelCatalogConfig['profiles']['generation']['reasoningEffort'];
  readonly maxPromptChars: number;
  readonly maxContextChars: number;
  readonly maxSteps: number;
  readonly maxTotalTokens: number;
}

interface LanguageModelProvider {
  languageModel(id: string): LanguageModelV3;
}

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
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly options: { readonly fetchImpl?: typeof fetch };
  private readonly providers = new Map<string, LanguageModelProvider>();
  private readonly profiles = new Map<AIModelProfileName, ResolvedAIModelProfile>();

  constructor(
    input: unknown,
    env: Readonly<Record<string, string | undefined>>,
    options: { readonly fetchImpl?: typeof fetch } = {},
  ) {
    this.config = AIModelCatalogConfigSchema.parse(input);
    this.env = env;
    this.options = options;
  }

  /**
   * provider 按 profile 惰性构造：只要求当前使用 profile 的密钥，
   * 生成与对话 Agent 可以各自缺省而互不阻塞。
   */
  private providerOf(name: string, config: AIModelCatalogConfig['providers'][string]) {
    const cached = this.providers.get(name);
    if (cached !== undefined) return cached;
    const apiKey = resolveApiKey(name, config.apiKeyEnv, this.env);
    const fetchOption =
      this.options.fetchImpl === undefined ? {} : { fetch: this.options.fetchImpl };
    let provider: LanguageModelProvider;
    if (config.type === 'anthropic') {
      provider = createAnthropic({
        apiKey,
        ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
        ...fetchOption,
      });
    } else if (config.type === 'gateway') {
      provider = createGateway({
        apiKey,
        ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
        ...fetchOption,
      });
    } else {
      if (config.baseURL === undefined) {
        throw new Error(`openai-compatible provider "${name}" 必须配置 baseURL`);
      }
      provider = createOpenAICompatible({
        name,
        apiKey,
        baseURL: config.baseURL,
        supportsStructuredOutputs: config.supportsStructuredOutputs,
        ...fetchOption,
      });
    }
    this.providers.set(name, provider);
    return provider;
  }

  resolve(name: AIModelProfileName): ResolvedAIModelProfile {
    const cached = this.profiles.get(name);
    if (cached !== undefined) return cached;
    const profile = this.config.profiles[name];
    const providerNameValue = profile.model.slice(0, profile.model.indexOf(':'));
    const provider = this.config.providers[providerNameValue];
    if (provider === undefined) {
      throw new Error(`AI profile "${name}" 引用了未注册 provider "${providerNameValue}"`);
    }
    const registry = this.providerOf(providerNameValue, provider);
    const model = wrapLanguageModel({
      model: registry.languageModel(profile.model.slice(profile.model.indexOf(':') + 1)),
      middleware: defaultSettingsMiddleware({
        settings: {
          temperature: profile.temperature,
          maxOutputTokens: effectiveMaxOutputTokens(profile),
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
    const resolved: ResolvedAIModelProfile = {
      name,
      modelRef: profile.model,
      providerName: providerNameValue,
      providerType: provider.type,
      supportsStructuredOutputs:
        provider.type === 'openai-compatible' ? provider.supportsStructuredOutputs : true,
      model,
      quirks: toQuirks(provider.quirks),
      timeoutMs: profile.timeoutMs,
      maxOutputTokens: effectiveMaxOutputTokens(profile),
      maxRetries: profile.maxRetries,
      reasoningEffort: profile.reasoningEffort,
      maxPromptChars: profile.maxPromptChars,
      maxContextChars: profile.maxContextChars,
      maxSteps: profile.maxSteps,
      maxTotalTokens: profile.maxTotalTokens,
    };
    this.profiles.set(name, resolved);
    return resolved;
  }
}

export const resolveAIModelCatalogPath = (
  env: Readonly<Record<string, string | undefined>>,
): string => {
  const explicit = env.LUOOME_AI_CONFIG?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return join(env.LUOOME_HOME?.trim() || join(homedir(), '.luoome'), 'ai-models.json');
};

const isFileSystemError = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;

const createDefaultAIModelCatalog = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, `${JSON.stringify(DEFAULT_AI_MODEL_CATALOG_CONFIG, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (!isFileSystemError(error, 'EEXIST')) throw error;
  }
};

export const loadAIModelCatalog = (
  env: Readonly<Record<string, string | undefined>>,
  options: {
    readonly fetchImpl?: typeof fetch;
    readonly readFile?: (path: string) => string;
  } = {},
): AIModelCatalog => {
  const path = resolveAIModelCatalogPath(env);
  const readFile = options.readFile ?? ((target: string) => readFileSync(target, 'utf8'));
  let content: string;
  try {
    content = readFile(path);
  } catch (error) {
    const usesExplicitPath = (env.LUOOME_AI_CONFIG?.trim().length ?? 0) > 0;
    if (usesExplicitPath || !isFileSystemError(error, 'ENOENT')) {
      throw new Error(`无法读取 AI 模型目录 ${path}`, { cause: error });
    }
    try {
      createDefaultAIModelCatalog(path);
      content = readFile(path);
    } catch (createError) {
      throw new Error(`无法生成默认 AI 模型目录 ${path}`, { cause: createError });
    }
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
