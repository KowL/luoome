import { money } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { aggregateCandles, type MarketCandle } from './market-view.js';

/** internal/market-view 纯函数测试（aggregateCandles：日 K → 周 / 月 K 聚合）。 */

const makeCandle = (date: string, overrides: Partial<MarketCandle> = {}): MarketCandle => ({
  date,
  open: money(100),
  high: money(105),
  low: money(95),
  close: money(102),
  volume: 1_000_000,
  source: 'eastmoney',
  completeness: 'closed',
  ...overrides,
});

describe('aggregateCandles', () => {
  it('day 粒度原样返回（拷贝）', () => {
    const candles = [makeCandle('2026-07-20'), makeCandle('2026-07-21')];
    const out = aggregateCandles(candles, 'day');
    expect(out).toEqual(candles);
    expect(out).not.toBe(candles);
  });

  it('空输入返回空数组', () => {
    expect(aggregateCandles([], 'week')).toEqual([]);
    expect(aggregateCandles([], 'month')).toEqual([]);
  });

  it('周聚合：跨周分组，周日归上一 ISO 周（周一起）', () => {
    const candles = [
      // 2026-07-17 周五、2026-07-19 周日 → 同属 7/13 周
      makeCandle('2026-07-17', { open: money(100), close: money(101) }),
      makeCandle('2026-07-19', { close: money(103) }),
      // 2026-07-20 周一起新的一周
      makeCandle('2026-07-20', { open: money(104), close: money(106) }),
      makeCandle('2026-07-21', { close: money(108), completeness: 'live', source: 'tencent' }),
    ];
    const out = aggregateCandles(candles, 'week');
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      date: '2026-07-19', // 区间内最后交易日
      open: 100,
      close: 103,
      completeness: 'closed',
    });
    expect(out[1]).toMatchObject({
      date: '2026-07-21',
      open: 104,
      close: 108,
      completeness: 'live', // 末根
      source: 'tencent', // 末根
    });
  });

  it('周聚合：open=首根 / close=末根 / high=max / low=min / volume=sum', () => {
    const candles = [
      makeCandle('2026-07-20', {
        open: money(10),
        high: money(12),
        low: money(9),
        close: money(11),
        volume: 100,
      }),
      makeCandle('2026-07-21', {
        open: money(11),
        high: money(15),
        low: money(10),
        close: money(14),
        volume: 200,
      }),
      makeCandle('2026-07-22', {
        open: money(14),
        high: money(14.5),
        low: money(8),
        close: money(9),
        volume: 300,
      }),
    ];
    const out = aggregateCandles(candles, 'week');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      date: '2026-07-22',
      open: 10,
      high: 15,
      low: 8,
      close: 9,
      volume: 600,
    });
  });

  it('月聚合：跨月分组，月首月尾边界', () => {
    const candles = [
      makeCandle('2026-06-29', { close: money(99) }),
      makeCandle('2026-06-30', { close: money(100) }),
      makeCandle('2026-07-01', { open: money(101), close: money(102) }),
      makeCandle('2026-07-31', { close: money(110) }),
    ];
    const out = aggregateCandles(candles, 'month');
    expect(out).toHaveLength(2);
    expect(out[0]?.date).toBe('2026-06-30');
    expect(out[0]?.close).toBe(100);
    expect(out[1]?.date).toBe('2026-07-31');
    expect(out[1]?.open).toBe(101);
    expect(out[1]?.close).toBe(110);
  });

  it('月聚合：volume 求和、输出按 date 升序', () => {
    const candles = [
      makeCandle('2026-05-15', { volume: 10 }),
      makeCandle('2026-06-01', { volume: 20 }),
      makeCandle('2026-06-30', { volume: 30 }),
      makeCandle('2026-07-02', { volume: 40 }),
    ];
    const out = aggregateCandles(candles, 'month');
    expect(out.map((c) => c.date)).toEqual(['2026-05-15', '2026-06-30', '2026-07-02']);
    expect(out.map((c) => c.volume)).toEqual([10, 50, 40]);
  });
});
