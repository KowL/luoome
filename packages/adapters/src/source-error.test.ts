import { SourceErrorKindSchema } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import {
  httpStatusErrorKind,
  invalidPayloadError,
  isAbortError,
  networkError,
  noDataError,
  partialDataError,
  permissionError,
  rateLimitedError,
  SourceExecutionError,
  sourceErrorKindOf,
  timeoutError,
  unsupportedAdjustmentError,
  unsupportedCapabilityError,
  unsupportedMarketError,
  upstreamError,
} from './source-error.js';

describe('SourceExecutionError', () => {
  it('携带结构化 kind 并保留 cause', () => {
    const cause = new Error('boom');
    const error = new SourceExecutionError('network', 'fetch 失败: boom', cause);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SourceExecutionError');
    expect(error.kind).toBe('network');
    expect(error.message).toBe('fetch 失败: boom');
    expect(error.cause).toBe(cause);
  });

  it('按 kind 构造的 helper 覆盖全部词表', () => {
    const helpers = [
      ['network', networkError('m')],
      ['timeout', timeoutError('m')],
      ['rate_limited', rateLimitedError('m')],
      ['permission', permissionError('m')],
      ['no_data', noDataError('m')],
      ['partial_data', partialDataError('m')],
      ['invalid_payload', invalidPayloadError('m')],
      ['unsupported_market', unsupportedMarketError('m')],
      ['unsupported_capability', unsupportedCapabilityError('m')],
      ['unsupported_adjustment', unsupportedAdjustmentError('m')],
      ['upstream_error', upstreamError('m')],
    ] as const;
    // helper 与 core 词表一一对应，不多不少
    expect(helpers.map(([kind]) => kind)).toEqual([...SourceErrorKindSchema.options]);
    for (const [kind, error] of helpers) {
      expect(error.kind).toBe(kind);
      expect(error.message).toBe('m');
    }
  });

  it('未知异常收口 upstream_error，结构化错误取自身 kind', () => {
    expect(sourceErrorKindOf(new SourceExecutionError('timeout', 't'))).toBe('timeout');
    expect(sourceErrorKindOf(new Error('plain'))).toBe('upstream_error');
    expect(sourceErrorKindOf('not-an-error')).toBe('upstream_error');
    expect(sourceErrorKindOf(undefined)).toBe('upstream_error');
  });

  it('HTTP 状态码映射：401/403 → permission，429 → rate_limited，其余 → upstream_error', () => {
    expect(httpStatusErrorKind(401)).toBe('permission');
    expect(httpStatusErrorKind(403)).toBe('permission');
    expect(httpStatusErrorKind(429)).toBe('rate_limited');
    expect(httpStatusErrorKind(500)).toBe('upstream_error');
    expect(httpStatusErrorKind(404)).toBe('upstream_error');
  });

  it('isAbortError 识别跨运行时的主动超时拒绝', () => {
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true);
    expect(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isAbortError(new Error('network'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});
