import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { parseTushareEnvelopeRows } from './envelope.js';

/** envelope 解析器单元测试（tushare 官方协议 {code, msg, data:{fields, items}}）。 */

describe('parseTushareEnvelopeRows', () => {
  it('接受 {code, msg, data:{fields, items}} 并按 fields 映射行', () => {
    const rows = parseTushareEnvelopeRows({
      code: 0,
      msg: '',
      data: {
        fields: ['a', 'b'],
        items: [
          [1, 'x'],
          [2, 'y'],
        ],
      },
    });
    expect(rows).toEqual([
      { a: 1, b: 'x' },
      { a: 2, b: 'y' },
    ]);
  });

  it('msg 为 null（tushare 成功时常见）→ 正常解析', () => {
    const rows = parseTushareEnvelopeRows({
      code: 0,
      msg: null,
      data: { fields: ['a'], items: [[1]] },
    });
    expect(rows).toEqual([{ a: 1 }]);
  });

  it('code≠0 → 抛 upstream_error', () => {
    expect(() =>
      parseTushareEnvelopeRows({ code: 40001, msg: 'denied', data: { fields: [], items: [] } }),
    ).toThrow(/tushare upstream_error: 40001 denied/);
  });

  it('行列数量不符 → 抛 length mismatch', () => {
    expect(() =>
      parseTushareEnvelopeRows({ code: 0, data: { fields: ['a', 'b'], items: [[1]] } }),
    ).toThrow(/length mismatch/);
  });

  it('其它响应形态（对象数组 / 裸数组）→ ZodError', () => {
    expect(() => parseTushareEnvelopeRows({ data: [{ a: 1 }] })).toThrow(ZodError);
    expect(() => parseTushareEnvelopeRows([[1, 2]])).toThrow(ZodError);
  });
});
