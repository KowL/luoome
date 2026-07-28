import { describe, expect, it } from 'vitest';

import { DailyBarSchema, QuoteSchema } from './quote.js';

const bar = {
  stockId: '600519.SH',
  date: new Date('2026-07-27T00:00:00.000Z'),
  open: 1400,
  high: 1420,
  low: 1390,
  close: 1410,
  volume: 1_000_000,
  source: 'test',
};

describe('DailyBarSchema', () => {
  it('只接受前复权日线，并允许记录数据源原始复权因子', () => {
    expect(
      DailyBarSchema.parse({
        ...bar,
        adjustment: 'qfq',
        sourceAdjFactor: 1.234,
      }),
    ).toMatchObject({
      adjustment: 'qfq',
      sourceAdjFactor: 1.234,
    });
  });

  it('拒绝 raw/hfq，调用方不能把未规范化价格写成 DailyBar', () => {
    expect(
      DailyBarSchema.safeParse({
        ...bar,
        adjustment: 'raw',
      }).success,
    ).toBe(false);
    expect(
      DailyBarSchema.safeParse({
        ...bar,
        adjustment: 'hfq',
      }).success,
    ).toBe(false);
  });
});

describe('QuoteSchema', () => {
  it('区分市场观测时间与本机获取时间，并把 ts 映射为 observedAt', () => {
    const quote = QuoteSchema.parse({
      stockId: '600519.SH',
      observedAt: '2026-07-28T06:59:00.000Z',
      fetchedAt: '2026-07-28T07:00:00.000Z',
      timestampSource: 'upstream',
      open: 1400,
      high: 1420,
      low: 1390,
      close: 1410,
      volume: 1_000_000,
      source: 'test',
    });

    expect(quote.observedAt).toEqual(new Date('2026-07-28T06:59:00.000Z'));
    expect(quote.fetchedAt).toEqual(new Date('2026-07-28T07:00:00.000Z'));
    expect(quote.ts).toEqual(quote.observedAt);
  });

  it('retrieval 时间戳必须令 observedAt 与 fetchedAt 相等', () => {
    const result = QuoteSchema.safeParse({
      stockId: '600519.SH',
      observedAt: '2026-07-28T06:59:00.000Z',
      fetchedAt: '2026-07-28T07:00:00.000Z',
      timestampSource: 'retrieval',
      open: 1400,
      high: 1420,
      low: 1390,
      close: 1410,
      volume: 1_000_000,
      source: 'test',
    });

    expect(result.success).toBe(false);
  });
});
