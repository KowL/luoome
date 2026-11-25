import type { LLMGenerateRequest } from '@luoome/core';
import { generateText, NoObjectGeneratedError, Output } from 'ai';
import type { z } from 'zod';
import type { ResolvedAIModelProfile } from './model-catalog.js';
import {
  buildSystemContent,
  recoverMalformedText,
  toNormalizedJsonSchema,
} from './provider-quirks.js';
import { toValidatedAISchema } from './schema.js';
import {
  type LLMAdapter,
  type LLMAdapterLimits,
  type LLMGenerateResult,
  LLMOutputBudgetError,
  LLMTimeoutError,
  type LLMUsageReport,
} from './types.js';

/**
 * 提示词预算超限时的结构化裁剪记录：只删整个数组尾部和超长文本，
 * 数字、布尔与字段结构原样保留，保证发给模型的永远是完整可解析的 JSON。
 */
export interface PromptTrim {
  readonly path: string;
  readonly kind: 'array-tail' | 'string';
  readonly originalLength: number;
  readonly keptLength: number;
}

/** 超限降级原因；随 raw 回传，便于排查提示词预算与事实缺失。 */
export interface PromptDegradation {
  readonly reason: 'max_prompt_chars';
  readonly maxPromptChars: number;
  readonly originalChars: number;
  readonly projectedChars: number;
  readonly trimmed: readonly PromptTrim[];
  /** 未逐一列出的裁剪点数（数组嵌套时可能很多）。 */
  readonly unlistedTrims: number;
}

/** 结构化裁剪后仍超过 maxPromptChars：宁可失败，也不截断 JSON 或数字。 */
export class LLMPromptBudgetError extends Error {
  override readonly name = 'LLMPromptBudgetError';
}

const PROMPT_TRIM_STAGES = [
  { arrayLimit: 64, stringLimit: 8_000 },
  { arrayLimit: 32, stringLimit: 4_000 },
  { arrayLimit: 16, stringLimit: 2_000 },
  { arrayLimit: 8, stringLimit: 1_000 },
  { arrayLimit: 4, stringLimit: 500 },
  { arrayLimit: 2, stringLimit: 250 },
  { arrayLimit: 1, stringLimit: 200 },
] as const;
const PROMPT_MAX_REPORTED_TRIMS = 12;

const toJsonSafe = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => toJsonSafe(item));
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      const item = source[key];
      if (item === undefined) continue;
      out[key] = toJsonSafe(item);
    }
    return out;
  }
  return value;
};

interface TrimLimits {
  readonly arrayLimit: number;
  readonly stringLimit: number;
}

const trimValue = (
  value: unknown,
  path: string,
  limits: TrimLimits,
  trimmed: PromptTrim[],
): unknown => {
  if (typeof value === 'string') {
    if (value.length <= limits.stringLimit) return value;
    trimmed.push({
      path,
      kind: 'string',
      originalLength: value.length,
      keptLength: limits.stringLimit,
    });
    return `${value.slice(0, limits.stringLimit)}…`;
  }
  if (Array.isArray(value)) {
    const kept = value
      .slice(0, limits.arrayLimit)
      .map((item, index) => trimValue(item, `${path}[${index}]`, limits, trimmed));
    if (value.length > limits.arrayLimit) {
      trimmed.push({
        path,
        kind: 'array-tail',
        originalLength: value.length,
        keptLength: limits.arrayLimit,
      });
    }
    return kept;
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      const item = source[key];
      if (item === undefined) continue;
      out[key] = trimValue(item, `${path}.${key}`, limits, trimmed);
    }
    return out;
  }
  return value;
};

const degradationOf = (input: {
  readonly maxPromptChars: number;
  readonly originalChars: number;
  readonly projectedChars: number;
  readonly trimmed: readonly PromptTrim[];
}): PromptDegradation => ({
  reason: 'max_prompt_chars',
  maxPromptChars: input.maxPromptChars,
  originalChars: input.originalChars,
  projectedChars: input.projectedChars,
  trimmed: input.trimmed.slice(0, PROMPT_MAX_REPORTED_TRIMS),
  unlistedTrims: Math.max(0, input.trimmed.length - PROMPT_MAX_REPORTED_TRIMS),
});

/**
 * 提示词数据投影：在 maxPromptChars 内逐步收紧数组长度与单字段文本长度，
 * 超限时把降级原因一并写进提示词，而不是把 JSON 字符串截成半截。
 */
