import { describe, expect, it } from 'vitest';

import { MinuteBarSchema } from './minute-bar.js';

const base = {
  stockId: '600519.SH',
  interval: '1m',
  endedAt: '2026-08-14T01:31:00.000Z',
  open: 1400,
  high: 1402,
  low: 1399,
  close: 1401,
  volume: 10_000,
  amount: 14_005_000,
  adjustment: 'raw',
  source: 'tushare',
  fetchedAt: '2026-08-14T01:31:05.000Z',
  completeness: 'closed',
} as const;

describe('MinuteBarSchema', () => {
  it('保留独立分钟 OHLCV、来源、raw 口径与双时间', () => {
    const bar = MinuteBarSchema.parse(base);
    expect(bar.endedAt).toEqual(new Date(base.endedAt));
    expect(bar.fetchedAt).toEqual(new Date(base.fetchedAt));
    expect(bar.adjustment).toBe('raw');
    expect(bar.amount).toBe(14_005_000);
  });

  it('拒绝伪复权、非法 OHLC 和未来桶时间', () => {
    expect(MinuteBarSchema.safeParse({ ...base, adjustment: 'qfq' }).success).toBe(false);
    expect(MinuteBarSchema.safeParse({ ...base, high: 1398 }).success).toBe(false);
    expect(
      MinuteBarSchema.safeParse({
        ...base,
        endedAt: '2026-08-14T01:32:00.000Z',
        fetchedAt: '2026-08-14T01:31:05.000Z',
      }).success,
    ).toBe(false);
  });

  it('只接受冻结的分钟周期', () => {
    expect(MinuteBarSchema.safeParse({ ...base, interval: '2m' }).success).toBe(false);
    expect(MinuteBarSchema.safeParse({ ...base, interval: '60m' }).success).toBe(true);
  });
});
