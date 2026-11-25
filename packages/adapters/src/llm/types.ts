import type { LLMAdapterLike, LLMGenerateRequest } from '@luoome/core';

/**
 * 单次 LLM 调用的结构化用量（design.md §10.3）。
 * 预算守卫按 HTTP 次数 + token 双轨计量，金额只作参考展示。
 */
export interface LLMUsageReport {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly reasoningTokens: number;
  readonly costUsd: number;
}

/**
 * LLM 生成结果：schema 校验后的结构化对象 + raw 原始文本（ARCHITECTURE §6.3）。
 * raw 只供调用方即时诊断 / 重试，不写入 Advice.basedOn。
 * usage 供每日预算计量；适配器无法取得时由调用方按 0 处理。
 */
export type LLMGenerateResult<T> = T & {
  readonly raw: string;
  readonly usage?: LLMUsageReport | undefined;
};

/** 适配器的默认输出预算 / 超时；重试时 manager 以它为基线放大。 */
export interface LLMAdapterLimits {
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
}

/** 模型把输出预算耗在推理上，没有产出可用内容（finishReason=length / 空文本）。 */
export class LLMOutputBudgetError extends Error {
  override readonly name = 'LLMOutputBudgetError';
}

/** 单次调用超过 profile 配置的超时时间。 */
export class LLMTimeoutError extends Error {
  override readonly name = 'LLMTimeoutError';
}

/**
 * LLM 适配器接口（ARCHITECTURE §6.3：system + schema + data）。
 * 兼容 core 的 LLMAdapterLike（返回值是 T 的子类型，可直接赋给 ToolContext.adapters.llm）。
 *
 * 实现方约定：
 * - request.schema 为 zod schema 时，必须先 parse 再返回；
 * - parse 失败必须抛错，由 LLMManager 执行 retry hint，再由调用方工具在业务边界降级。
 */
export interface LLMAdapter extends LLMAdapterLike {
  readonly name: string;
  readonly limits?: LLMAdapterLimits;
  generate<T = unknown>(request: LLMGenerateRequest): Promise<LLMGenerateResult<T>>;
}
