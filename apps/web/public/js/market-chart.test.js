/* apps/web/public/js/market-chart.test.js —— 行情图表纯函数测试（设计 §14.4）。
 * 只测 DOM-free 的转换 / 配色 / MA 计算；createMarketChart 依赖浏览器，
 * 由浏览器验收覆盖。
 */

import { describe, expect, it } from 'bun:test';

import {
  computeMaSeries,
  DOWN_COLOR,
  toCandleData,
  toMarkerData,
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
