import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  type AIModelCatalogConfig,
  AIModelCatalogConfigSchema,
  DEFAULT_AI_MODEL_CATALOG_CONFIG,
  MIN_REASONING_MAX_OUTPUT_TOKENS,
  resolveAIModelCatalogPath,
} from '@luoome/adapters';
import { parseEnvFile } from '@luoome/core';
import { z } from 'zod';

const ProviderIdSchema = z.enum([
  'minimax',
  'kimi',
  'deepseek',
  'openai-compatible',
  'anthropic',
  'gateway',
]);
export type AISettingsProviderId = z.infer<typeof ProviderIdSchema>;
type AIReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max';

export interface AIProviderPreset {
  readonly id: AISettingsProviderId;
  readonly label: string;
  readonly type: 'openai-compatible' | 'anthropic' | 'gateway';
  readonly defaultModel: string;
  readonly defaultBaseURL: string;
  readonly defaultTemperature: number;
  readonly fixedTemperature?: number;
  readonly apiKeyEnv: string;
  readonly supportsStructuredOutputs: boolean;
  readonly supportsReasoningEffort: boolean;
  readonly supportedReasoningEfforts: readonly AIReasoningEffort[];
  readonly quirks: readonly ('inject-schema' | 'recover-malformed-text')[];
}

export const AI_PROVIDER_PRESETS: readonly AIProviderPreset[] = [
  {
    id: 'minimax',
    label: 'MiniMax',
    type: 'openai-compatible',
    defaultModel: 'MiniMax-M3',
    defaultBaseURL: 'https://api.minimaxi.com/v1',
    defaultTemperature: 0.2,
    apiKeyEnv: 'MINIMAX_API_KEY',
    supportsStructuredOutputs: true,
    supportsReasoningEffort: true,
    supportedReasoningEfforts: ['off', 'low', 'medium', 'high'],
    quirks: ['inject-schema', 'recover-malformed-text'],
  },
  {
    id: 'kimi',
    label: 'Kimi',
    type: 'openai-compatible',
    defaultModel: 'kimi-k3',
    defaultBaseURL: 'https://api.moonshot.cn/v1',
    defaultTemperature: 1,
    fixedTemperature: 1,
    apiKeyEnv: 'MOONSHOT_API_KEY',
    supportsStructuredOutputs: false,
    supportsReasoningEffort: true,
    supportedReasoningEfforts: ['off', 'low', 'high', 'max'],
    quirks: ['inject-schema', 'recover-malformed-text'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    type: 'openai-compatible',
    defaultModel: 'deepseek-v4-pro',
    defaultBaseURL: 'https://api.deepseek.com',
    defaultTemperature: 0.2,
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    supportsStructuredOutputs: false,
    supportsReasoningEffort: true,
    supportedReasoningEfforts: ['off', 'low', 'high', 'max'],
    quirks: ['inject-schema', 'recover-malformed-text'],
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI Compatible',
    type: 'openai-compatible',
    defaultModel: 'gpt-4o-mini',
    defaultBaseURL: 'https://api.openai.com/v1',
    defaultTemperature: 0.2,
    apiKeyEnv: 'OPENAI_API_KEY',
    supportsStructuredOutputs: true,
    supportsReasoningEffort: true,
    supportedReasoningEfforts: ['off', 'low', 'medium', 'high', 'max'],
    quirks: ['recover-malformed-text'],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    type: 'anthropic',
    defaultModel: 'claude-sonnet-4-5',
    defaultBaseURL: 'https://api.anthropic.com/v1',
    defaultTemperature: 0.2,
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    supportsStructuredOutputs: true,
    supportsReasoningEffort: false,
    supportedReasoningEfforts: ['off'],
    quirks: [],
  },
  {
    id: 'gateway',
    label: 'AI Gateway',
    type: 'gateway',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    defaultBaseURL: 'https://ai-gateway.vercel.sh/v1/ai',
    defaultTemperature: 0.2,
    apiKeyEnv: 'AI_GATEWAY_API_KEY',
    supportsStructuredOutputs: true,
    supportsReasoningEffort: false,
    supportedReasoningEfforts: ['off'],
    quirks: [],
  },
];

export const AISettingsProfileNameSchema = z.enum(['generation', 'agent']);
export type AISettingsProfileName = z.infer<typeof AISettingsProfileNameSchema>;

export const SaveAISettingsSchema = z
  .object({
    /** 缺省写入 agent profile，兼容只关心对话的旧调用方。 */
    profile: AISettingsProfileNameSchema.default('agent'),
    provider: ProviderIdSchema,
    model: z.string().trim().min(1).max(200),
    baseURL: z.url(),
    apiKey: z
      .string()
      .max(1_000)
      .refine((value) => !/[\r\n]/.test(value), 'API key 不能包含换行')
      .optional(),
    clearApiKey: z.boolean().default(false),
    temperature: z.number().min(0).max(2),
    timeoutSeconds: z.number().int().min(1).max(600),
    maxRetries: z.number().int().min(0).max(5),
    reasoningEffort: z.enum(['off', 'low', 'medium', 'high', 'max']),
    /** 单次输出预算；不传时保留该 profile 已有值，新建时使用安全下限。 */
    maxOutputTokens: z.number().int().min(256).max(200_000).optional(),
  })
  .superRefine((value, ctx) => {
    const preset = AI_PROVIDER_PRESETS.find(({ id }) => id === value.provider);
    if (preset !== undefined && !preset.supportedReasoningEfforts.includes(value.reasoningEffort)) {
      ctx.addIssue({
        code: 'custom',
        path: ['reasoningEffort'],
        message: `${preset.label} 不支持推理强度 ${value.reasoningEffort}`,
      });
    }
    if (preset?.fixedTemperature !== undefined && value.temperature !== preset.fixedTemperature) {
      ctx.addIssue({
        code: 'custom',
        path: ['temperature'],
        message: `${preset.label} 的 temperature 必须为 ${preset.fixedTemperature}`,
      });
    }
  });

export type SaveAISettings = z.infer<typeof SaveAISettingsSchema>;

export interface AISettingsProfileView {
  readonly profile: AISettingsProfileName;
  readonly provider: AISettingsProviderId;
  readonly model: string;
  readonly baseURL: string;
  /** 当前 profile 实际使用的 provider 密钥变量名（自定义 provider 不比 preset 更好猜）。 */
  readonly apiKeyEnv: string;
  readonly apiKeyConfigured: boolean;
  readonly temperature: number;
  /** 单次输出预算；running runtime 按此值构造供应商 max_tokens。 */
  readonly maxOutputTokens: number;
  readonly timeoutSeconds: number;
  readonly maxRetries: number;
  readonly reasoningEffort: AIReasoningEffort;
}

export interface AISettingsView extends AISettingsProfileView {
  /** 两个 profile 可独立配置；顶层字段镜像 agent profile，供旧调用方与聊天运行时读取。 */
  readonly profiles: Record<AISettingsProfileName, AISettingsProfileView>;
  readonly configPath: string;
  readonly secretPath: string;
  readonly providers: readonly AIProviderPreset[];
  readonly configError?: string;
}

const presetById = (id: AISettingsProviderId): AIProviderPreset => {
  const preset = AI_PROVIDER_PRESETS.find((candidate) => candidate.id === id);
  if (preset === undefined) throw new Error(`未知 AI provider: ${id}`);
  return preset;
};

const atomicWrite = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
};

