import type { ToolError, ToolResult } from '@luoome/core';

/** ToolResult 错误 → HTTP 状态码（响应体仍是 ToolResult 形状）。 */
export const statusOf = (error: ToolError): number => {
  switch (error.kind) {
    case 'invalid_input':
      return 400;
    case 'not_found':
      return 404;
    case 'permission_denied':
      return 403;
    case 'adapter_error':
      // 上游 / 解析失败 → 502 Bad Gateway，前端用此判 upstream-unavailable 文案
      return 502;
    default:
      return 500;
  }
};

export const jsonResult = (result: ToolResult<unknown>, statusOverride?: number): Response =>
  new Response(JSON.stringify(result), {
    status: statusOverride ?? (result.ok ? 200 : statusOf(result.error)),
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

export const permissionDenied = (required: string): ToolResult<never> => ({
  ok: false,
  error: { kind: 'permission_denied', required },
});

export const notFound = (entity: string, id: string): ToolResult<never> => ({
  ok: false,
  error: { kind: 'not_found', entity, id },
});

export const parseJsonObject = async (
  request: Request,
): Promise<
  { readonly parsed: true; readonly data: Record<string, unknown> } | ToolResult<never>
> => {
  try {
    const value: unknown = await request.json();
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return {
        ok: false,
        error: { kind: 'invalid_input', message: '请求体必须是 JSON 对象', issues: [] },
      };
    }
    return { parsed: true, data: value as Record<string, unknown> };
  } catch {
    return {
      ok: false,
      error: { kind: 'invalid_input', message: '请求体必须是 JSON 对象', issues: [] },
    };
  }
};
