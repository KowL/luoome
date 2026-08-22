import { describe, expect, it } from 'vitest';

import { SourceExecutionError } from '../source-error.js';
import { fuyaoErrorKindOf, parseFuyaoEnvelope } from './envelope.js';

const okBody = (data: unknown): unknown => ({
  code: 0,
  message: 'success',
  request_id: 'req-1',
  data,
});

const errorBody = (code: number, message = 'boom'): unknown => ({
  code,
  message,
  request_id: 'req-1',
  data: null,
});

const kindOf = (body: unknown): string => {
  try {
    parseFuyaoEnvelope(body);
    return 'no-throw';
  } catch (error) {
    expect(error).toBeInstanceOf(SourceExecutionError);
    return (error as SourceExecutionError).kind;
  }
};

describe('fuyao/envelope', () => {
  it('code=0：返回 items 与 timestamp（毫秒 → Date），request_id 透出', () => {
    const parsed = parseFuyaoEnvelope(
      okBody({ timestamp: 1784275991000, item: [{ thscode: '600519.SH' }] }),
    );
    expect(parsed.items).toEqual([{ thscode: '600519.SH' }]);
    expect(parsed.timestamp?.getTime()).toBe(1784275991000);
    expect(parsed.requestId).toBe('req-1');
  });

  it('code=0 且 timestamp=null → timestamp 归一为 undefined', () => {
    const parsed = parseFuyaoEnvelope(okBody({ timestamp: null, item: [] }));
    expect(parsed.timestamp).toBeUndefined();
    expect(parsed.items).toEqual([]);
  });

  it('code=0 且 data=null → no_data', () => {
    expect(kindOf(okBody(null))).toBe('no_data');
  });

  it('错误码映射：3001/3002→no_data，3004→unsupported_market，4001→rate_limited', () => {
    expect(kindOf(errorBody(3001))).toBe('no_data');
    expect(kindOf(errorBody(3002))).toBe('no_data');
    expect(kindOf(errorBody(3004))).toBe('unsupported_market');
    expect(kindOf(errorBody(4001))).toBe('rate_limited');
  });

  it('错误码映射：2001/2003→permission，5001/5002/5003→upstream_error', () => {
    expect(kindOf(errorBody(2001))).toBe('permission');
    expect(kindOf(errorBody(2003))).toBe('permission');
    expect(kindOf(errorBody(5001))).toBe('upstream_error');
    expect(kindOf(errorBody(5002))).toBe('upstream_error');
    expect(kindOf(errorBody(5003))).toBe('upstream_error');
  });

  it('错误码映射：1001-1004 参数错 → upstream_error（message 保留原始 code/message）', () => {
    for (const code of [1001, 1002, 1003, 1004]) {
      expect(kindOf(errorBody(code, 'param bad'))).toBe('upstream_error');
    }
    try {
      parseFuyaoEnvelope(errorBody(1003, 'window exceeded'));
      expect.unreachable();
    } catch (error) {
      expect((error as SourceExecutionError).message).toContain('1003');
      expect((error as SourceExecutionError).message).toContain('window exceeded');
    }
  });

  it('未知错误码 → upstream_error 兜底', () => {
    expect(kindOf(errorBody(9999))).toBe('upstream_error');
  });

  it('信封形状不符 → invalid_payload', () => {
    expect(kindOf({ code: '0' })).toBe('invalid_payload');
    expect(kindOf({ code: 0, data: { item: 'not-array' } })).toBe('invalid_payload');
    expect(kindOf('not-an-object')).toBe('invalid_payload');
  });

  it('fuyaoErrorKindOf 单测口径与 parse 一致', () => {
    expect(fuyaoErrorKindOf(3001)).toBe('no_data');
    expect(fuyaoErrorKindOf(4001)).toBe('rate_limited');
    expect(fuyaoErrorKindOf(2001)).toBe('permission');
    expect(fuyaoErrorKindOf(1002)).toBe('upstream_error');
  });
});