const updateEnvContent = (content: string, key: string, value: string | null): string => {
  const pattern = new RegExp(`^(?:export\\s+)?${key}\\s*=`);
  const lines = content.split('\n').filter((line) => !pattern.test(line.trim()));
  while (lines.at(-1) === '') lines.pop();
  if (value !== null) lines.push(`${key}=${value}`);
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
};

const readText = (path: string): string => {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
};

const inferProviderId = (
  providerName: string,
  provider: AIModelCatalogConfig['providers'][string],
): AISettingsProviderId => {
  if (providerName === 'minimax') return 'minimax';
  if (providerName === 'kimi') return 'kimi';
  if (providerName === 'deepseek') return 'deepseek';
  if (provider.type === 'anthropic') return 'anthropic';
  if (provider.type === 'gateway') return 'gateway';
  return 'openai-compatible';
};

export class AISettingsStore {
  readonly configPath: string;
  readonly secretPath: string;
  private readonly sessionEnv: Record<string, string | undefined> = {};

  constructor(
    private readonly baseEnv: Readonly<Record<string, string | undefined>>,
    paths: { readonly configPath?: string; readonly secretPath?: string } = {},
  ) {
    const home = baseEnv.LUOOME_HOME?.trim() || join(homedir(), '.luoome');
    this.configPath = paths.configPath ?? resolveAIModelCatalogPath(baseEnv);
    this.secretPath = paths.secretPath ?? join(home, '.env');
  }

  runtimeEnv(): Record<string, string | undefined> {
    return {
      ...parseEnvFile(readText(this.secretPath)),
      ...this.baseEnv,
      ...this.sessionEnv,
      LUOOME_AI_CONFIG: this.configPath,
    };
  }

