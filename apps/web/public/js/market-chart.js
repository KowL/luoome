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

import { formatVolume } from './market-shared.js';

/** 固定版本 vendor URL；升级依赖时与 server.ts 路由、package.json 同步（§12.1）。 */
const LIGHTWEIGHT_CHARTS_URL = '/vendor/lightweight-charts-5.2.0.mjs';

/* A 股红涨绿跌，与 style.css 的 --pos / --neg 同值。 */
const UP_COLOR = '#e0484f';
const DOWN_COLOR = '#0f9d58';
/* 均线五色与雪球口径一致：MA5 橙 / MA10 蓝 / MA20 紫 / MA30 品红 / MA60 绿。 */
const MA_COLORS = {
  ma5: '#d97706',
  ma10: '#3f66d8',
  ma20: '#9333ea',
  ma30: '#ec4899',
  ma60: '#0f9d58',
};
/* MACD 线色：DIF 橙、DEA 蓝（雪球口径）；柱红正绿负。 */
const MACD_COLORS = { dif: '#d97706', dea: '#3f66d8' };
/** 主图均线定义：[key, 周期, 颜色]，图例与序列共用。 */
const MA_DEFS = [
  ['ma5', 5, MA_COLORS.ma5],
  ['ma10', 10, MA_COLORS.ma10],
  ['ma20', 20, MA_COLORS.ma20],
  ['ma30', 30, MA_COLORS.ma30],
  ['ma60', 60, MA_COLORS.ma60],
];

/** volume 柱配色：close >= open 记涨（红），否则跌（绿）（§12.2）。 */
const volumeColor = (candle) => (candle.close >= candle.open ? UP_COLOR : DOWN_COLOR);

/** MarketCandle[] → Candlestick 数据。 */
const toCandleData = (candles) =>
  candles.map((c) => ({ time: c.date, open: c.open, high: c.high, low: c.low, close: c.close }));

/** MarketCandle[] → Volume Histogram 数据（含红绿配色）。 */
const toVolumeData = (candles) =>
  candles.map((c) => ({ time: c.date, value: c.volume, color: volumeColor(c) }));

/** MarketFactMarker[] → Lightweight Charts series markers. */
const toMarkerData = (markers) =>
  markers.map((marker) => ({
    time: marker.date,
    position: marker.tone === 'action' ? 'belowBar' : 'aboveBar',
    shape: marker.tone === 'action' ? 'arrowUp' : marker.tone === 'advice' ? 'circle' : 'square',
    color: marker.tone === 'action' ? UP_COLOR : marker.tone === 'advice' ? '#f5c542' : '#5ea8ff',
    text: marker.title.slice(0, 24),
  }));

/** 分时点 → 价格 Line 数据（time 为 Unix 秒；p.time 来自 JSON 是 ISO 字符串）。 */
const toIntradayLineData = (points) =>
  points.map((p) => ({ time: Math.floor(new Date(p.time).getTime() / 1000), value: p.price }));

/**
 * 分时点 → 逐分钟成交量 Histogram 数据：cumVolume 是当日累计口径，
 * 相邻差分衍生逐分钟量（首点保留原值，倒挂取 0）；柱色随价格涨跌（红涨绿跌）。
 * cumVolume 缺失 / 非法的点跳过（量额对指数是辅助口径，缺失不拖垮价格线）。
 */
const toIntradayVolumeData = (points) =>
  points.flatMap((p, i) => {
    if (typeof p.cumVolume !== 'number' || !Number.isFinite(p.cumVolume)) return [];
    const prev = points[i - 1];
    const prevVolume =
      typeof prev?.cumVolume === 'number' && Number.isFinite(prev.cumVolume)
        ? prev.cumVolume
        : undefined;
    return [
      {
        time: Math.floor(new Date(p.time).getTime() / 1000),
        value: prevVolume === undefined ? p.cumVolume : Math.max(0, p.cumVolume - prevVolume),
        color: prev === undefined || p.price >= prev.price ? UP_COLOR : DOWN_COLOR,
      },
    ];
  });

/** MinuteBar[] → 分时收盘价 Line 数据。 */
const toMinuteLineData = (bars) =>
  bars.map((bar) => ({
    time: Math.floor(new Date(bar.endedAt).getTime() / 1000),
    value: bar.close,
  }));

/**
 * 昨收基准居中的纵轴范围：以 base 为中心按最大偏离对称展开（0 轴居中），留 8% 边距；
 * base 非法或序列为空返回 null（调用方退回默认 autoscale）。
 */
