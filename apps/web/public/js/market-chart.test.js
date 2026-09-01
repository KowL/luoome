/* apps/web/public/js/market-chart.test.js —— 行情图表纯函数测试（设计 §14.4）。
 * 只测 DOM-free 的转换 / 配色 / MA 计算；createMarketChart 依赖浏览器，
 * 由浏览器验收覆盖。
 */

import { describe, expect, it } from 'bun:test';

import {
  computeMacdSeries,
  computeMaSeries,
  DOWN_COLOR,
  symmetricRangeAroundBase,
  toCandleData,
  toIntradayLineData,
  toIntradayVolumeData,
  toMarkerData,
  toMinuteCandleData,
  toMinuteLineData,
  toMinuteVolumeData,
  toVolumeData,
  UP_COLOR,
  volumeColor,
} from './market-chart.js';

const candle = (date, open, close, volume = 1000) => ({
  date,
  open,
  high: Math.max(open, close),
  low: Math.min(open, close),
  close,
  volume,
  source: 'eastmoney',
  completeness: 'closed',
});

describe('MarketCandle → 图表数据转换', () => {
  it('candle 映射为 time/open/high/low/close', () => {
    const data = toCandleData([candle('2026-07-24', 10, 11)]);
    expect(data).toEqual([{ time: '2026-07-24', open: 10, high: 11, low: 10, close: 11 }]);
  });

  it('volume 序列带红绿配色：close >= open 红，否则绿', () => {
    const data = toVolumeData([
      candle('2026-07-23', 10, 11),
      candle('2026-07-24', 11, 11), // 平盘按涨（红）
      candle('2026-07-25', 11, 10),
    ]);
    expect(data[0]).toEqual({ time: '2026-07-23', value: 1000, color: UP_COLOR });
    expect(data[1].color).toBe(UP_COLOR);
    expect(data[2].color).toBe(DOWN_COLOR);
  });

  it('volumeColor 红涨绿跌', () => {
    expect(volumeColor({ open: 1, close: 2 })).toBe(UP_COLOR);
    expect(volumeColor({ open: 2, close: 1 })).toBe(DOWN_COLOR);
  });
});

describe('MA5/MA10/MA20 计算', () => {
  const closes = [1, 2, 3, 4, 5, 6];
  const candles = closes.map((close, i) => candle(`2026-07-2${i}`, close, close));

  it('窗口不足 period 的前期点不输出', () => {
    const ma5 = computeMaSeries(candles, 5);
    expect(ma5.length).toBe(2);
    expect(ma5[0]).toEqual({ time: '2026-07-24', value: 3 });
    expect(ma5[1]).toEqual({ time: '2026-07-25', value: 4 });
  });

  it('period 为 1 时等于收盘价本身', () => {
    const ma1 = computeMaSeries(candles, 1);
    expect(ma1.length).toBe(6);
    expect(ma1[5].value).toBe(6);
  });

  it('candles 少于 period 时输出空序列', () => {
    expect(computeMaSeries(candles, 20)).toEqual([]);
  });

  it('空 candles 输出空序列', () => {
    expect(computeMaSeries([], 5)).toEqual([]);
  });

  it('valueAt 访问器：按 volume 计算均量线', () => {
    const volMa = computeMaSeries(candles, 5, (c) => c.volume);
    expect(volMa.length).toBe(2);
    expect(volMa[0]).toEqual({ time: '2026-07-24', value: 1000 });
  });
});

describe('MACD(12,26,9) 计算', () => {
  const trending = (n, start = 10, step = 0.1) =>
    Array.from({ length: n }, (_, i) =>
      candle(`2026-07-${String(i + 1).padStart(2, '0')}`, 0, start + i * step),
    );

  it('前 slow-2 根不输出，之后每根输出 DIF/DEA/MACD', () => {
    const data = computeMacdSeries(trending(30));
    expect(data).toHaveLength(30 - 25);
    expect(data[0].time).toBe('2026-07-26');
    expect(data.at(-1).time).toBe('2026-07-30');
  });

  it('持续上涨序列 DIF > DEA > 0 且 MACD 柱为正；macd = 2×(dif-dea)', () => {
    const last = computeMacdSeries(trending(60)).at(-1);
    expect(last.dif).toBeGreaterThan(last.dea);
    expect(last.dea).toBeGreaterThan(0);
    expect(last.macd).toBeCloseTo(2 * (last.dif - last.dea));
  });

  it('序列不足 slow 根时返回空', () => {
    expect(computeMacdSeries(trending(20))).toEqual([]);
    expect(computeMacdSeries([])).toEqual([]);
  });
});

