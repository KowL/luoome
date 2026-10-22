import type { LLMGenerateRequest, Logger } from '@luoome/core';
import { HostedLLMError } from '@luoome/core';
import { APICallError, NoObjectGeneratedError } from 'ai';
import type { LLMAdapter, LLMGenerateResult } from './types.js';

/**
 * LLM 适配器编排（v0.2 起）。
 *
 * 职责：
 * 1. 接收模型目录已经解析好的 LLMAdapter。
 * 2. 重试协议：schema parse 失败 → 自动重试一次，prompt 加「上一轮未符合 schema」提示。
 * 3. 仍失败 → 显式抛错，不做任何规则兜底。
 *
 * DSH 改造（docs/ddd/luoome-dsh-transformation-detailed-design.md §2.4）起，
 * 规则 fallback 生成路径已删除：规则模板曾被当作正常 Advice 落库，污染 confidence
 * 校准与命中率统计。存量规则兜底建议仍可由 core 的 isRuleFallbackAdvice 识别。
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
      if (error instanceof HostedLLMError) throw error;
      firstError = error;
      this.logger.warn('llm-manager: 第一次 LLM 调用失败，准备重试', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // 重试一次：system 提示追加「上一轮未符合 schema，请重试」
    if (request.schema !== undefined) {
      try {
        const retryRequest: LLMGenerateRequest = {
          system: `${request.system}\n\n[Retry hint] 上一轮你的输出未能通过 JSON schema 校验（${describeError(firstError)}）。请重新生成严格符合 schema 的 JSON。`,
          schema: request.schema,
          data: request.data,
        };
        return await this.inner.generate<T>(retryRequest);
      } catch (retryError) {
        if (retryError instanceof HostedLLMError) throw retryError;
        this.logger.error('llm-manager: 重试仍失败，显式抛错（无规则兜底）', {
          error: retryError instanceof Error ? retryError.message : String(retryError),
        });
        throw retryError;
      }
    }

    throw firstError;
  }
}

const describeError = (e: unknown): string => {
  if (NoObjectGeneratedError.isInstance(e)) return `输出未通过 schema 校验: ${e.message}`;
  if (APICallError.isInstance(e)) {
    return `API${e.statusCode === undefined ? '' : ` HTTP ${e.statusCode}`}: ${e.message}`;
  }
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
};

export type { LLMAdapter, LLMGenerateRequest, LLMGenerateResult };
