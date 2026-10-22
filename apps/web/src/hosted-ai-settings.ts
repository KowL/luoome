import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AIModelCatalogConfigSchema, hostedDeepSeekPricing } from '@luoome/adapters';
import type { HostedLLMPricing } from '@luoome/core';
import { z } from 'zod';

const ProviderIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const rate = z.number().finite().min(0).max(100_000);
const SettingsSchema = z
  .object({
    enabled: z.boolean(),
    provider: ProviderIdSchema,
    model: z.string().trim().min(1).max(200),
    baseURL: z.url().refine((value) => {
      if (!URL.canParse(value)) return false;
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
  .refine((value) => !/[\r\n]/.test(value), '密钥不能包含换行，请重新粘贴完整 API 密钥');
export const SaveHostedAISettingsSchema = z
  .object({
    settings: SettingsSchema,
    apiKey: ApiKeySchema.optional(),
    clearApiKey: z.boolean().default(false),
  })
  .strict();
const LegacyStoredSchema = z
  .object({ version: z.literal(1), settings: SettingsSchema, apiKey: ApiKeySchema })
  .strict();
type Settings = z.infer<typeof SettingsSchema>;

const ModelSchema = z
  .object({
    id: SettingsSchema.shape.model,
    name: z.string().trim().min(1).max(200),
    temperature: SettingsSchema.shape.temperature.default(0.2),
    reasoningEffort: SettingsSchema.shape.reasoningEffort.default('off'),
    timeoutSeconds: SettingsSchema.shape.timeoutSeconds.default(60),
    maxOutputTokens: SettingsSchema.shape.maxOutputTokens.default(2048),
    inputPrice: rate.default(0),
    cachedInputPrice: rate.default(0),
    outputPrice: rate.default(0),
  })
  .strict()
  .refine((model) => model.cachedInputPrice <= model.inputPrice, '缓存输入费率不能大于输入费率');
const ProviderSchema = z
  .object({
    id: ProviderIdSchema,
    name: z.string().trim().min(1).max(100),
    baseURL: SettingsSchema.shape.baseURL,
    models: z.array(ModelSchema).min(1).max(100),
  })
  .strict()
  .refine(
    (provider) => new Set(provider.models.map((model) => model.id)).size === provider.models.length,
    '同一供应商不能包含重复模型 ID',
  );
const StoredProviderSchema = ProviderSchema.safeExtend({ apiKey: ApiKeySchema });
const CatalogSchema = z
  .object({
    version: z.literal(2),
    revision: z.string(),
    settings: SettingsSchema,
    providers: z.array(StoredProviderSchema).max(20),
  })
  .strict();
const MutationSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('save-provider'),
      revision: z.string(),
      provider: ProviderSchema,
      apiKey: ApiKeySchema.optional(),
      clearApiKey: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      action: z.literal('remove-provider'),
      revision: z.string(),
      providerId: ProviderIdSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('select-model'),
      revision: z.string(),
      providerId: z.string(),
      modelId: z.string(),
      enabled: z.boolean(),
      callBudget: SettingsSchema.shape.callBudget,
      periodBudget: SettingsSchema.shape.periodBudget,
    })
    .strict(),
]);
const presets = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-flash',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseURL: 'https://api.minimax.cn/v1',
    model: 'MiniMax-M3.1-Flash',
  },
  { id: 'kimi', name: 'Kimi', baseURL: 'https://api.moonshot.cn/v1', model: 'kimi-k3' },
];
type Provider = z.infer<typeof StoredProviderSchema>;
type Catalog = z.infer<typeof CatalogSchema>;
const providerFromSettings = (
  settings: Settings,
  apiKey: string,
): Provider & { models: [z.infer<typeof ModelSchema>] } => ({
  id: settings.provider,
  name: presets.find((preset) => preset.id === settings.provider)?.name ?? settings.provider,
  baseURL: settings.baseURL,
  apiKey,
  models: [
    {
      id: settings.model,
      name: settings.model,
      temperature: settings.temperature,
      reasoningEffort: settings.reasoningEffort,
      timeoutSeconds: settings.timeoutSeconds,
      maxOutputTokens: settings.maxOutputTokens,
      inputPrice: settings.inputPrice,
      cachedInputPrice: settings.cachedInputPrice,
      outputPrice: settings.outputPrice,
    },
  ],
});
const publicProviders = (providers: Provider[]) =>
  providers.map(({ apiKey, ...provider }) => ({
    ...provider,
    apiKeyConfigured: apiKey.length > 0,
  }));
