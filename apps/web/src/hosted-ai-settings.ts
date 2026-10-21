import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AIModelCatalogConfigSchema, hostedDeepSeekPricing } from '@luoome/adapters';
import type { HostedLLMPricing } from '@luoome/core';
import { z } from 'zod';

const rate = z.number().finite().min(0).max(100_000);
const SettingsSchema = z
  .object({
    enabled: z.boolean(),
    provider: z.enum(['deepseek', 'kimi', 'openai-compatible']),
    model: z.string().trim().min(1).max(200),
    baseURL: z.url().refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      );
    }, '供应商地址必须为不含凭据或查询参数的 HTTPS 地址'),
    temperature: z.number().min(0).max(2),
    reasoningEffort: z.enum(['off', 'low', 'medium', 'high', 'max']),
    timeoutSeconds: z.number().int().min(10).max(300),
    maxOutputTokens: z.number().int().min(256).max(32768),
    inputPrice: rate,
    cachedInputPrice: rate,
    outputPrice: rate,
    callBudget: z.number().positive().max(1000),
    periodBudget: z.number().positive().max(10000),
  })
  .strict()
  .refine((value) => value.callBudget <= value.periodBudget, '单次预算不能大于周期预算')
  .refine((value) => value.cachedInputPrice <= value.inputPrice, '缓存输入费率不能大于输入费率')
  .refine(
    (value) => !value.enabled || (value.inputPrice > 0 && value.outputPrice > 0),
    '启用前请填写输入和输出费率',
  );
const ApiKeySchema = z
  .string()
  .trim()
  .max(1000)
  .refine((value) => !/[\r\n]/.test(value));
export const SaveHostedAISettingsSchema = z
  .object({
    settings: SettingsSchema,
    apiKey: ApiKeySchema.optional(),
    clearApiKey: z.boolean().default(false),
  })
  .strict();
const StoredSchema = z
  .object({ version: z.literal(1), settings: SettingsSchema, apiKey: ApiKeySchema })
  .strict();
type Settings = z.infer<typeof SettingsSchema>;

const defaults: Settings = {
  enabled: false,
  provider: 'deepseek',
  model: 'deepseek-flash',
  baseURL: 'https://api.deepseek.com',
  temperature: 0.2,
  reasoningEffort: 'off',
  timeoutSeconds: 60,
  maxOutputTokens: 2048,
  inputPrice: 2,
  cachedInputPrice: 0.04,
  outputPrice: 8,
  callBudget: 1,
  periodBudget: 20,
};

export class HostedAISettingsStore {
  private readonly path: string;
  constructor(
    private readonly dataRoot: string,
    private readonly env: Readonly<Record<string, string | undefined>>,
  ) {
    this.path = join(dataRoot, 'operator', 'ai-settings.json');
  }

  private stored() {
    if (!existsSync(this.path)) return undefined;
    return StoredSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
  }

  private legacy() {
    if (this.env.HOSTED_AI_ENABLED !== 'true') return undefined;
    const path = this.env.LUOOME_AI_CONFIG;
    if (!path) throw new Error('AI model configuration unavailable');
    const catalog = AIModelCatalogConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (
      Object.keys(catalog.providers).length !== 1 ||
      catalog.providers.deepseek?.type !== 'openai-compatible' ||
      catalog.providers.deepseek.baseURL !== defaults.baseURL ||
      Object.values(catalog.profiles).some((profile) => profile.model !== 'deepseek:deepseek-flash')
    )
      throw new Error(
        'Legacy AI configuration requires deepseek:deepseek-flash; use administrator settings for other models',
      );
    const apiKey = this.env[catalog.providers.deepseek.apiKeyEnv]?.trim() ?? '';
    if (!apiKey) throw new Error('AI credential unavailable');
    return { catalog, apiKey, path };
  }

  read() {
    const stored = this.stored();
    if (stored)
      return {
        settings: stored.settings,
        apiKeyConfigured: stored.apiKey.length > 0,
        source: 'administrator' as const,
      };
    const legacy = this.legacy();
    return {
      settings: {
        ...defaults,
        enabled: legacy !== undefined,
        ...(legacy === undefined
          ? {}
          : {
              temperature: legacy.catalog.profiles.agent.temperature,
              reasoningEffort: legacy.catalog.profiles.agent.reasoningEffort,
              timeoutSeconds: legacy.catalog.profiles.agent.timeoutMs / 1000,
              maxOutputTokens: legacy.catalog.profiles.agent.maxOutputTokens,
            }),
        callBudget: Number(this.env.HOSTED_LLM_CALL_BUDGET_MICRO ?? '1000000') / 1_000_000,
        periodBudget: Number(this.env.HOSTED_LLM_PERIOD_BUDGET_MICRO ?? '20000000') / 1_000_000,
      },
      apiKeyConfigured: legacy !== undefined,
      source: 'environment' as const,
    };
  }

