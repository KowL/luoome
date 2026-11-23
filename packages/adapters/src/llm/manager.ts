import type { LLMGenerateRequest, Logger } from '@luoome/core';
import {
  AdviceDecisionSchema,
  AdviceHorizonSchema,
  AdviceReasoningSchema,
  RULE_FALLBACK_EVIDENCE_MARKER,
  RULE_FALLBACK_PREMISE_MARKER,
  STANDARD_DISCLAIMERS,
} from '@luoome/core';
import { APICallError, NoObjectGeneratedError } from 'ai';
import { ZodError, z } from 'zod';
import {
  type LLMAdapter,
  type LLMGenerateResult,
  LLMOutputBudgetError,
  LLMTimeoutError,
} from './types.js';

/**
 * LLM 适配器编排（v0.2 起）。
 *
 * 职责：
 * 1. 接收模型目录已经解析好的 LLMAdapter。
 * 2. 实现 fallback 协议（plan-v0.2-v0.3 §2.3）：
 *    - 第一次 schema parse 失败 → 自动重试一次，prompt 加「上一轮未符合 schema」提示；
 *    - 仍失败 → 走 fallbackAdvice(data)，在 reasoning.evidence 标「LLM 推理失败，使用规则 fallback」；
 *    - 永不抛异常（永远返回 LLMGenerateResult）。
 *
 * 注：fallback 不返回 raw；advice.basedOn.llmReasoning 拿不到 raw 时省略。
 */

const FALLBACK_NOTE = `LLM 推理失败，使用${RULE_FALLBACK_EVIDENCE_MARKER}（v0.2 LLMManager）`;

export interface LLMManagerOptions {
  readonly adapter: LLMAdapter;
  readonly logger: Logger;
  readonly fallback?: 'rules' | 'throw';
}

/** Fallback 输出 schema（与 AdviceLLMSchema 对齐）。 */
const fallbackAdvice = (data: unknown): AdviceLLMOutput => {
  // 极简规则：MA5 > MA20 → watch（30）；否则 hold（20）
  const indicators = readIndicators(data);
  const ma5 = indicators.ma5;
  const ma20 = indicators.ma20;
  let decision: 'watch' | 'hold' = 'hold';
  let confidence = 20;
  const evidence: string[] = [FALLBACK_NOTE];
  if (
    typeof ma5 === 'number' &&
    typeof ma20 === 'number' &&
    Number.isFinite(ma5) &&
    Number.isFinite(ma20)
  ) {
    if (ma5 > ma20) {
      decision = 'watch';
      confidence = 30;
      evidence.push(`fallback 规则: MA5(${ma5}) > MA20(${ma20}) → watch`);
    } else {
      evidence.push(`fallback 规则: MA5(${ma5}) ≤ MA20(${ma20}) → hold`);
    }
  } else {
    evidence.push('fallback 规则: MA5 / MA20 缺失 → hold (默认)');
  }
  return {
    decision,
    confidence,
    horizon: 'short',
    reasoning: {
      premise: `${RULE_FALLBACK_PREMISE_MARKER}，基于规则的保守判断`,
      evidence,
      counterEvidence: ['规则 fallback 不考虑基本面 / 新闻 / 战法信号，结果仅供参考'],
    },
    risks: ['规则 fallback 信心度低，不应据此下单'],
  };
};

const readIndicators = (data: unknown): Record<string, number> => {
  if (typeof data !== 'object' || data === null) return {};
  const d = data as { indicators?: unknown };
  const indicators = d.indicators;
  if (typeof indicators !== 'object' || indicators === null) return {};
  // indicators 是 Record<string, TechnicalIndicators>；取首项
  const map = indicators as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    const v = map[key];
    if (typeof v === 'object' && v !== null) {
      return v as Record<string, number>;
    }
  }
  return {};
};

// 与 packages/plugins/analysis/src/internal/build-advice.ts 的 AdviceLLMSchema 对齐
// （避免循环 import，此处重写一份最小 schema；fallback 不需要完整字段）
const AdviceLLMSchemaForFallback = z.object({
  decision: AdviceDecisionSchema,
  confidence: z.number().min(0).max(100),
  horizon: AdviceHorizonSchema,
  reasoning: AdviceReasoningSchema,
  risks: z.array(z.string()),
});

type AdviceLLMOutput = z.infer<typeof AdviceLLMSchemaForFallback>;

