/* apps/web/public/js/market-chart.js —— 行情页 K 线图表 module（设计 §12）。
 *
 * 唯一允许引用 lightweight-charts 的文件：
 * - 库通过固定版本 URL /vendor/lightweight-charts-5.2.0.mjs 动态 import（§12.1）；
 * - createMarketChart 因此是 async 工厂；
 * - candle → 库数据转换、volume 配色、MA 计算是可独立测试的纯函数，
 *   不 import 第三方类型，market.js 只消费本 module 的纯函数与工厂。
 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

/** 固定版本 vendor URL；升级依赖时与 server.ts 路由、package.json 同步（§12.1）。 */
const LIGHTWEIGHT_CHARTS_URL = '/vendor/lightweight-charts-5.2.0.mjs';

/* A 股红涨绿跌，与 style.css 的 --pos / --neg 同值。 */
const UP_COLOR = '#e0484f';
const DOWN_COLOR = '#0f9d58';
const MA_COLORS = { ma5: '#d97706', ma10: '#3f66d8', ma20: '#9333ea' };

/** volume 柱配色：close >= open 记涨（红），否则跌（绿）（§12.2）。 */
const volumeColor = (candle) => (candle.close >= candle.open ? UP_COLOR : DOWN_COLOR);

/** MarketCandle[] → Candlestick 数据。 */
const toCandleData = (candles) =>
  candles.map((c) => ({ time: c.date, open: c.open, high: c.high, low: c.low, close: c.close }));

/** MarketCandle[] → Volume Histogram 数据（含红绿配色）。 */
const toVolumeData = (candles) =>
  candles.map((c) => ({ time: c.date, value: c.volume, color: volumeColor(c) }));

/**
 * 从 candles 纯计算 MA 序列（§12.2：前端计算仅用于绘制，指标摘要以 Tool 输出为权威）。
 * 窗口不足 period 的前期点不输出。
 * @param {Array<{date: string, close: number}>} candles
 * @param {number} period
 * @returns {Array<{time: string, value: number}>}
 */
const computeMaSeries = (candles, period) => {
  const out = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i += 1) {
    sum += candles[i].close;
    if (i >= period) sum -= candles[i - period].close;
    if (i >= period - 1) out.push({ time: candles[i].date, value: sum / period });
  }
  return out;
};

let libPromise = null;
/** 动态 import 固定 vendor URL；整个页面共享一次加载。 */
const loadLightweightCharts = () => {
  libPromise ??= import(LIGHTWEIGHT_CHARTS_URL);
  return libPromise;
};

/**
 * 创建行情图表：Candlestick 主 pane + MA5/10/20 Line + Volume Histogram 副 pane。
 * @param {HTMLElement} container
 * @param {{ height?: number }} [options]
 * @returns {Promise<{
 *   setData: (data: { candles: Array<object>, ma5: Array<object>, ma10: Array<object>, ma20: Array<object> }) => void,
 *   resize: (width: number, height: number) => void,
 *   destroy: () => void,
 * }>}
 */
const createMarketChart = async (container, options = {}) => {
  const lc = await loadLightweightCharts();
  const height = options.height ?? 360;
  const chart = lc.createChart(container, {
    width: container.clientWidth || 640,
    height,
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: '#76849a',
      attributionLogo: true, // 保留 TradingView attribution（§3.4 NOTICE 要求）
    },
    grid: {
      vertLines: { color: 'rgba(72, 86, 108, 0.1)' },
      horzLines: { color: 'rgba(72, 86, 108, 0.1)' },
    },
    timeScale: { borderColor: 'rgba(72, 86, 108, 0.24)' },
    rightPriceScale: { borderColor: 'rgba(72, 86, 108, 0.24)' },
  });

  const candleSeries = chart.addSeries(lc.CandlestickSeries, {
    upColor: UP_COLOR,
    downColor: DOWN_COLOR,
    borderVisible: false,
    wickUpColor: UP_COLOR,
    wickDownColor: DOWN_COLOR,
  });
  const maSeries = {
    ma5: chart.addSeries(lc.LineSeries, {
      color: MA_COLORS.ma5,
      lineWidth: 1,
      priceLineVisible: false,
    }),
    ma10: chart.addSeries(lc.LineSeries, {
      color: MA_COLORS.ma10,
      lineWidth: 1,
      priceLineVisible: false,
    }),
    ma20: chart.addSeries(lc.LineSeries, {
      color: MA_COLORS.ma20,
      lineWidth: 1,
      priceLineVisible: false,
    }),
  };
  // 副 pane（pane index 1）放成交量。
  const volumeSeries = chart.addSeries(
    lc.HistogramSeries,
    { priceFormat: { type: 'volume' }, priceScaleId: 'volume' },
    1,
  );
  chart.priceScale('volume', 1).applyOptions({ scaleMargins: { top: 0.75, bottom: 0 } });

  const observer = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (entry === undefined) return;
    chart.applyOptions({ width: Math.max(1, Math.floor(entry.contentRect.width)) });
  });
  observer.observe(container);

  return {
    setData({ candles, ma5, ma10, ma20 }) {
      candleSeries.setData(toCandleData(candles));
      maSeries.ma5.setData(ma5);
      maSeries.ma10.setData(ma10);
      maSeries.ma20.setData(ma20);
      volumeSeries.setData(toVolumeData(candles));
      chart.timeScale().fitContent();
    },
    resize(width, nextHeight) {
      chart.applyOptions({
        width: Math.max(1, Math.floor(width)),
        height: Math.max(1, Math.floor(nextHeight)),
      });
    },
    destroy() {
      observer.disconnect();
      chart.remove();
    },
  };
};

export {
  computeMaSeries,
  createMarketChart,
  DOWN_COLOR,
  toCandleData,
  toVolumeData,
  UP_COLOR,
  volumeColor,
};
