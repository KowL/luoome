import { describe, expect, it } from 'vitest';

import { stockUniverseSourceOrderFromEnv } from './factory.js';

describe('stock-universe/factory', () => {
  it('默认启用 Eastmoney，显式顺序去重且拒绝不具备目录能力的 Tencent', () => {
    expect(stockUniverseSourceOrderFromEnv({})).toEqual(['eastmoney']);
    expect(
      stockUniverseSourceOrderFromEnv({
        LUOOME_STOCK_UNIVERSE_SOURCES: 'tushare,eastmoney',
      }),
    ).toEqual(['tushare', 'eastmoney']);
    expect(() =>
      stockUniverseSourceOrderFromEnv({
        LUOOME_STOCK_UNIVERSE_SOURCES: 'eastmoney,eastmoney',
      }),
    ).toThrow();
    expect(() =>
      stockUniverseSourceOrderFromEnv({
        LUOOME_STOCK_UNIVERSE_SOURCES: 'tencent',
      }),
    ).toThrow();
  });
});