export class LLMManager implements LLMAdapter {
  readonly name: string;
  private readonly inner: LLMAdapter;
  private readonly logger: Logger;
  private readonly fallback: 'rules' | 'throw';

  constructor(options: LLMManagerOptions) {
    this.logger = options.logger;
    this.fallback = options.fallback ?? 'rules';
    this.inner = options.adapter;
    this.name = this.inner.name;
  }

  async generate<T = unknown>(request: LLMGenerateRequest): Promise<LLMGenerateResult<T>> {
    // 第一次调用
    let firstError: unknown;
    try {
      return await this.inner.generate<T>(request);
    } catch (error) {
      firstError = error;
      this.logger.warn('llm-manager: 第一次 LLM 调用失败，准备重试', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // 重试一次：system 提示追加「上一轮未符合 schema，请重试」；
    // 推理模型把预算吃在 reasoning 上或上一轮超时时，同时放大预算 / 超时。
    if (request.schema !== undefined) {
      try {
        const retryRequest = this.buildRetryRequest(request, firstError);
        return await this.inner.generate<T>(retryRequest);
      } catch (retryError) {
        if (this.fallback === 'throw') throw retryError;
        this.logger.warn('llm-manager: 重试仍失败，走规则 fallback', {
          error: retryError instanceof Error ? retryError.message : String(retryError),
        });
      }
    }

    if (this.fallback === 'throw') throw firstError;
    // 规则 fallback：返回明确标记的低信心确定性判断。
    const fallbackData = this.buildFallbackResult<T>(request);
    this.logger.error('llm-manager: 走规则 fallback', { decision: this.preview(fallbackData) });
    return fallbackData;
  }

  /** 重试请求：保留原数据，附加原始错误文本；预算/超时类失败按适配器默认值放大。 */
  private buildRetryRequest(request: LLMGenerateRequest, firstError: unknown): LLMGenerateRequest {
    const limits = this.inner.limits;
    const maxOutputTokens =
      firstError instanceof LLMOutputBudgetError && limits !== undefined
        ? Math.min(limits.maxOutputTokens * 2, 8_192)
        : request.maxOutputTokens;
    const timeoutMs =
      firstError instanceof LLMTimeoutError && limits !== undefined
        ? Math.min(limits.timeoutMs * 2, 300_000)
        : request.timeoutMs;
    const hint =
      firstError instanceof LLMOutputBudgetError
        ? '上一轮没有生成内容，输出预算可能被推理耗尽。请直接输出最终 JSON，不要长篇推理。'
        : '上一轮你的输出未能通过 JSON schema 校验。请按下列错误原文修正，重新生成严格符合 schema 的 JSON。';
    return {
      system: `${request.system}\n\n[Retry hint] ${hint}\n错误原文：${describeError(firstError)}`,
      schema: request.schema,
      data: request.data,
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
  }

  /** 把 fallback 包装成 LLMGenerateResult<T>（无 raw）。 */
  private buildFallbackResult<T>(request: LLMGenerateRequest): LLMGenerateResult<T> {
    const parsed = fallbackAdvice(request.data);
    const validated = AdviceLLMSchemaForFallback.parse(parsed) as unknown as T;
    return { ...validated } as LLMGenerateResult<T>;
  }

  private preview<T>(result: LLMGenerateResult<T>): string {
    const r = result as unknown as Partial<AdviceLLMOutput>;
    return `${r.decision ?? '?'}@${r.confidence ?? '?'}`;
  }
}

const describeError = (e: unknown): string => {
  if (e instanceof LLMOutputBudgetError || e instanceof LLMTimeoutError) return e.message;
  if (NoObjectGeneratedError.isInstance(e)) {
    const detail =
      e.cause instanceof ZodError
        ? e.cause.issues
            .map((issue) =>
              issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`,
            )
            .join('；')
        : e.cause instanceof Error
          ? e.cause.message
          : '';
    return `输出未通过 schema 校验: ${e.message}${detail.length === 0 ? '' : `；${detail}`}`;
  }
  if (APICallError.isInstance(e)) {
    return `API${e.statusCode === undefined ? '' : ` HTTP ${e.statusCode}`}: ${e.message}`;
  }
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
};

export type { LLMAdapter, LLMGenerateRequest, LLMGenerateResult };
export { AdviceDecisionSchema, AdviceHorizonSchema, AdviceReasoningSchema, STANDARD_DISCLAIMERS };