const symmetricRangeAroundBase = (values, base) => {
  if (typeof base !== 'number' || !Number.isFinite(base) || base <= 0) return null;
  const clean = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (clean.length === 0) return null;
  const deviation = Math.max(...clean.map((v) => Math.abs(v - base)));
  const pad = (deviation === 0 ? base * 0.001 : deviation) * 1.08;
  return { minValue: base - pad, maxValue: base + pad };
};

/** MinuteBar[] → 分钟 Candlestick 数据。 */
const toMinuteCandleData = (bars) =>
  bars.map((bar) => ({
    time: Math.floor(new Date(bar.endedAt).getTime() / 1000),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
  }));

/** MinuteBar[] → 原生逐桶成交量；不对累计量做猜测性差分。 */
const toMinuteVolumeData = (bars) =>
  bars.map((bar) => ({
    time: Math.floor(new Date(bar.endedAt).getTime() / 1000),
    value: bar.volume,
    color: bar.close >= bar.open ? UP_COLOR : DOWN_COLOR,
  }));

/**
 * 从 candles 纯计算 MA 序列（§12.2：前端计算仅用于绘制，指标摘要以 Tool 输出为权威）。
 * 窗口不足 period 的前期点不输出；valueAt 可取 volume 等字段算均量线。
 * @param {Array<{date: string, close: number}>} candles
 * @param {number} period
 * @param {(candle: object) => number} [valueAt]
 * @returns {Array<{time: string, value: number}>}
 */
const computeMaSeries = (candles, period, valueAt = (candle) => candle.close) => {
  const out = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i += 1) {
    sum += valueAt(candles[i]);
    if (i >= period) sum -= valueAt(candles[i - period]);
    if (i >= period - 1) out.push({ time: candles[i].date, value: sum / period });
  }
  return out;
};

/**
 * MACD(fast,slow,signal)：DIF = EMA(fast) - EMA(slow)，DEA = DIF 的 EMA(signal)，
 * 柱 = 2×(DIF-DEA)（A 股口径）。EMA 以首根 close 为种子；
 * 前 slow-2 根 DIF 未收敛不输出，序列不足时返回空。
 */
