import { z } from 'zod';

export type LLMProviderName = 'openai-compatible' | 'anthropic';

export const LLMProviderNameSchema = z.enum(['openai-compatible', 'anthropic']);
export const ALL_LLM_PROVIDERS: readonly LLMProviderName[] = [
  'openai-compatible',
  'anthropic',
] as const;

export const DEFAULT_LLM_BASE_URL: Readonly<Record<LLMProviderName, string>> = {
  'openai-compatible': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

export const DEFAULT_LLM_MODEL: Readonly<Record<LLMProviderName, string>> = {
  'openai-compatible': 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5',
};

export const LLM_MAX_PROMPT_TOKENS = 4000;
export const LLM_CALL_TIMEOUT_MS = 5_000;

export interface LLMProviderConfig {
  readonly provider: LLMProviderName;
  readonly baseUrl?: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly maxPromptTokens?: number;
}

export const LLMProviderConfigSchema = z.object({
  provider: LLMProviderNameSchema,
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
  maxPromptTokens: z.number().int().positive().optional(),
});

export const parseLlmProviderConfigFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): LLMProviderConfig => {
  const rawProvider = env.LUOOME_LLM_PROVIDER?.trim().toLowerCase();
  if (rawProvider === undefined || rawProvider === '') {
    throw new Error('缺少 LUOOME_LLM_PROVIDER；必须配置为 openai-compatible 或 anthropic');
  }
  const providerParse = LLMProviderNameSchema.safeParse(rawProvider);
  if (!providerParse.success) {
    throw new Error(
      `LUOOME_LLM_PROVIDER="${rawProvider}" 非法，必须是 ${ALL_LLM_PROVIDERS.join(' | ')}`,
    );
  }
  const provider = providerParse.data;
  const apiKey = env.LUOOME_LLM_API_KEY?.trim();
  if (apiKey === undefined || apiKey === '') {
    throw new Error(`LUOOME_LLM_PROVIDER=${provider} 需要 LUOOME_LLM_API_KEY`);
  }
  const baseUrl = env.LUOOME_LLM_BASE_URL?.trim();
  return {
    provider,
    model: env.LUOOME_LLM_MODEL?.trim() || DEFAULT_LLM_MODEL[provider],
    ...(baseUrl !== undefined && baseUrl !== '' ? { baseUrl } : {}),
    apiKey,
  };
};
