import type { LLMGenerateRequest, Logger } from '@luoome/core';
import { APICallError, NoObjectGeneratedError } from 'ai';
import { ZodError } from 'zod';
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
 * 2. 实现 schema 修复重试：第一次失败 → 自动重试一次，system 追加「上一轮未符合 schema」提示；
 *    仍失败 → 抛错，由调用方工具在自己的业务边界降级（rule-only / facts-only）。
 *
 * Manager 不构造任何业务输出：它不知道调用方的 schema 语义，伪兜底只会把
 * 与请求 T 无关的对象塞给调用方。
 */

export interface LLMManagerOptions {
  readonly adapter: LLMAdapter;
  readonly logger: Logger;
}

export class LLMManager implements LLMAdapter {
  readonly name: string;
  private readonly inner: LLMAdapter;
  private readonly logger: Logger;

  constructor(options: LLMManagerOptions) {
    this.logger = options.logger;
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

    // 调用方显式关闭 manager 重试时直接抛错，由外层 attempt 循环控制总请求数（每票 ≤2）。
    if (request.policy?.managerRetry === false) throw firstError;

    // 重试一次：system 提示追加「上一轮未符合 schema，请重试」；
    // 推理模型把预算吃在 reasoning 上或上一轮超时时，同时放大预算 / 超时。
    if (request.schema !== undefined) {
      try {
        const retryRequest = this.buildRetryRequest(request, firstError);
        return await this.inner.generate<T>(retryRequest);
      } catch (retryError) {
        this.logger.warn('llm-manager: 重试仍失败，交由调用方降级', {
          error: retryError instanceof Error ? retryError.message : String(retryError),
        });
        throw retryError;
      }
    }

    throw firstError;
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
      ...(request.policy === undefined ? {} : { policy: request.policy }),
    };
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
