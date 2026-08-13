/* apps/web/public/js/market-shared.js —— 行情页纯函数（设计 §11）。
 *
 * hash 解析 / range 归一化 / requestId / 最近查看 / 展示文案，
 * 不触碰 DOM，可被 *.test.js 直接 import；market.js re-export 保持既有导出面。
 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

const MARKET_RANGES = ['1m', '3m', '6m', '1y'];
const MARKET_GRANULARITIES = ['day', 'week', 'month'];

/** hash → { route, params }：? 前为 routeName，后为 URLSearchParams（§11.1）。 */
const parseRouteHash = (hash) => {
  const raw = String(hash ?? '').replace(/^#/, '');
  const qIndex = raw.indexOf('?');
  return {
    route: qIndex === -1 ? raw : raw.slice(0, qIndex),
    params: new URLSearchParams(qIndex === -1 ? '' : raw.slice(qIndex + 1)),
  };
};

/** 行情页深链接序列化（§11.1）；granularity 为 day 时不出现在 hash（默认口径）。 */
const buildMarketHash = (stockId, range, date = null, granularity = 'day') =>
  `market?stockId=${encodeURIComponent(stockId)}&range=${encodeURIComponent(range)}${
    date ? `&date=${encodeURIComponent(date)}` : ''
  }${granularity !== 'day' ? `&granularity=${encodeURIComponent(granularity)}` : ''}`;

/** 业务页面跳行情页的锚点 href：默认 3m，与深链接口径一致。 */
const buildMarketLink = (stockId) => `#${buildMarketHash(stockId, '3m')}`;

/** range 归一化：非法值回退 3m（Tool input 默认口径一致）。 */
const normalizeMarketRange = (raw) => (MARKET_RANGES.includes(raw) ? raw : '3m');

/** granularity 归一化：非法值回退 day（Tool input 默认口径一致）。 */
const normalizeMarketGranularity = (raw) => (MARKET_GRANULARITIES.includes(raw) ? raw : 'day');

/**
 * requestId 跟踪器（§11.4）：每次切换股票 / 周期 / 手动刷新递增；
 * 响应只在 id 仍是当前值时才允许渲染，旧响应不得覆盖新画面。
 */
const createRequestTracker = () => {
  let current = 0;
  return {
    next: () => {
      current += 1;
      return current;
    },
    isCurrent: (id) => id === current,
  };
};

/**
 * 最近查看（§11.5）：按 id 去重置顶，最多 max 条；
 * 调用方保证 item 只含 id/code/name/exchange（不存价格等行情数据）。
 */
const pushRecentView = (list, item, max = 8) =>
  [item, ...list.filter((existing) => existing.id !== item.id)].slice(0, max);

/** 行情来源 → 中文文案（§11.3）。 */
const sourceLabel = (source) => {
  if (source === 'eastmoney') return '东方财富';
  if (source === 'tencent') return '腾讯行情（备用源）';
  return typeof source === 'string' && source.length > 0 ? source : '--';
};

/** Quote 与日线可能来自不同 provider，页面必须展示完整实际来源。 */
const sourceSummary = (sources, quoteSource) => {
  const actual = Array.isArray(sources) && sources.length > 0 ? sources : [quoteSource];
  return [...new Set(actual)].map(sourceLabel).join(' / ');
};

/** marketSession → 中文文案；收盘不是故障（§11.3）。 */
const sessionLabel = (session) => {
  switch (session) {
    case 'pre-open':
      return '盘前';
    case 'trading':
      return '交易中';
    case 'midday-break':
      return '午间休市';
    case 'closed':
      return '已收盘';
    case 'non-trading-day':
      return '非交易日';
    default:
      return '--';
  }
};

/** 获取时间文案：quoteFetchedAt 是抓取时间，只写「行情获取于」（§4.2 缺口 8 / §11.3）。 */
const fetchedAtLabel = (value) => {
  if (value === null || value === undefined) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return `行情获取于 ${date.toLocaleTimeString('zh-CN', { hour12: false })}`;
};

/** 成交量（股）→ 万 / 亿（§11.3）。 */
const formatVolume = (volume) => {
  if (typeof volume !== 'number' || !Number.isFinite(volume)) return '--';
  if (volume >= 1e8) return `${(volume / 1e8).toFixed(2)}亿`;
  if (volume >= 1e4) return `${(volume / 1e4).toFixed(2)}万`;
  return String(volume);
};

/** 成交额（元）→ 万 / 亿（§11.3）。 */
const formatAmount = (amount) => {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '--';
  if (amount >= 1e8) return `${(amount / 1e8).toFixed(2)}亿`;
  if (amount >= 1e4) return `${(amount / 1e4).toFixed(2)}万`;
  return String(amount);
};

/** 涨跌额 / 涨跌幅的配色类：A 股红涨绿跌，沿用 text-pos / text-neg（§11.3）。 */
const changeClass = (change) =>
  typeof change !== 'number' || !Number.isFinite(change) || change === 0
    ? ''
    : change > 0
      ? 'text-pos'
      : 'text-neg';

export {
  buildMarketHash,
  buildMarketLink,
  changeClass,
  createRequestTracker,
  fetchedAtLabel,
  formatAmount,
  formatVolume,
  normalizeMarketGranularity,
  normalizeMarketRange,
  parseRouteHash,
  pushRecentView,
  sessionLabel,
  sourceLabel,
  sourceSummary,
};
