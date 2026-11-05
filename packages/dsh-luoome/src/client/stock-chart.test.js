// 个股详情日 K 投影的纯几何断言：组件依赖宿主 React，本仓渲染不出来，几何与外部链接在这里测。
import { describe, expect, it } from 'vitest';

import {
  CHART_HEIGHT,
  CHART_WIDTH,
  stockKlineModel,
  stockKlineWarning,
  xueqiuStockUrl,
} from './stock-chart.js';

const candle = (date, open, high, low, close, volume, extra = {}) => ({
  date,
  open,
  high,
  low,
  close,
  volume,
  source: 'fixture',
  completeness: 'closed',
  ...extra,
});

const marketView = (candles, indicators = {}) => ({
  candles,
  indicators,
  dataStatus: {
    retrieval: 'live',
    barsAsOf: '2026-10-28',
    sources: ['eastmoney'],
    warnings: [],
  },
});

describe('xueqiuStockUrl', () => {
  it('把规范股票代码映射为雪球交易所前缀 symbol', () => {
    expect(xueqiuStockUrl('600519.SH')).toBe('https://xueqiu.com/S/SH600519');
    expect(xueqiuStockUrl('000001.SZ')).toBe('https://xueqiu.com/S/SZ000001');
    expect(xueqiuStockUrl('430047.BJ')).toBe('https://xueqiu.com/S/BJ430047');
  });

  it('非规范代码不拼外部链接', () => {
    for (const value of [undefined, null, '', '600519', '600519.hk', 'AAPL', 'SH600519'])
      expect(xueqiuStockUrl(value)).toBeNull();
  });
});

describe('stockKlineModel', () => {
  const candles = [
    candle('2026-10-26', 1500, 1520, 1490, 1510, 1000),
    candle('2026-10-27', 1510, 1530, 1500, 1520, 2000),
    candle('2026-10-28', 1520, 1560, 1510, 1540, 4000, { completeness: 'live' }),
  ];

  it('无有效日线时返回 null，不画空图', () => {
    expect(stockKlineModel(null)).toBeNull();
    expect(stockKlineModel({ candles: [] })).toBeNull();
    expect(stockKlineModel(marketView([candle('2026-10-26', 1, 1, 2, 1, 0)]))).toBeNull();
  });

  it('几何落在价格区与成交量区内，最后一根用虚线收盘', () => {
    const model = stockKlineModel(marketView(candles, { ma5: 1520 }));
    expect(model.width).toBe(CHART_WIDTH);
    expect(model.height).toBe(CHART_HEIGHT);
    expect(model.bars).toHaveLength(3);
    for (const bar of model.bars) {
      expect(bar.x).toBeGreaterThan(model.plotLeft);
      expect(bar.x).toBeLessThan(model.plotRight);
      expect(bar.highY).toBeGreaterThanOrEqual(model.priceTop);
      expect(bar.lowY).toBeLessThanOrEqual(model.priceBottom);
      expect(bar.volumeY).toBeGreaterThanOrEqual(model.volumeTop);
      expect(bar.volumeY + bar.volumeHeight).toBeLessThanOrEqual(model.volumeBottom);
    }
    expect(model.bars[0].x).toBeLessThan(model.bars.at(-1).x);
    expect(model.bars.at(-1).live).toBe(true);
    expect(model.live).toBe(true);
    expect(model.lastCloseY).toBeGreaterThan(model.priceTop);
    expect(model.lastCloseY).toBeLessThan(model.priceBottom);
    expect(model.bars.at(-1).volumeHeight).toBeCloseTo(model.volumeBottom - model.volumeTop, 5);
  });

  it('价格刻度自上而下、区间事实来自这组真实日线', () => {
    const model = stockKlineModel(marketView(candles));
    expect(model.priceTicks).toHaveLength(4);
    expect(model.priceTicks[0].y).toBe(model.priceTop);
    expect(model.priceTicks.at(-1).y).toBe(model.priceBottom);
    expect(model.priceTicks[0].value).toBeGreaterThan(model.priceTicks.at(-1).value);
    expect(model.priceTicks.every((tick) => /^\d+\.\d{2}$/.test(tick.label))).toBe(true);
    expect(model.range).toMatchObject({
      from: '2026-10-26',
      to: '2026-10-28',
      count: 3,
      high: 1560,
      low: 1490,
    });
    expect(model.firstClose).toBe(1510);
    expect(model.lastClose).toBe(1540);
  });

  it('日期刻度用区间首中尾，标签只保留月日', () => {
    const model = stockKlineModel(marketView(candles));
    expect(model.dateTicks.map((tick) => tick.label)).toEqual(['10/26', '10/27', '10/28']);
    expect(model.dateTicks[0].anchor).toBe('start');
    expect(model.dateTicks.at(-1).anchor).toBe('end');
  });

  it('均线只展示工具给出的有限值，未知不补', () => {
    expect(stockKlineModel(marketView(candles)).indicators).toEqual([]);
    expect(
      stockKlineModel(marketView(candles, { ma5: 1520, ma10: Number.NaN, ma20: 1505 })).indicators,
    ).toEqual([
      ['MA5', 1520],
      ['MA20', 1505],
    ]);
  });

  it('保留来源、截止日与警告，实时标记未收盘', () => {
    const model = stockKlineModel({
      ...marketView(candles),
      dataStatus: {
        retrieval: 'local-fallback',
        barsAsOf: null,
        sources: ['xueqiu'],
        warnings: ['bars-local-fallback'],
      },
    });
    expect(model.retrieval).toBe('local-fallback');
    expect(model.barsAsOf).toBeNull();
    expect(model.sources).toEqual(['xueqiu']);
    expect(model.warnings).toEqual(['bars-local-fallback']);
    expect(model.bars.at(-1).title).toContain('未收盘');
  });
});

describe('stockKlineWarning', () => {
  it('按警告种类给出具体覆盖说明', () => {
    expect(stockKlineWarning([])).toBeNull();
    expect(stockKlineWarning(['bars-local-fallback'])).toContain('本地保留日线');
    expect(stockKlineWarning(['bars-insufficient'])).toContain('样本不足');
    expect(stockKlineWarning(['bars-truncated'])).toContain('截断');
  });

  it('未知警告只保留上游限制，不放大成结论', () => {
    expect(stockKlineWarning(['market-closed', 'provider-fallback'])).toContain('覆盖限制');
  });
});
