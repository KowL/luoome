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

const truncate = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...[truncated ${value.length - maxChars} chars]`;
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

const buildRaw = (result: {
  readonly text: string;
  readonly response: { readonly body?: unknown };
  readonly usage: unknown;
}): string =>
  JSON.stringify({
    text: result.text,
    body: result.response.body ?? null,
    usage: result.usage,
  });

const buildRawFromError = (error: NoObjectGeneratedError): string =>
  JSON.stringify({
    text: error.text ?? '',
    response: error.response ?? null,
    usage: error.usage ?? null,
    finishReason: error.finishReason ?? null,
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
    const prompt = truncate(JSON.stringify(request.data), this.profile.maxPromptChars);
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
        return { ...result.output, raw: buildRaw(result), usage: usageOf(result) };
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
          raw: buildRaw(result),
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
                ? buildRawFromError(error)
                : JSON.stringify({ text: empty.text }),
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