  private readConfig(): { config?: AIModelCatalogConfig; error?: string } {
    const content = readText(this.configPath);
    if (content === '') return {};
    try {
      return { config: AIModelCatalogConfigSchema.parse(JSON.parse(content)) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  private profileView(
    name: AISettingsProfileName,
    config: AIModelCatalogConfig | undefined,
    env: Readonly<Record<string, string | undefined>>,
  ): AISettingsProfileView {
    const fallback = presetById('minimax');
    const fallbackTimeoutSeconds = name === 'agent' ? 120 : 30;
    const profile = config?.profiles[name];
    const separator = profile?.model.indexOf(':') ?? -1;
    const providerName = separator <= 0 ? '' : (profile?.model.slice(0, separator) ?? '');
    const provider = providerName === '' ? undefined : config?.providers[providerName];
    if (profile === undefined || provider === undefined) {
      return {
        profile: name,
        provider: fallback.id,
        model: fallback.defaultModel,
        baseURL: fallback.defaultBaseURL,
        apiKeyEnv: fallback.apiKeyEnv,
        apiKeyConfigured: false,
        temperature: fallback.defaultTemperature,
        maxOutputTokens: 2_048,
        timeoutSeconds: fallbackTimeoutSeconds,
        maxRetries: 0,
        reasoningEffort: 'off',
      };
    }
    const providerId = inferProviderId(providerName, provider);
    return {
      profile: name,
      provider: providerId,
      model: profile.model.slice(separator + 1),
      baseURL: provider.baseURL ?? presetById(providerId).defaultBaseURL,
      apiKeyEnv: provider.apiKeyEnv,
      apiKeyConfigured: (env[provider.apiKeyEnv]?.trim().length ?? 0) > 0,
      temperature: profile.temperature,
      maxOutputTokens:
        profile.reasoningEffort === 'off'
          ? profile.maxOutputTokens
          : Math.max(profile.maxOutputTokens, MIN_REASONING_MAX_OUTPUT_TOKENS),
      timeoutSeconds: Math.round(profile.timeoutMs / 1_000),
      maxRetries: profile.maxRetries,
      reasoningEffort: profile.reasoningEffort,
    };
  }

  read(): AISettingsView {
    const { config, error } = this.readConfig();
    const env = this.runtimeEnv();
    const profiles = {
      generation: this.profileView('generation', config, env),
      agent: this.profileView('agent', config, env),
    };
    return {
      ...profiles.agent,
      profiles,
      configPath: this.configPath,
      secretPath: this.secretPath,
      providers: AI_PROVIDER_PRESETS,
      ...(error === undefined ? {} : { configError: error }),
    };
  }

  save(input: SaveAISettings): AISettingsView {
    const settings = SaveAISettingsSchema.parse(input);
    const preset = presetById(settings.provider);
    const { config: existing } = this.readConfig();
    const base = existing ?? DEFAULT_AI_MODEL_CATALOG_CONFIG;
    const previous = base.profiles[settings.profile];
    const provider = {
      type: preset.type,
      baseURL: settings.baseURL,
      apiKeyEnv: preset.apiKeyEnv,
      ...(preset.type === 'openai-compatible'
        ? { supportsStructuredOutputs: preset.supportsStructuredOutputs }
        : {}),
      ...(preset.quirks.length === 0 ? {} : { quirks: preset.quirks }),
    };
    const reasoningFloor = settings.reasoningEffort === 'off' ? 0 : MIN_REASONING_MAX_OUTPUT_TOKENS;
    const nextProfile = {
      ...previous,
      model: `${preset.id}:${settings.model}`,
      temperature: settings.temperature,
      maxOutputTokens: Math.max(
        settings.maxOutputTokens ?? previous.maxOutputTokens,
        reasoningFloor,
      ),
      timeoutMs: settings.timeoutSeconds * 1_000,
      maxRetries: settings.maxRetries,
      reasoningEffort: settings.reasoningEffort,
    };
    // 只更新当前 profile 与它的 provider；另一个 profile、自定义 provider 和其他字段原样保留。
    const config = AIModelCatalogConfigSchema.parse({
      ...base,
      providers: { ...base.providers, [preset.id]: provider },
      profiles: { ...base.profiles, [settings.profile]: nextProfile },
    });
    atomicWrite(this.configPath, `${JSON.stringify(config, null, 2)}\n`);

    if (settings.apiKey !== undefined && settings.apiKey.trim().length > 0) {
      this.sessionEnv[preset.apiKeyEnv] = settings.apiKey.trim();
      atomicWrite(
        this.secretPath,
        updateEnvContent(readText(this.secretPath), preset.apiKeyEnv, settings.apiKey.trim()),
      );
    } else if (settings.clearApiKey) {
      this.sessionEnv[preset.apiKeyEnv] = undefined;
      atomicWrite(
        this.secretPath,
        updateEnvContent(readText(this.secretPath), preset.apiKeyEnv, null),
      );
    }
    return this.read();
  }
}