const modelSettings = (
  settings: Settings,
  provider: Provider,
  model: z.infer<typeof ModelSchema>,
): Settings => {
  const { id, name: _name, ...parameters } = model;
  return {
    ...settings,
    ...parameters,
    provider: provider.id,
    baseURL: provider.baseURL,
    model: id,
  };
};

export class HostedAISettingsValidationError extends Error {}

const fieldLabels: Record<string, string> = {
  enabled: 'AI 开关',
  provider: '供应商',
  model: '模型名称',
  baseURL: 'API 地址',
  temperature: '温度',
  reasoningEffort: '推理强度',
  timeoutSeconds: '请求超时',
  maxOutputTokens: '最大输出 Token',
  inputPrice: '输入费率',
  cachedInputPrice: '缓存输入费率',
  outputPrice: '输出费率',
  callBudget: '单次预算',
  periodBudget: '周期预算',
  apiKey: 'API 密钥',
  clearApiKey: '清除密钥选项',
};

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
    private readonly fetchModels: (
      url: string,
      init: RequestInit,
    ) => Promise<Response> = globalThis.fetch,
  ) {
    this.path = join(dataRoot, 'operator', 'ai-settings.json');
  }

  private stored() {
    if (!existsSync(this.path)) return undefined;
    const value = JSON.parse(readFileSync(this.path, 'utf8'));
    const catalog =
      value.version === 1
        ? (() => {
            const legacy = LegacyStoredSchema.parse(value);
            return {
              version: 2 as const,
              revision: 'legacy',
              settings: legacy.settings,
              providers: [providerFromSettings(legacy.settings, legacy.apiKey)],
            };
          })()
        : CatalogSchema.parse(value);
    return {
      ...catalog,
      apiKey:
        catalog.providers.find((provider) => provider.id === catalog.settings.provider)?.apiKey ??
        '',
    };
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
        revision: stored.revision,
        providers: publicProviders(stored.providers),
        presets,
      };
    const legacy = this.legacy();
    const settings = {
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
    };
    return {
      settings,
      apiKeyConfigured: legacy !== undefined,
      source: 'environment' as const,
      revision: 'environment',
      providers: publicProviders(legacy ? [providerFromSettings(settings, legacy.apiKey)] : []),
      presets,
    };
  }

  private current(): Catalog {
    const stored = this.stored();
    if (stored) return stored;
    const view = this.read();
    const legacy = this.legacy();
    return {
      version: 2,
      revision: view.revision,
      settings: view.settings,
      providers: legacy ? [providerFromSettings(view.settings, legacy.apiKey)] : [],
    };
  }

  private write(catalog: Catalog) {
    const payload = CatalogSchema.parse({ ...catalog, revision: randomUUID() });
    if (payload.settings.enabled) {
      const provider = payload.providers.find((row) => row.id === payload.settings.provider);
      if (
        !provider?.apiKey ||
        !provider.models.some((model) => model.id === payload.settings.model)
      )
        throw new HostedAISettingsValidationError('启用 AI 前请选择已配置密钥和费率的模型');
    }
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

  mutate(value: unknown) {
    const parsed = MutationSchema.safeParse(value);
    if (!parsed.success)
      throw new HostedAISettingsValidationError(
        '请检查供应商名称、模型 ID、参数及预算；模型 ID 不能重复',
      );
    const input = parsed.data;
    const current = this.current();
    if (input.revision !== current.revision)
      throw new HostedAISettingsValidationError(
        '配置已在其他页面更新，请刷新配置后重新应用；当前草稿尚未保存',
      );
    let settings = current.settings;
    let providers = current.providers;
    if (input.action === 'save-provider') {
      const baseURL = new URL(input.provider.baseURL).href.replace(/\/+$/, '');
      if (/(?:^|\/)anthropic(?:\/v1)?\/?$/i.test(new URL(baseURL).pathname))
        throw new HostedAISettingsValidationError(
          '请选择 OpenAI Chat Completions 基础地址，不要填写 Anthropic 地址',
        );
      const previous = providers.find((row) => row.id === input.provider.id);
      if (input.apiKey && input.clearApiKey)
        throw new HostedAISettingsValidationError('请勿同时填写和清除密钥');
      if (previous?.apiKey && previous.baseURL !== baseURL && !input.apiKey && !input.clearApiKey)
        throw new HostedAISettingsValidationError('API 地址已更改，请重新填写 API 密钥');
      const provider: Provider = {
        ...input.provider,
        baseURL,
        apiKey: input.clearApiKey ? '' : input.apiKey || previous?.apiKey || '',
      };
      const selected = provider.models.find((model) => model.id === settings.model);
      if (provider.id === settings.provider) {
        if (settings.enabled && (!selected || !provider.apiKey))
          throw new HostedAISettingsValidationError('该模型正在使用，请先停用 AI 或选择其他模型');
        if (selected) settings = modelSettings(settings, provider, selected);
      }
      providers = previous
        ? providers.map((row) => (row.id === provider.id ? provider : row))
        : [...providers, provider];
    } else if (input.action === 'remove-provider') {
      if (settings.enabled && settings.provider === input.providerId)
        throw new HostedAISettingsValidationError('该供应商正在使用，请先停用 AI 或选择其他模型');
      providers = providers.filter((provider) => provider.id !== input.providerId);
    } else {
      const provider = providers.find((row) => row.id === input.providerId);
      const model = provider?.models.find((row) => row.id === input.modelId);
      if (input.enabled && (!provider || !model || !provider.apiKey))
        throw new HostedAISettingsValidationError('启用 AI 前请选择已配置密钥的模型');
      if (provider && model) settings = modelSettings(settings, provider, model);
      settings = {
        ...settings,
        enabled: input.enabled,
        callBudget: input.callBudget,
        periodBudget: input.periodBudget,
      };
    }
    const checked = SettingsSchema.safeParse(settings);
    if (!checked.success)
      throw new HostedAISettingsValidationError(
        '请检查模型费率及预算：启用时输入和输出费率须大于零，单次预算不能大于周期预算',
      );
    return this.write({
      version: 2,
      revision: current.revision,
      settings: checked.data,
      providers,
    });
  }

  async discoverModels(value: unknown) {
    const parsed = z
      .object({
        providerId: ProviderIdSchema.optional(),
        baseURL: SettingsSchema.shape.baseURL,
        apiKey: ApiKeySchema.optional(),
      })
      .strict()
      .safeParse(value);
    if (!parsed.success) throw new HostedAISettingsValidationError('请检查 API 地址和密钥');
    const input = parsed.data;
    const baseURL = new URL(input.baseURL).href.replace(/\/+$/, '');
    const provider = this.current().providers.find((row) => row.id === input.providerId);
    const apiKey = input.apiKey || (provider?.baseURL === baseURL ? provider.apiKey : '');
    if (!apiKey) throw new HostedAISettingsValidationError('获取模型前请填写当前 API 地址的密钥');
    try {
      const response = await this.fetchModels(`${baseURL}/models`, {
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new HostedAISettingsValidationError(
          `获取模型失败（HTTP ${response.status}），请检查地址与密钥，也可以手动添加模型`,
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('empty response');
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > 1_048_576) throw new Error('model catalog too large');
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      const responseText = Buffer.concat(chunks).toString('utf8');
      if (responseText.includes(apiKey)) throw new Error('credential in provider response');
      const body = z
        .object({
          data: z
            .array(
              z.object({
                id: z.string().trim().min(1).max(200),
                name: z.string().trim().min(1).max(200).optional(),
              }),
            )
            .max(5000),
        })
        .parse(JSON.parse(responseText));
      if (body.data.some((model) => model.id.includes(apiKey) || model.name?.includes(apiKey)))
        throw new Error('credential in model metadata');
      const unique = new Map(
        body.data.map((model) => [model.id, { id: model.id, name: model.name ?? model.id }]),
      );
      return { models: [...unique.values()] };
    } catch (error) {
      if (error instanceof HostedAISettingsValidationError) throw error;
      throw new HostedAISettingsValidationError(
        '无法获取模型列表，请检查 API 地址与网络，或手动添加模型',
      );
    }
  }

  save(value: unknown) {
    const parsed = SaveHostedAISettingsSchema.safeParse(value);
    if (!parsed.success) {
      const messages = parsed.error.issues.map((issue) => {
        const field = String(issue.path.at(-1));
        const label = Object.hasOwn(fieldLabels, field) ? fieldLabels[field] : undefined;
        return issue.code === 'custom'
          ? issue.message
          : label
            ? `${label}格式或取值范围不正确，请检查后重试`
            : '配置字段不完整或格式不正确，请检查后重试';
      });
      throw new HostedAISettingsValidationError([...new Set(messages)].join('；'));
    }
    const input = parsed.data;
    const url = new URL(input.settings.baseURL);
    if (input.settings.enabled && /(?:^|\/)anthropic(?:\/v1)?\/?$/i.test(url.pathname)) {
      throw new HostedAISettingsValidationError(
        '此处使用 OpenAI 兼容接口，不能填写 Anthropic 地址；请填写供应商的 OpenAI 兼容基础地址',
      );
    }
    const settings = {
      ...input.settings,
      baseURL: url.href.replace(/\/+$/, ''),
    };
    const previous = this.stored();
    const legacy = previous ? undefined : this.legacy();
    const previousSettings = previous?.settings ?? defaults;
    const sameProvider =
      previousSettings.provider === settings.provider &&
      previousSettings.baseURL === settings.baseURL;
    if (input.clearApiKey && input.apiKey)
      throw new HostedAISettingsValidationError('请勿同时填写和清除密钥');
    const apiKey = input.clearApiKey
      ? ''
      : input.apiKey || (sameProvider ? (previous?.apiKey ?? legacy?.apiKey ?? '') : '');
    if (settings.enabled && !apiKey)
      throw new HostedAISettingsValidationError(
        input.clearApiKey
          ? '请先停用 AI，再清除密钥'
          : sameProvider
            ? '启用 AI 时，请填写 API 密钥'
            : '供应商或 API 地址已更改，请重新填写 API 密钥；原配置未修改',
      );
    const current = this.current();
    const selectedModel = providerFromSettings(settings, apiKey);
    const replacement: Provider = { ...selectedModel };
    const existing = current.providers.find((provider) => provider.id === replacement.id);
    if (existing) {
      replacement.name = existing.name;
      replacement.models = existing.models.some((model) => model.id === settings.model)
        ? existing.models.map((model) =>
            model.id === settings.model ? selectedModel.models[0] : model,
          )
        : [...existing.models, ...replacement.models];
    }
    return this.write({
      version: 2,
      revision: current.revision,
      settings,
      providers: existing
        ? current.providers.map((provider) =>
            provider.id === replacement.id ? replacement : provider,
          )
        : [...current.providers, replacement],
    });
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
