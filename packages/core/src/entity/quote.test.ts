import { describe, expect, it } from 'vitest';

import { DailyBarSchema, IntradayMinuteSchema, QuoteSchema } from './quote.js';

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

describe('IntradayMinuteSchema', () => {
  it('当日累计口径分钟点：cumAmount 可选，非法值拒绝', () => {
    const point = IntradayMinuteSchema.parse({
      stockId: '002594.SZ',
      time: '2026-08-11T01:30:00.000Z',
      price: 90.12,
      cumVolume: 24_247_500,
      cumAmount: 2_193_664_806,
      source: 'tencent',
    });
    expect(point.time).toEqual(new Date('2026-08-11T01:30:00.000Z'));
    expect(point.cumAmount).toBe(2_193_664_806);
    const base = {
      stockId: '002594.SZ',
      time: '2026-08-11T01:30:00.000Z',
      price: 90.12,
      cumVolume: 24_247_500,
      source: 'tencent',
    };
    expect(IntradayMinuteSchema.parse(base).cumAmount).toBeUndefined();
    expect(IntradayMinuteSchema.safeParse({ ...base, cumVolume: -1 }).success).toBe(false);
    expect(IntradayMinuteSchema.safeParse({ ...base, cumAmount: -1 }).success).toBe(false);
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

  it('amount / turnoverRatePct 可选透传，缺省不出现在输出中', () => {
    const base = {
      stockId: '600519.SH',
      observedAt: '2026-07-28T07:00:00.000Z',
      open: 1400,
      high: 1420,
      low: 1390,
      close: 1410,
      volume: 1_000_000,
      source: 'test',
    };
    const withFields = QuoteSchema.parse({ ...base, amount: 1_410_000_000, turnoverRatePct: 0.22 });
    expect(withFields.amount).toBe(1_410_000_000);
    expect(withFields.turnoverRatePct).toBe(0.22);
    const without = QuoteSchema.parse(base);
    expect(without.amount).toBeUndefined();
    expect(without.turnoverRatePct).toBeUndefined();
    expect(QuoteSchema.safeParse({ ...base, amount: -1 }).success).toBe(false);
    expect(QuoteSchema.safeParse({ ...base, turnoverRatePct: -0.1 }).success).toBe(false);
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

  it('股本、市值和估值字段可选透传；估值允许负值，规模字段拒绝负值', () => {
    const base = {
      stockId: '300857.SZ',
      observedAt: '2026-07-28T07:00:00.000Z',
      open: 250,
      high: 260,
      low: 248,
      close: 254,
      volume: 10_000,
      source: 'eastmoney',
    };
    expect(
      QuoteSchema.parse({
        ...base,
        totalShares: 489_363_040,
        totalMarketCap: 124_538_000_049.6,
        peTtm: -48.44,
        psTtm: 12.34,
        pb: 20.55,
      }),
    ).toMatchObject({ peTtm: -48.44, psTtm: 12.34, pb: 20.55 });
    expect(QuoteSchema.safeParse({ ...base, totalMarketCap: -1 }).success).toBe(false);
    expect(QuoteSchema.parse(base).peTtm).toBeUndefined();
  });
});