export const projectPromptData = (
  data: unknown,
  maxPromptChars: number,
): { readonly prompt: string; readonly degradation?: PromptDegradation } => {
  const original = JSON.stringify(data);
  if (original.length <= maxPromptChars) return { prompt: original };

  const jsonSafe = toJsonSafe(data);
  for (const limits of PROMPT_TRIM_STAGES) {
    const trimmed: PromptTrim[] = [];
    const projected = trimValue(jsonSafe, 'data', limits, trimmed);
    const prompt = JSON.stringify({
      promptBudget: {
        reason: 'max_prompt_chars',
        maxPromptChars,
        originalChars: original.length,
        trimmed: trimmed.slice(0, PROMPT_MAX_REPORTED_TRIMS),
        unlistedTrims: Math.max(0, trimmed.length - PROMPT_MAX_REPORTED_TRIMS),
        note: '因提示词预算，部分数组尾部或长文本已省略；省略不代表事实不存在，未给出的字段按 unavailable 处理。',
      },
      data: projected,
    });
    if (prompt.length <= maxPromptChars) {
      return {
        prompt,
        degradation: degradationOf({
          maxPromptChars,
          originalChars: original.length,
          projectedChars: prompt.length,
          trimmed,
        }),
      };
    }
  }
  throw new LLMPromptBudgetError(
    `提示词在结构化裁剪后仍超过 maxPromptChars=${maxPromptChars}（原始 ${original.length} 字符）；` +
      '请减少事实段或提高该 profile 的 maxPromptChars，不截断 JSON 发送给模型。',
  );
};

const toUsageReport = (usage: unknown): LLMUsageReport | undefined => {
  if (usage === null || typeof usage !== 'object') return undefined;
  const record = usage as {
    inputTokens?: unknown;
    outputTokens?: unknown;
    outputTokenDetails?: { reasoningTokens?: unknown };
    reasoningTokens?: unknown;
    costUsd?: unknown;
  };
  const num = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  // AI SDK v6 把 usage 拆成 { inputTokens: { total }, outputTokens: { total, reasoning } }；
  // 兼容旧版的扁平数字字段，避免计量在升级后静默归零。
  const tokens = (value: unknown): number => {
    if (typeof value === 'number') return num(value);
    if (value !== null && typeof value === 'object') {
      return num((value as { total?: unknown }).total);
    }
    return 0;
  };
  const outputTokens = record.outputTokens;
  return {
    promptTokens: tokens(record.inputTokens),
    completionTokens: tokens(outputTokens),
    reasoningTokens:
      record.outputTokenDetails?.reasoningTokens !== undefined
        ? tokens(record.outputTokenDetails.reasoningTokens)
        : record.reasoningTokens !== undefined
          ? tokens(record.reasoningTokens)
          : tokens(
              outputTokens !== null && typeof outputTokens === 'object'
                ? (outputTokens as { reasoning?: unknown }).reasoning
                : undefined,
            ),
    costUsd: num(record.costUsd),
  };
};

const buildRaw = (
  result: {
    readonly text: string;
    readonly response: { readonly body?: unknown };
    readonly usage: unknown;
  },
  degradation?: PromptDegradation,
): string =>
  JSON.stringify({
    text: result.text,
    body: result.response.body ?? null,
    usage: result.usage,
    ...(degradation === undefined ? {} : { promptProjection: degradation }),
  });

const buildRawFromError = (
  error: NoObjectGeneratedError,
  degradation?: PromptDegradation,
): string =>
  JSON.stringify({
    text: error.text ?? '',
    response: error.response ?? null,
    usage: error.usage ?? null,
    finishReason: error.finishReason ?? null,
    ...(degradation === undefined ? {} : { promptProjection: degradation }),
  });

/** generateText 结果的 usage → 预算计量结构。 */
const usageOf = (result: { readonly usage?: unknown }): LLMUsageReport | undefined =>
  toUsageReport(result.usage);

const budgetError = (input: {
  readonly finishReason: string | undefined;
  readonly maxOutputTokens: number;
  readonly textLength: number;
}): LLMOutputBudgetError =>
  new LLMOutputBudgetError(
    `模型未生成可用内容（finishReason=${input.finishReason ?? 'unknown'}，` +
      `textLength=${input.textLength}，maxOutputTokens=${input.maxOutputTokens}）。` +
      '推理 token 可能已用尽输出预算；重试时应提高该 profile 的 maxOutputTokens（如 8192）或降低 reasoningEffort。',
  );

const isTimeoutError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  const text = `${error.name} ${error.message}`.toLowerCase();
  return text.includes('timed out') || text.includes('timeout');
};

