import type { z } from 'zod';

/**
 * 领域不变量被违反时抛出。
 * 只在 entity 构造函数 / assertXxxInvariants 内部使用，
 * tool 层必须捕获并转成 { kind: 'invariant_violation' } ToolError。
 */
export class InvariantError extends Error {
  override readonly name = 'InvariantError';

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Zod 4 issue 类型别名，避免下游直接依赖 zod 内部路径。 */
export type ZodIssue = z.core.$ZodIssue;

/**
 * Tool 错误判别联合（ARCHITECTURE §7.3）。
 * Tool 永不抛异常，永远返回 ToolResult；error 字段必须是本联合的一员。
 */
export type ToolError =
  | {
      readonly kind: 'invalid_input';
      readonly message: string;
      readonly issues: readonly ZodIssue[];
    }
  | { readonly kind: 'not_found'; readonly entity: string; readonly id: string }
  | { readonly kind: 'invariant_violation'; readonly message: string }
  | {
      readonly kind: 'adapter_error';
      readonly adapter: string;
      readonly cause: string;
      readonly recoverable: boolean;
    }
  | { readonly kind: 'permission_denied'; readonly required: string }
  | {
      readonly kind: 'llm_error';
      readonly provider: string;
      readonly cause: string;
      readonly retryable: boolean;
    }
  | { readonly kind: 'internal'; readonly cause: string };

/** ToolError 的 kind 全集，供 registry / MCP 层做 exhaustiveness 检查。 */
export type ToolErrorKind = ToolError['kind'];
