import { z } from 'zod';

/**
 * LLM 适配器配置（v0.2 起独立模块，ARCHITECTURE §6.3 env 路由）。
 *
 * 设计要点：
 * - v0.2 起支持 3 个 provider：mock / openai-compatible / anthropic。
 *   「openai-compatible」一份实现覆盖 OpenAI / DeepSeek / Kimi / Moonshot / Zhipu，
 *   因这五家协议 + JSON Schema 行为对齐（response_format: { type: 'json_schema' }）。
 * - apiKey 缺省 / 空串 → 视为未配置；适配器层走 mock fallback（见 adapters/llm/manager）。
 * - 所有字段走 schema parse，env 拼写错误在启动期失败，不在 tool 调用期炸。
 */

export type LLMProviderName = 'mock' | 'openai-compatible' | 'anthropic';

export const LLMProviderNameSchema = z.enum(['mock', 'openai-compatible', 'anthropic']);

/** 顺序固定，CLI `luoome llm list-providers` 用。 */
export const ALL_LLM_PROVIDERS: readonly LLMProviderName[] = [
  'mock',
  'openai-compatible',
  'anthropic',
] as const;

/**
 * 默认 base URL 表（每个 provider 一个）。
 * 用户可通过 LUOOME_LLM_BASE_URL 覆盖；mock provider 不需要 base url。
 */
export const DEFAULT_LLM_BASE_URL: Readonly<Record<LLMProviderName, string | null>> = {
  mock: null,
  'openai-compatible': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

/** 默认 model 表（同上可被 LUOOME_LLM_MODEL 覆盖）。 */
export const DEFAULT_LLM_MODEL: Readonly<Record<LLMProviderName, string>> = {
  mock: 'mock-v0',
  'openai-compatible': 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5',
};

/**
 * 单 prompt token 上限（plan-v0.2-v0.3 §6 硬约束 10）。
 * 超限在 adapter 层自动截断 + warn；不改业务语义。
 */
export const LLM_MAX_PROMPT_TOKENS = 4000;

/** 单次 LLM 调用超时（plan-v0.2-v0.3 §6 硬约束 10）。 */
export const LLM_CALL_TIMEOUT_MS = 5_000;

export interface LLMProviderConfig {
  readonly provider: LLMProviderName;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly model: string;
  /** 覆盖默认 timeout（ms），主要给测试用。 */
  readonly timeoutMs?: number;
  /** 覆盖默认 token 上限，主要给测试用。 */
  readonly maxPromptTokens?: number;
}

export const LLMProviderConfigSchema = z.object({
  provider: LLMProviderNameSchema,
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1).optional(),
  model: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
  maxPromptTokens: z.number().int().positive().optional(),
});

/**
 * 从 env 解析 LLMProviderConfig（adapter 入口）。
 *
 * 行为约定：
 * - LUOOME_LLM_PROVIDER 缺省 / 空串 / 'mock' → provider='mock'，其余字段不读。
 * - 其它 provider：LUOOME_LLM_BASE_URL / LUOOME_LLM_API_KEY / LUOOME_LLM_MODEL
 *   缺省时分别回退到 DEFAULT_LLM_BASE_URL / undefined / DEFAULT_LLM_MODEL。
 * - provider='anthropic' 或 'openai-compatible' 且 apiKey 未设 → 抛错
 *   （生产配置明确缺失；mock fallback 由 manager 在 apiKey 空时接管，不是这里）。
 */
export const parseLlmProviderConfigFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): LLMProviderConfig => {
  const rawProvider = env.LUOOME_LLM_PROVIDER?.trim().toLowerCase() ?? 'mock';
  if (rawProvider === '' || rawProvider === 'mock') {
    return { provider: 'mock', model: DEFAULT_LLM_MODEL.mock };
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
    throw new Error(
      `LUOOME_LLM_PROVIDER=${provider} 需要 LUOOME_LLM_API_KEY；未配置请用 provider=mock`,
    );
  }
  const baseUrl = env.LUOOME_LLM_BASE_URL?.trim();
  return {
    provider,
    model: env.LUOOME_LLM_MODEL?.trim() || DEFAULT_LLM_MODEL[provider],
    ...(baseUrl !== undefined && baseUrl !== '' ? { baseUrl } : {}),
    apiKey,
  };
};