describe('分时数据转换', () => {
  const point = (time, price, cumVolume) => ({ time, price, cumVolume, source: 'tencent' });

  it('价格 Line 数据：time 转 Unix 秒', () => {
    expect(toIntradayLineData([point('2026-08-11T01:30:00.000Z', 91.18, 118_900)])).toEqual([
      { time: Math.floor(new Date('2026-08-11T01:30:00.000Z').getTime() / 1000), value: 91.18 },
    ]);
  });

  it('累计量相邻差分衍生逐分钟量；首点保留原值，倒挂取 0；柱色随价格涨跌', () => {
    const data = toIntradayVolumeData([
      point('2026-08-11T01:30:00.000Z', 91.18, 1_000),
      point('2026-08-11T01:31:00.000Z', 91.2, 1_500), // 涨 → 红
      point('2026-08-11T01:32:00.000Z', 91.1, 1_400), // 跌 + 累计倒挂 → 0，绿
    ]);
    expect(data.map((d) => d.value)).toEqual([1_000, 500, 0]);
    expect(data.map((d) => d.color)).toEqual([UP_COLOR, UP_COLOR, DOWN_COLOR]);
  });

  it('cumVolume 缺失 / 非法的点跳过，不产生 NaN 柱', () => {
    const data = toIntradayVolumeData([
      point('2026-08-11T01:30:00.000Z', 91.18, 1_000),
      { time: '2026-08-11T01:31:00.000Z', price: 91.2 }, // 无量 → 跳过
      point('2026-08-11T01:32:00.000Z', 91.1, 1_500),
    ]);
    expect(data).toHaveLength(2);
    expect(data.every((d) => Number.isFinite(d.value))).toBe(true);
  });
});

describe('昨收居中纵轴范围', () => {
  it('以昨收为中心按最大偏离对称展开（0 轴居中），留 8% 边距', () => {
    const range = symmetricRangeAroundBase([3800, 3820, 3810], 3790);
    // 最大偏离 30（3820 - 3790），pad = 30 * 1.08 = 32.4
    expect(range.minValue).toBeCloseTo(3790 - 32.4);
    expect(range.maxValue).toBeCloseTo(3790 + 32.4);
  });

  it('价格等于昨收（零偏离）时用基准千分之一兜底，范围仍对称', () => {
    const range = symmetricRangeAroundBase([3790, 3790], 3790);
    expect(range.minValue).toBeCloseTo(3790 - 3790 * 0.001 * 1.08);
    expect(range.maxValue).toBeCloseTo(3790 + 3790 * 0.001 * 1.08);
  });

  it('base 非法 / 序列为空 → null（调用方退回默认 autoscale）', () => {
    expect(symmetricRangeAroundBase([3800], null)).toBeNull();
    expect(symmetricRangeAroundBase([3800], 0)).toBeNull();
    expect(symmetricRangeAroundBase([3800], -1)).toBeNull();
    expect(symmetricRangeAroundBase([], 3790)).toBeNull();
    expect(symmetricRangeAroundBase([Number.NaN], 3790)).toBeNull();
  });
});

describe('MinuteBar 数据转换', () => {
  const bar = (endedAt, open, close, volume = 1000) => ({
    endedAt,
    open,
    high: Math.max(open, close) + 1,
    low: Math.min(open, close) - 1,
    close,
    volume,
  });

  it('line/candlestick 使用 OHLC 与 bucket end label', () => {
    const bars = [bar('2026-08-11T01:31:00.000Z', 10, 11)];
    const time = Math.floor(new Date(bars[0].endedAt).getTime() / 1000);
    expect(toMinuteLineData(bars)).toEqual([{ time, value: 11 }]);
    expect(toMinuteCandleData(bars)).toEqual([{ time, open: 10, high: 12, low: 9, close: 11 }]);
  });

  it('volume 直接使用 provider bar.volume，不对累计量差分', () => {
    const data = toMinuteVolumeData([
      bar('2026-08-11T01:31:00.000Z', 10, 11, 1200),
      bar('2026-08-11T01:32:00.000Z', 11, 10, 800),
    ]);
    expect(data.map((item) => item.value)).toEqual([1200, 800]);
    expect(data.map((item) => item.color)).toEqual([UP_COLOR, DOWN_COLOR]);
  });
});

describe('关联事实 marker 转换', () => {
  it('按事实语义映射位置、形状和颜色', () => {
    expect(
      toMarkerData([
        {
          date: '2026-07-24',
          factKind: 'trade',
          factId: 'trade-1',
          title: '交易 buy',
          href: '#holdings',
          tone: 'action',
        },
        {
          date: '2026-07-25',
          factKind: 'advice',
          factId: 'advice-1',
          title: 'Advice buy',
          href: '#advice',
          tone: 'advice',
        },
      ]),
    ).toEqual([
      {
        time: '2026-07-24',
        position: 'belowBar',
        shape: 'arrowUp',
        color: UP_COLOR,
        text: '交易 buy',
      },
      {
        time: '2026-07-25',
        position: 'aboveBar',
        shape: 'circle',
        color: '#f5c542',
        text: 'Advice buy',
      },
    ]);
  });
});
