// 个股详情日 K 的纯投影：只把 get_stock_market_view 的真实 candles/dataStatus 画成 SVG 几何，
// 不合成缺失交易日、不重算行情指标。放在独立模块是为了让几何能被 Node 单测（组件依赖宿主 React）。

export const CHART_WIDTH = 480;
export const CHART_HEIGHT = 236;

const PLOT_LEFT = 10;
const PLOT_RIGHT = CHART_WIDTH - 58;
const PRICE_TOP = 16;
const PRICE_HEIGHT = 134;
const PRICE_BOTTOM = PRICE_TOP + PRICE_HEIGHT;
const VOLUME_GAP = 18;
const VOLUME_TOP = PRICE_BOTTOM + VOLUME_GAP;
const VOLUME_HEIGHT = 40;
const VOLUME_BOTTOM = VOLUME_TOP + VOLUME_HEIGHT;
const PRICE_TICK_COUNT = 4;

const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
const validCandle = (bar) =>
  isNum(bar?.open) &&
  isNum(bar?.high) &&
  isNum(bar?.low) &&
  isNum(bar?.close) &&
  isNum(bar?.volume) &&
  bar.high >= bar.low &&
  typeof bar.date === 'string' &&
  bar.date.length > 0;

/**
 * 雪球个股详情页地址。雪球用「交易所前缀 + 代码」的 symbol：
 * 600519.SH → SH600519，000001.SZ → SZ000001，430047.BJ → BJ430047。
 * 非规范代码返回 null，不拼一个可能误导的外部链接。
 */
export const xueqiuStockUrl = (stockId) => {
  const matched = /^(\d{6})\.(SH|SZ|BJ)$/.exec(typeof stockId === 'string' ? stockId : '');
  return matched === null ? null : `https://xueqiu.com/S/${matched[2]}${matched[1]}`;
};

const dateLabel = (date) => date.slice(5).replace('-', '/');

const axisTicks = (top, bottom) =>
  Array.from({ length: PRICE_TICK_COUNT }, (_, index) => {
    const value = top - ((top - bottom) * index) / (PRICE_TICK_COUNT - 1);
    return {
      value,
      label: value.toFixed(2),
      y: PRICE_TOP + (PRICE_HEIGHT * index) / (PRICE_TICK_COUNT - 1),
    };
  });

const dateTicks = (candles, xOf) => {
  const last = candles.length - 1;
  const indexes = [...new Set([0, Math.round(last / 3), Math.round((last * 2) / 3), last])];
  return indexes.map((index, position) => ({
    key: candles[index].date,
    x: xOf(index),
    label: dateLabel(candles[index].date),
    anchor: position === 0 ? 'start' : position === indexes.length - 1 ? 'end' : 'middle',
  }));
};

const indicatorFacts = (indicators) =>
  [
    ['MA5', indicators?.ma5],
    ['MA10', indicators?.ma10],
    ['MA20', indicators?.ma20],
    ['MA60', indicators?.ma60],
  ].filter(([, value]) => isNum(value));

/**
 * 日 K 展示模型；无有效 candle 时返回 null（缺日线保持未知，不画空图）。
 */
export function stockKlineModel(marketView) {
  const candles = Array.isArray(marketView?.candles) ? marketView.candles.filter(validCandle) : [];
  if (candles.length === 0) return null;

  const highs = candles.map((bar) => bar.high);
  const lows = candles.map((bar) => bar.low);
  const maxHigh = Math.max(...highs);
  const minLow = Math.min(...lows);
  const padding = Math.max((maxHigh - minLow) * 0.04, 0.01);
  const top = maxHigh + padding;
  const bottom = Math.max(0, minLow - padding);
  const spread = top - bottom || 1;
  const y = (value) => PRICE_TOP + ((top - value) / spread) * PRICE_HEIGHT;

  const maxVolume = Math.max(...candles.map((bar) => bar.volume), 0);
  const slot = (PLOT_RIGHT - PLOT_LEFT) / candles.length;
  const bodyWidth = Math.max(1, Math.min(10, slot * 0.62));
  const xOf = (index) => PLOT_LEFT + (index + 0.5) * slot;

  const bars = candles.map((bar, index) => {
    const x = xOf(index);
    const openY = y(bar.open);
    const closeY = y(bar.close);
    const volumeHeight =
      maxVolume > 0 ? Math.max(0.5, (bar.volume / maxVolume) * VOLUME_HEIGHT) : 0;
    return {
      key: bar.date,
      x,
      bodyX: x - bodyWidth / 2,
      bodyY: Math.min(openY, closeY),
      bodyWidth,
      bodyHeight: Math.max(1, Math.abs(openY - closeY)),
      highY: y(bar.high),
      lowY: y(bar.low),
      volumeY: VOLUME_BOTTOM - volumeHeight,
      volumeHeight,
      up: bar.close >= bar.open,
      live: bar.completeness === 'live',
      title: `${bar.date}：开 ${bar.open}，高 ${bar.high}，低 ${bar.low}，收 ${bar.close}，量 ${bar.volume}；来源 ${bar.source}${bar.completeness === 'live' ? '；未收盘' : ''}`,
    };
  });

  const first = candles[0];
  const last = candles.at(-1);
  const status = marketView?.dataStatus ?? {};
  return {
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    plotLeft: PLOT_LEFT,
    plotRight: PLOT_RIGHT,
    priceTop: PRICE_TOP,
    priceBottom: PRICE_BOTTOM,
    volumeTop: VOLUME_TOP,
    volumeBottom: VOLUME_BOTTOM,
    bars,
    priceTicks: axisTicks(top, bottom),
    dateTicks: dateTicks(candles, xOf),
    lastCloseY: y(last.close),
    lastClose: last.close,
    firstClose: first.close,
    live: last.completeness === 'live',
    range: {
      from: first.date,
      to: last.date,
      count: candles.length,
      high: maxHigh,
      low: minLow,
    },
    indicators: indicatorFacts(marketView?.indicators),
    retrieval: status.retrieval,
    barsAsOf: status.barsAsOf ?? null,
    sources: Array.isArray(status.sources) ? status.sources : [],
    warnings: Array.isArray(status.warnings) ? status.warnings : [],
  };
}

/** 日 K 覆盖警告的展示文案；未知警告只说明保留了上游限制，不放大成结论。 */
export const stockKlineWarning = (warnings) => {
  if (warnings.includes('bars-local-fallback'))
    return '供应商日 K 读取失败，正在展示本地保留日线；数据范围可能不完整。';
  if (warnings.includes('bars-insufficient')) return '日 K 样本不足，区间不完整。';
  if (warnings.includes('bars-truncated')) return '供应商返回的日 K 已被截断，区间可能不完整。';
  if (warnings.length > 0) return '已保留上游给出的市场收盘、来源或覆盖限制。';
  return null;
};
