import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  type AIModelCatalogConfig,
  AIModelCatalogConfigSchema,
  resolveAIModelCatalogPath,
} from '@luoome/adapters';
import { parseEnvFile } from '@luoome/core';
import { z } from 'zod';

const ProviderIdSchema = z.enum(['minimax', 'openai-compatible', 'anthropic', 'gateway']);
export type AISettingsProviderId = z.infer<typeof ProviderIdSchema>;

export interface AIProviderPreset {
  readonly id: AISettingsProviderId;
  readonly label: string;
  readonly type: 'openai-compatible' | 'anthropic' | 'gateway';
  readonly defaultModel: string;
  readonly defaultBaseURL: string;
  readonly apiKeyEnv: string;
  readonly supportsReasoningEffort: boolean;
  readonly quirks: readonly ('inject-schema' | 'recover-malformed-text')[];
}

export const AI_PROVIDER_PRESETS: readonly AIProviderPreset[] = [
  {
    id: 'minimax',
    label: 'MiniMax',
    type: 'openai-compatible',
    defaultModel: 'MiniMax-M3',
    defaultBaseURL: 'https://api.minimaxi.com/v1',
    apiKeyEnv: 'MINIMAX_API_KEY',
    supportsReasoningEffort: true,
    quirks: ['inject-schema', 'recover-malformed-text'],
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI Compatible',
    type: 'openai-compatible',
    defaultModel: 'gpt-4o-mini',
    defaultBaseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    supportsReasoningEffort: true,
    quirks: ['recover-malformed-text'],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    type: 'anthropic',
    defaultModel: 'claude-sonnet-4-5',
    defaultBaseURL: 'https://api.anthropic.com/v1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    supportsReasoningEffort: false,
    quirks: [],
  },
  {
    id: 'gateway',
    label: 'AI Gateway',
    type: 'gateway',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    defaultBaseURL: 'https://ai-gateway.vercel.sh/v1/ai',
    apiKeyEnv: 'AI_GATEWAY_API_KEY',
    supportsReasoningEffort: false,
    quirks: [],
  },
];

export const SaveAISettingsSchema = z
  .object({
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
    reasoningEffort: z.enum(['off', 'low', 'medium', 'high']),
  })
  .superRefine((value, ctx) => {
    const preset = AI_PROVIDER_PRESETS.find(({ id }) => id === value.provider);
    if (preset?.supportsReasoningEffort === false && value.reasoningEffort !== 'off') {
      ctx.addIssue({
        code: 'custom',
        path: ['reasoningEffort'],
        message: `${preset.label} 当前不支持统一推理强度参数`,
      });
    }
  });

export type SaveAISettings = z.infer<typeof SaveAISettingsSchema>;

export interface AISettingsView {
  readonly provider: AISettingsProviderId;
  readonly model: string;
  readonly baseURL: string;
  readonly apiKeyConfigured: boolean;
  readonly temperature: number;
  readonly timeoutSeconds: number;
  readonly maxRetries: number;
  readonly reasoningEffort: 'off' | 'low' | 'medium' | 'high';
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

  read(): AISettingsView {
    const fallback = presetById('minimax');
    let providerId: AISettingsProviderId = fallback.id;
    let model = fallback.defaultModel;
    let baseURL = fallback.defaultBaseURL;
    let temperature = 0.2;
    let timeoutSeconds = 120;
    let maxRetries = 0;
    let reasoningEffort: AISettingsView['reasoningEffort'] = 'off';
    let apiKeyEnv = fallback.apiKeyEnv;
    let configError: string | undefined;

    const content = readText(this.configPath);
    if (content !== '') {
      try {
        const config = AIModelCatalogConfigSchema.parse(JSON.parse(content));
        const profile = config.profiles.agent;
        const separator = profile.model.indexOf(':');
        const providerName = profile.model.slice(0, separator);
        const provider = config.providers[providerName];
        if (provider !== undefined) {
          providerId = inferProviderId(providerName, provider);
          model = profile.model.slice(separator + 1);
          baseURL = provider.baseURL ?? presetById(providerId).defaultBaseURL;
          temperature = profile.temperature;
          timeoutSeconds = Math.round(profile.timeoutMs / 1_000);
          maxRetries = profile.maxRetries;
          reasoningEffort = profile.reasoningEffort;
          apiKeyEnv = provider.apiKeyEnv;
        }
      } catch (error) {
        configError = error instanceof Error ? error.message : String(error);
      }
    }

    const env = this.runtimeEnv();
    return {
      provider: providerId,
      model,
      baseURL,
      apiKeyConfigured: (env[apiKeyEnv]?.trim().length ?? 0) > 0,
      temperature,
      timeoutSeconds,
      maxRetries,
      reasoningEffort,
      configPath: this.configPath,
      secretPath: this.secretPath,
      providers: AI_PROVIDER_PRESETS,
      ...(configError === undefined ? {} : { configError }),
    };
  }

  save(input: SaveAISettings): AISettingsView {
    const settings = SaveAISettingsSchema.parse(input);
    const preset = presetById(settings.provider);
    const provider = {
      type: preset.type,
      baseURL: settings.baseURL,
      apiKeyEnv: preset.apiKeyEnv,
      ...(preset.type === 'openai-compatible' ? { supportsStructuredOutputs: true } : {}),
      ...(preset.quirks.length === 0 ? {} : { quirks: preset.quirks }),
    };
    const commonProfile = {
      model: `${preset.id}:${settings.model}`,
      temperature: settings.temperature,
      maxOutputTokens: 2_048,
      maxRetries: settings.maxRetries,
      reasoningEffort: settings.reasoningEffort,
    };
    const config = AIModelCatalogConfigSchema.parse({
      version: 1,
      providers: { [preset.id]: provider },
      profiles: {
        generation: {
          ...commonProfile,
          timeoutMs: settings.timeoutSeconds * 1_000,
          maxPromptChars: 16_000,
        },
        agent: {
          ...commonProfile,
          timeoutMs: settings.timeoutSeconds * 1_000,
          maxSteps: 8,
          maxTotalTokens: 30_000,
        },
      },
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
