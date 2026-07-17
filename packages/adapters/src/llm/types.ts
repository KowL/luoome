import type { LLMAdapterLike, LLMGenerateRequest } from '@luoome/core';

/**
 * LLM 生成结果：schema 校验后的结构化对象 + raw 原始文本（ARCHITECTURE §6.3，
 * raw 会进 AdviceDataSnapshot.llmReasoning 用于审计）。
 */
export type LLMGenerateResult<T> = T & { readonly raw: string };

/**
 * LLM 适配器接口（ARCHITECTURE §6.3：system + schema + data）。
 * 兼容 core 的 LLMAdapterLike（返回值是 T 的子类型，可直接赋给 ToolContext.adapters.llm）。
 *
 * 实现方约定：
 * - request.schema 为 zod schema 时，必须先 parse 再返回；
 * - parse 失败必须返回稳定 fallback，不得抛异常。
 */
export interface LLMAdapter extends LLMAdapterLike {
  readonly name: string;
  generate<T = unknown>(request: LLMGenerateRequest): Promise<LLMGenerateResult<T>>;
}