const computeMacdSeries = (candles, fast = 12, slow = 26, signal = 9) => {
  const ema = (prev, value, period) => (prev * (period - 1) + value * 2) / (period + 1);
  let emaFast = null;
  let emaSlow = null;
  let dea = null;
  const out = [];
  for (let i = 0; i < candles.length; i += 1) {
    const close = candles[i].close;
    emaFast = emaFast === null ? close : ema(emaFast, close, fast);
    emaSlow = emaSlow === null ? close : ema(emaSlow, close, slow);
    const dif = emaFast - emaSlow;
    dea = dea === null ? dif : ema(dea, dif, signal);
    if (i >= slow - 1) {
      out.push({ time: candles[i].date, dif, dea, macd: 2 * (dif - dea) });
    }
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
 * 创建行情图表（雪球式三 pane 布局）：
 * - pane 0：Candlestick + MA5/10/20/30/60，图例「均线 MA5:… …」
 * - pane 1：成交量 Histogram + MA5/MA10 均量线，图例「成交量 … MA5:… MA10:…」
 * - pane 2：MACD(12,26,9) DIF/DEA 双线 + 柱（红正绿负），图例带 DIF/DEA/MACD 值
 * 图例默认显示末根 K 线值，十字线悬停时跟随当前 K 线。
 * setMarkers 供「策略信号」开关单独切换标注，无需整图 setData。
 * @param {HTMLElement} container
 * @param {{ height?: number }} [options]
 * @returns {Promise<{
 *   setData: (data: { candles: Array<object>, markers?: Array<object> }) => void,
 *   setMarkers: (markers: Array<object>) => void,
 *   resize: (width: number, height: number) => void,
 *   destroy: () => void,
 * }>}
 */
const createMarketChart = async (container, options = {}) => {
  const lc = await loadLightweightCharts();
  const height = options.height ?? 520;
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
    timeScale: {
      borderColor: 'rgba(72, 86, 108, 0.24)',
      // 拖动边界锁定在数据范围内，左右不留空白
      fixLeftEdge: true,
      fixRightEdge: true,
    },
    rightPriceScale: { borderColor: 'rgba(72, 86, 108, 0.24)' },
  });

  const candleSeries = chart.addSeries(lc.CandlestickSeries, {
    upColor: UP_COLOR,
    downColor: DOWN_COLOR,
    borderVisible: false,
    wickUpColor: UP_COLOR,
    wickDownColor: DOWN_COLOR,
    // 不标注当前价：右轴最新价标签与价格虚线都关闭
    priceLineVisible: false,
    lastValueVisible: false,
  });
  const maSeries = {};
  for (const [key, , color] of MA_DEFS) {
    maSeries[key] = chart.addSeries(lc.LineSeries, {
      color,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
  }
  // pane 1：成交量 + 均量线（共用 volume 价格轴）。
  const volumeSeries = chart.addSeries(
    lc.HistogramSeries,
    { priceFormat: { type: 'volume' }, priceScaleId: 'volume', lastValueVisible: false },
    1,
  );
  chart.priceScale('volume', 1).applyOptions({ scaleMargins: { top: 0.1, bottom: 0 } });
  const volumeMaSeries = {
    ma5: chart.addSeries(
      lc.LineSeries,
      {
        color: MA_COLORS.ma5,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        priceScaleId: 'volume',
      },
      1,
    ),
    ma10: chart.addSeries(
      lc.LineSeries,
      {
        color: MA_COLORS.ma10,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        priceScaleId: 'volume',
      },
      1,
    ),
  };
  // pane 2：MACD 双线 + 柱，共用 pane 2 默认价格轴。
  const difSeries = chart.addSeries(
    lc.LineSeries,
    { color: MACD_COLORS.dif, lineWidth: 1, priceLineVisible: false, lastValueVisible: false },
    2,
  );
  const deaSeries = chart.addSeries(
    lc.LineSeries,
    { color: MACD_COLORS.dea, lineWidth: 1, priceLineVisible: false, lastValueVisible: false },
    2,
  );
  const macdSeries = chart.addSeries(lc.HistogramSeries, { lastValueVisible: false }, 2);

  // pane 高度比例：主图 5 / 成交量 2 / MACD 2。
  chart.panes()[0]?.setStretchFactor(5);
  chart.panes()[1]?.setStretchFactor(2);
  chart.panes()[2]?.setStretchFactor(2);

  const markerApi = lc.createSeriesMarkers(candleSeries, []);

  /* ---- 各 pane 左上角图例 ---- */
  const makeLegend = () => {
    const node = document.createElement('div');
    node.className = 'chart-legend';
    container.append(node);
    return node;
  };
  const legendPanes = [makeLegend(), makeLegend(), makeLegend()];
  const legendSpan = (parent, text = '', color = '') => {
    const node = document.createElement('span');
    if (text !== '') node.textContent = text;
    if (color !== '') node.style.color = color;
    parent.append(node);
    return node;
  };

  legendSpan(legendPanes[0], '均线', 'var(--muted)');
  const maLegendSpans = {};
  for (const [key, , color] of MA_DEFS) {
    maLegendSpans[key] = legendSpan(legendPanes[0], '', color);
  }
  legendSpan(legendPanes[1], '成交量', 'var(--muted)');
  const volumeLegendValue = legendSpan(legendPanes[1]);
  const volumeMa5Span = legendSpan(legendPanes[1], '', MA_COLORS.ma5);
  const volumeMa10Span = legendSpan(legendPanes[1], '', MA_COLORS.ma10);
  legendSpan(legendPanes[2], 'MACD(12,26,9)', 'var(--muted)');
  const difSpan = legendSpan(legendPanes[2], '', MACD_COLORS.dif);
  const deaSpan = legendSpan(legendPanes[2], '', MACD_COLORS.dea);
  const macdSpan = legendSpan(legendPanes[2]);

  const fmtPrice = (value) => value.toFixed(2);
  const setValueSpan = (node, prefix, value, fmt) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      node.hidden = false;
      node.textContent = prefix === '' ? fmt(value) : `${prefix}:${fmt(value)}`;
    } else {
      node.hidden = true;
    }
  };

  const applyLegendValues = (values) => {
    for (const [key] of MA_DEFS) {
      setValueSpan(maLegendSpans[key], key.toUpperCase(), values.ma?.[key], fmtPrice);
    }
    setValueSpan(volumeLegendValue, '', values.volume, formatVolume);
    setValueSpan(volumeMa5Span, 'MA5', values.volumeMa5, formatVolume);
    setValueSpan(volumeMa10Span, 'MA10', values.volumeMa10, formatVolume);
    setValueSpan(difSpan, 'DIF', values.dif, fmtPrice);
    setValueSpan(deaSpan, 'DEA', values.dea, fmtPrice);
    setValueSpan(macdSpan, 'MACD', values.macd, fmtPrice);
    if (typeof values.macd === 'number' && Number.isFinite(values.macd)) {
      macdSpan.style.color = values.macd >= 0 ? UP_COLOR : DOWN_COLOR;
    }
  };

  /** 图例对齐各 pane 顶边（pane 高度在布局后才可读）。 */
  const layoutLegends = () => {
    const panes = chart.panes();
    let top = 0;
    panes.forEach((pane, index) => {
      const legend = legendPanes[index];
      if (legend !== undefined) legend.style.top = `${top + 4}px`;
      top += pane.getHeight();
    });
  };
  requestAnimationFrame(layoutLegends);

  let lastValues = null;
  chart.subscribeCrosshairMove((param) => {
    if (param?.time === undefined) {
      if (lastValues !== null) applyLegendValues(lastValues);
      return;
    }
    const data = param.seriesData;
    applyLegendValues({
      ma: Object.fromEntries(MA_DEFS.map(([key]) => [key, data.get(maSeries[key])?.value])),
      volume: data.get(volumeSeries)?.value,
      volumeMa5: data.get(volumeMaSeries.ma5)?.value,
      volumeMa10: data.get(volumeMaSeries.ma10)?.value,
      dif: data.get(difSeries)?.value,
      dea: data.get(deaSeries)?.value,
      macd: data.get(macdSeries)?.value,
    });
  });

  const observer = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (entry === undefined) return;
    chart.applyOptions({ width: Math.max(1, Math.floor(entry.contentRect.width)) });
    layoutLegends();
  });
  observer.observe(container);

  return {
    setData({ candles, markers = [] }) {
      const maData = Object.fromEntries(
        MA_DEFS.map(([key, period]) => [key, computeMaSeries(candles, period)]),
      );
      const volumeMa5Data = computeMaSeries(candles, 5, (candle) => candle.volume);
      const volumeMa10Data = computeMaSeries(candles, 10, (candle) => candle.volume);
      const macdData = computeMacdSeries(candles);
      candleSeries.setData(toCandleData(candles));
      for (const [key] of MA_DEFS) maSeries[key].setData(maData[key]);
      volumeSeries.setData(toVolumeData(candles));
      volumeMaSeries.ma5.setData(volumeMa5Data);
      volumeMaSeries.ma10.setData(volumeMa10Data);
      difSeries.setData(macdData.map((d) => ({ time: d.time, value: d.dif })));
      deaSeries.setData(macdData.map((d) => ({ time: d.time, value: d.dea })));
      macdSeries.setData(
        macdData.map((d) => ({
          time: d.time,
          value: d.macd,
          color: d.macd >= 0 ? UP_COLOR : DOWN_COLOR,
        })),
      );
      markerApi.setMarkers(toMarkerData(markers));
      chart.timeScale().fitContent();
      const lastMacd = macdData.at(-1);
      lastValues = {
        ma: Object.fromEntries(MA_DEFS.map(([key]) => [key, maData[key].at(-1)?.value])),
        volume: candles.at(-1)?.volume,
        volumeMa5: volumeMa5Data.at(-1)?.value,
        volumeMa10: volumeMa10Data.at(-1)?.value,
        dif: lastMacd?.dif,
        dea: lastMacd?.dea,
        macd: lastMacd?.macd,
      };
      applyLegendValues(lastValues);
      layoutLegends();
    },
    setMarkers(markers) {
      markerApi.setMarkers(toMarkerData(markers));
    },
    resize(width, nextHeight) {
      chart.applyOptions({
        width: Math.max(1, Math.floor(width)),
        height: Math.max(1, Math.floor(nextHeight)),
      });
      layoutLegends();
    },
    destroy() {
      observer.disconnect();
      for (const legend of legendPanes) legend.remove();
      chart.remove();
    },
  };
};