/** AI SDK 在不同阶段会把「没生成内容」报成 NoOutputGenerated / NoObjectGenerated。 */
const noOutput = (
  error: unknown,
):
  | { readonly text: string; readonly finishReason: string | undefined; readonly usage?: unknown }
  | undefined => {
  if (NoObjectGeneratedError.isInstance(error)) {
    return {
      text: error.text ?? '',
      finishReason: error.finishReason ?? undefined,
      usage: error.usage,
    };
  }
  if (!(error instanceof Error)) return undefined;
  if (error.name !== 'AI_NoOutputGeneratedError' && error.message !== 'No output generated.')
    return undefined;
  const record = error as Error & { text?: unknown; finishReason?: unknown; usage?: unknown };
  return {
    text: typeof record.text === 'string' ? record.text : '',
    finishReason: typeof record.finishReason === 'string' ? record.finishReason : undefined,
    usage: record.usage,
  };
};

export class AISDKAdapter implements LLMAdapter {
  readonly name: string;
  readonly limits: LLMAdapterLimits;

  constructor(private readonly profile: ResolvedAIModelProfile) {
    this.name = profile.modelRef;
    this.limits = {
      maxOutputTokens: profile.maxOutputTokens,
      timeoutMs: profile.timeoutMs,
    };
  }

  async generate<T = unknown>(request: LLMGenerateRequest): Promise<LLMGenerateResult<T>> {
    if (request.schema === undefined) {
      throw new Error(`${this.name} 需要 schema`);
    }
    const schema = request.schema as z.ZodType<T>;
    const normalizedSchema = toNormalizedJsonSchema(schema);
    const quirks = this.profile.quirks;
    const maxOutputTokens = request.maxOutputTokens ?? this.profile.maxOutputTokens;
    const timeoutMs = request.timeoutMs ?? this.profile.timeoutMs;
    const abortSignal = AbortSignal.timeout(timeoutMs);
    const maxRetries = request.policy?.providerRetries ?? this.profile.maxRetries;
    const projection = projectPromptData(request.data, this.profile.maxPromptChars);
    const prompt = projection.prompt;
    const degradation = projection.degradation;
    // 不支持 structured outputs 的 provider 走纯文本 + system 注入 schema，
    // 不发送 response_format，避免上游告警或忽略参数（2026-11-23 M5）。
    const system =
      quirks.injectSchemaIntoSystem || !this.profile.supportsStructuredOutputs
        ? buildSystemContent(request.system, normalizedSchema)
        : request.system;

    try {
      if (this.profile.supportsStructuredOutputs) {
        const result = await generateText({
          model: this.profile.model,
          system,
          prompt,
          output: Output.object({ schema: toValidatedAISchema(schema) }),
          abortSignal,
          maxRetries,
          maxOutputTokens,
          ...(this.profile.providerType === 'anthropic'
            ? { providerOptions: { anthropic: { structuredOutputMode: 'auto' } } }
            : {}),
        });
        return {
          ...result.output,
          raw: buildRaw(result, degradation),
          usage: usageOf(result),
        };
      }
      const result = await generateText({
        model: this.profile.model,
        system,
        prompt,
        abortSignal,
        maxRetries,
        maxOutputTokens,
      });
      try {
        return {
          ...recoverMalformedText(result.text, schema),
          raw: buildRaw(result, degradation),
          usage: usageOf(result),
        };
      } catch (error) {
        if (result.text.trim().length === 0 || result.finishReason === 'length') {
          throw budgetError({
            finishReason: result.finishReason,
            maxOutputTokens,
            textLength: result.text.length,
          });
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof LLMOutputBudgetError || error instanceof LLMTimeoutError) throw error;
      if (isTimeoutError(error)) {
        throw new LLMTimeoutError(
          `模型调用超时（timeoutMs=${timeoutMs}）。重试时会放宽超时；` +
            '如持续超时，请提高该 profile 的 timeoutMs 或降低 maxOutputTokens。',
          { cause: error },
        );
      }
      const empty = noOutput(error);
      if (empty !== undefined) {
        if (quirks.recoverMalformedText && empty.text.length > 0) {
          try {
            const usage = toUsageReport(empty.usage);
            return {
              ...recoverMalformedText(empty.text, schema),
              raw: NoObjectGeneratedError.isInstance(error)
                ? buildRawFromError(error, degradation)
                : JSON.stringify({
                    text: empty.text,
                    ...(degradation === undefined ? {} : { promptProjection: degradation }),
                  }),
              ...(usage === undefined ? {} : { usage }),
            };
          } catch {
            // 恢复失败后继续走下面的预算诊断，保留原始 finishReason / usage。
          }
        }
        if (empty.text.trim().length === 0 || empty.finishReason === 'length') {
          throw budgetError({
            finishReason: empty.finishReason,
            maxOutputTokens,
            textLength: empty.text.length,
          });
        }
      }
      throw error;
    }
  }
}

export type { LLMAdapter, LLMAdapterLimits, LLMGenerateRequest, LLMGenerateResult };