  save(value: unknown) {
    const input = SaveHostedAISettingsSchema.parse(value);
    const settings = {
      ...input.settings,
      baseURL: new URL(input.settings.baseURL).href.replace(/\/+$/, ''),
    };
    const previous = this.stored();
    const legacy = previous ? undefined : this.legacy();
    const previousSettings = previous?.settings ?? defaults;
    const sameProvider =
      previousSettings.provider === settings.provider &&
      previousSettings.baseURL === settings.baseURL;
    if (input.clearApiKey && input.apiKey) throw new Error('请勿同时填写和清除密钥');
    const apiKey = input.clearApiKey
      ? ''
      : input.apiKey || (sameProvider ? (previous?.apiKey ?? legacy?.apiKey ?? '') : '');
    if (settings.enabled && !apiKey) throw new Error('启用 AI 或更换供应商地址时，请填写 API 密钥');
    const payload = StoredSchema.parse({ version: 1, settings, apiKey });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(temporary, JSON.stringify(payload), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.path);
    } finally {
      rmSync(temporary, { force: true });
    }
    return this.read();
  }

  snapshot() {
    const stored = this.stored();
    if (!stored) {
      const legacy = this.legacy();
      if (!legacy) return undefined;
      return {
        catalog: legacy.catalog,
        env: { ...this.env, LUOOME_AI_CONFIG: legacy.path },
        endpoint: 'https://api.deepseek.com/chat/completions',
        model: 'deepseek-flash',
        pricing: hostedDeepSeekPricing,
        budgetMicro: Number(this.env.HOSTED_LLM_CALL_BUDGET_MICRO ?? '1000000'),
        periodBudgetMicro: Number(this.env.HOSTED_LLM_PERIOD_BUDGET_MICRO ?? '20000000'),
        timeoutMs: 60_000,
      };
    }
    const { settings, apiKey } = stored;
    if (!settings.enabled) return undefined;
    if (!apiKey) throw new Error('AI credential unavailable');
    const profile = {
      model: `${settings.provider}:${settings.model}`,
      temperature: settings.temperature,
      reasoningEffort: settings.reasoningEffort,
      timeoutMs: settings.timeoutSeconds * 1000,
      maxOutputTokens: settings.maxOutputTokens,
      maxRetries: 0,
      maxPromptChars: 16000,
      maxSteps: 8,
      maxTotalTokens: 30000,
    };
    const catalog = AIModelCatalogConfigSchema.parse({
      version: 1,
      providers: {
        [settings.provider]: {
          type: 'openai-compatible',
          baseURL: settings.baseURL,
          apiKeyEnv: 'HOSTED_AI_API_KEY',
          supportsStructuredOutputs: false,
          quirks: ['inject-schema', 'recover-malformed-text'],
        },
      },
      profiles: { generation: profile, agent: profile },
    });
    const pricing: HostedLLMPricing = {
      version: `operator:${createHash('sha256').update(JSON.stringify(settings)).digest('hex')}`,
      provider: settings.provider,
      model: settings.model,
      currency: 'CNY',
      inputMicroPerMillion: Math.ceil(settings.inputPrice * 1_000_000),
      cachedInputMicroPerMillion: Math.ceil(settings.cachedInputPrice * 1_000_000),
      outputMicroPerMillion: Math.ceil(settings.outputPrice * 1_000_000),
    };
    return {
      catalog,
      env: {
        LUOOME_AI_CONFIG: join(this.dataRoot, 'operator', 'runtime-models.json'),
        HOSTED_AI_API_KEY: apiKey,
      },
      endpoint: `${settings.baseURL}/chat/completions`,
      model: settings.model,
      pricing: () => pricing,
      budgetMicro: Math.ceil(settings.callBudget * 1_000_000),
      periodBudgetMicro: Math.ceil(settings.periodBudget * 1_000_000),
      timeoutMs: settings.timeoutSeconds * 1000,
    };
  }
}