/**
 * 创建分时图：价格 Line 主 pane + 逐分钟成交量 Histogram 副 pane（pane 1）。
 * 输入是 fetch_intraday_minutes 的累计口径分钟点，量在工厂内差分衍生。
 * setData 传入 basePrice（昨收）时叠加基准虚线并把纵轴以基准为中心对称（0 轴居中）。
 * @param {HTMLElement} container
 * @param {{ height?: number }} [options]
 * @returns {Promise<{
 *   setData: (points: Array<object>, basePrice?: number | null) => void,
 *   resize: (width: number, height: number) => void,
 *   destroy: () => void,
 * }>}
 */
const createIntradayChart = async (container, options = {}) => {
  const lc = await loadLightweightCharts();
  const chart = lc.createChart(container, {
    width: container.clientWidth || 640,
    height: options.height ?? 360,
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: '#76849a',
      attributionLogo: true, // 保留 TradingView attribution（§3.4 NOTICE 要求）
    },
    grid: {
      vertLines: { color: 'rgba(72, 86, 108, 0.1)' },
      horzLines: { color: 'rgba(72, 86, 108, 0.1)' },
    },
    timeScale: {
      borderColor: 'rgba(72, 86, 108, 0.24)',
      timeVisible: true,
      secondsVisible: false,
      // 拖动边界锁定在数据范围内，左右不留空白
      fixLeftEdge: true,
      fixRightEdge: true,
    },
    // 边距归零：昨收居中的对称范围由 autoscaleInfoProvider 提供（自带 8% 边距），
    // 默认 scaleMargins（上 0.2 / 下 0.1）不对称，会把基准线推离 pane 中点。
    rightPriceScale: {
      borderColor: 'rgba(72, 86, 108, 0.24)',
      scaleMargins: { top: 0, bottom: 0 },
    },
  });

  let basePrice = null;
  let latestValues = [];
  let baseLine = null;
  const priceSeries = chart.addSeries(lc.LineSeries, {
    color: '#3f66d8',
    lineWidth: 2,
    autoscaleInfoProvider: (original) => {
      const info = original();
      if (info === null || basePrice === null) return info;
      const range = symmetricRangeAroundBase(latestValues, basePrice);
      return range === null ? info : { priceRange: range, margins: { above: 0, below: 0 } };
    },
  });
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
    setData(points, base = null) {
      basePrice = typeof base === 'number' && Number.isFinite(base) && base > 0 ? base : null;
      latestValues = points.map((p) => p.price);
      priceSeries.setData(toIntradayLineData(points));
      if (baseLine !== null) {
        priceSeries.removePriceLine(baseLine);
        baseLine = null;
      }
      if (basePrice !== null) {
        baseLine = priceSeries.createPriceLine({
          price: basePrice,
          color: '#76849a',
          lineWidth: 1,
          lineStyle: lc.LineStyle.Dashed,
          axisLabelVisible: true,
          title: '昨收',
        });
      }
      volumeSeries.setData(toIntradayVolumeData(points));
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

/**
 * 创建生产 MinuteBar 图：分时模式使用 close Line，分钟 K 模式使用原生 OHLC Candlestick；
 * 两者的成交量都直接消费 MinuteBar.volume。
 */
const createMinuteBarChart = async (container, mode = 'line') => {
  const lc = await loadLightweightCharts();
  const chart = lc.createChart(container, {
    width: container.clientWidth || 640,
    height: 360,
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: '#76849a',
      attributionLogo: true,
    },
    grid: {
      vertLines: { color: 'rgba(72, 86, 108, 0.1)' },
      horzLines: { color: 'rgba(72, 86, 108, 0.1)' },
    },
    timeScale: {
      borderColor: 'rgba(72, 86, 108, 0.24)',
      timeVisible: true,
      secondsVisible: false,
      // 拖动边界锁定在数据范围内，左右不留空白
      fixLeftEdge: true,
      fixRightEdge: true,
    },
    rightPriceScale: { borderColor: 'rgba(72, 86, 108, 0.24)' },
  });
  const priceSeries =
    mode === 'candlestick'
      ? chart.addSeries(lc.CandlestickSeries, {
          upColor: UP_COLOR,
          downColor: DOWN_COLOR,
          borderVisible: false,
          wickUpColor: UP_COLOR,
          wickDownColor: DOWN_COLOR,
        })
      : chart.addSeries(lc.LineSeries, { color: '#3f66d8', lineWidth: 2 });
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
    setData(bars) {
      priceSeries.setData(
        mode === 'candlestick' ? toMinuteCandleData(bars) : toMinuteLineData(bars),
      );
      volumeSeries.setData(toMinuteVolumeData(bars));
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
  computeMacdSeries,
  computeMaSeries,
  createIntradayChart,
  createMarketChart,
  createMinuteBarChart,
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
};
