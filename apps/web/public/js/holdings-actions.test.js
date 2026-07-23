import { describe, expect, it } from 'bun:test';

import { quotePriceFromResult } from './holdings-actions.js';

describe('新增持仓行情价格', () => {
  it('从 fetch_quote 的 data.quote.close 中读取现价', () => {
    expect(
      quotePriceFromResult({
        ok: true,
        data: { quote: { close: 12.34 } },
      }),
    ).toBe(12.34);
  });

  it('失败或非法价格不回填', () => {
    expect(quotePriceFromResult({ ok: false, error: { kind: 'adapter_error' } })).toBeNull();
    expect(quotePriceFromResult({ ok: true, data: { quote: { close: 0 } } })).toBeNull();
  });
});
