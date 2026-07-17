import type { ToolError } from '../error/index.js';

/** 通用 Result 类型。 */
export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const Err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/**
 * Tool 返回值（ARCHITECTURE §7.3）：成功分支字段为 data。
 * Tool 永不抛异常，永远返回 ToolResult。
 */
export type ToolResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ToolError };
