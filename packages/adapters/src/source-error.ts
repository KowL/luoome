import type { SourceErrorKind } from '@luoome/core';

/**
 * 源执行错误的统一载体（docs/ddd/source-pluggability-and-observation-design.md §4.4）。
 * 供应商 client 与信封解析必须抛携带结构化 kind 的本错误，registry 读取 error.kind
 * 做观测归类，不依赖错误消息正则；对调用方的 result 契约（error.kind 字面值）不变。
 */
export class SourceExecutionError extends Error {
  override readonly name: string = 'SourceExecutionError';
  constructor(
    readonly kind: SourceErrorKind,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

export const networkError = (message: string, cause?: unknown): SourceExecutionError =>
  new SourceExecutionError('network', message, cause);
export const timeoutError = (message: string, cause?: unknown): SourceExecutionError =>
  new SourceExecutionError('timeout', message, cause);
export const rateLimitedError = (message: string, cause?: unknown): SourceExecutionError =>
  new SourceExecutionError('rate_limited', message, cause);
export const permissionError = (message: string, cause?: unknown): SourceExecutionError =>
  new SourceExecutionError('permission', message, cause);
export const noDataError = (message: string, cause?: unknown): SourceExecutionError =>
  new SourceExecutionError('no_data', message, cause);
export const partialDataError = (message: string, cause?: unknown): SourceExecutionError =>
  new SourceExecutionError('partial_data', message, cause);
export const invalidPayloadError = (message: string, cause?: unknown): SourceExecutionError =>
  new SourceExecutionError('invalid_payload', message, cause);
export const unsupportedMarketError = (message: string, cause?: unknown): SourceExecutionError =>
  new SourceExecutionError('unsupported_market', message, cause);
export const unsupportedCapabilityError = (
  message: string,
  cause?: unknown,
): SourceExecutionError => new SourceExecutionError('unsupported_capability', message, cause);
export const unsupportedAdjustmentError = (
  message: string,
  cause?: unknown,
): SourceExecutionError => new SourceExecutionError('unsupported_adjustment', message, cause);
export const upstreamError = (message: string, cause?: unknown): SourceExecutionError =>
  new SourceExecutionError('upstream_error', message, cause);

/** 未知异常统一收口为 upstream_error（保留原错误作 cause 由调用方决定）。 */
export const sourceErrorKindOf = (error: unknown): SourceErrorKind =>
  error instanceof SourceExecutionError ? error.kind : 'upstream_error';

/** HTTP 状态码 → 错误词表：401/403 鉴权、429 限流、其余非成功一律 upstream_error。 */
export const httpStatusErrorKind = (status: number): SourceErrorKind => {
  if (status === 401 || status === 403) return 'permission';
  if (status === 429) return 'rate_limited';
  return 'upstream_error';
};

/** AbortController 主动超时触发的拒绝识别（跨运行时：DOMException / 普通 Error）。 */
export const isAbortError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'name' in error &&
  (error as { readonly name?: unknown }).name === 'AbortError';
