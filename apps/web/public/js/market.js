/* apps/web/public/js/market.js —— 行情页（docs/ddd/stock-market-view-detailed-design.md §11）。
 *
 * 数据只来自 POST /api/tools/get_stock_market_view/call 与 GET /api/stocks/search；
 * 页面不复制行情派生逻辑。图表实现全部在 market-chart.js，
 * 本文件不出现任何 lightweight-charts 类型。
 *
 * 顶部纯函数（hash 解析 / range 归一化 / requestId / 最近查看 / 展示文案）
 * 不触碰 DOM，可被 *.test.js 直接 import。
 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import { computeMaSeries, createMarketChart } from './market-chart.js';
import { createStockSearchBox } from './search-box.js';
import { $, el, fmtNum, fmtPct, fmtSigned, mount } from './ui.js';

/* ============ 纯函数（可独立测试） ============ */

const MARKET_RANGES = ['1m', '3m', '6m', '1y'];

/** hash → { route, params }：? 前为 routeName，后为 URLSearchParams（§11.1）。 */
const parseRouteHash = (hash) => {
  const raw = String(hash ?? '').replace(/^#/, '');
  const qIndex = raw.indexOf('?');
  return {
    route: qIndex === -1 ? raw : raw.slice(0, qIndex),
    params: new URLSearchParams(qIndex === -1 ? '' : raw.slice(qIndex + 1)),
  };
};

/** 行情页深链接序列化（§11.1）。 */
const buildMarketHash = (stockId, range, date = null) =>
  `market?stockId=${encodeURIComponent(stockId)}&range=${encodeURIComponent(range)}${
    date ? `&date=${encodeURIComponent(date)}` : ''
  }`;

/** 业务页面跳行情页的锚点 href：默认 3m，与深链接口径一致。 */
const buildMarketLink = (stockId) => `#${buildMarketHash(stockId, '3m')}`;

/** range 归一化：非法值回退 3m（Tool input 默认口径一致）。 */
const normalizeMarketRange = (raw) => (MARKET_RANGES.includes(raw) ? raw : '3m');

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

/** 涨跌额 / 涨跌幅的配色类：A 股红涨绿跌，沿用 text-pos / text-neg（§11.3）。 */
const changeClass = (change) =>
  typeof change !== 'number' || !Number.isFinite(change) || change === 0
    ? ''
    : change > 0
      ? 'text-pos'
      : 'text-neg';

/* ============ 页面状态（§11.4） ============ */

const RECENT_KEY = 'luoome.market.recent';
const REFRESH_MS = 60_000;

const state = {
  stockId: null,
  range: '3m',
  date: null,
  tracker: createRequestTracker(),
  data: null,
  chart: null,
  refreshTimer: null,
  bound: false,
};

const loadRecent = () => {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const saveRecent = (list) => {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* 隐私模式 / quota：忽略 */
  }
};

const clearRefreshTimer = () => {
  if (state.refreshTimer !== null) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }
};

const destroyChart = () => {
  if (state.chart !== null) {
    state.chart.destroy();
    state.chart = null;
  }
};

/** 离开行情页：停 timer、销毁图表、重置选中（§11.4）。 */
const teardownMarket = () => {
  clearRefreshTimer();
  destroyChart();
  state.stockId = null;
  state.data = null;
  state.date = null;
  state.tracker.next();
};

/* ============ 搜索（§11.5）：交互在 search-box.js，本页只提供去向 ============ */

/** 写最近查看并跳转行情深链接；行情页换股票与仪表盘搜索共用此入口。 */
const navigateToStock = (stock) => {
  const recent = pushRecentView(loadRecent(), {
    id: stock.id,
    code: stock.code,
    name: stock.name,
    exchange: stock.exchange,
  });
  saveRecent(recent);
  window.location.hash = buildMarketHash(stock.id, state.range, state.date);
};

const bindSearch = () => {
  const wrap = $('#market-search');
  if (wrap === null) return;
  createStockSearchBox(wrap, { onSelect: (stock) => navigateToStock(stock) });
};

const renderRecent = () => {
  const wrap = $('#market-recent');
  if (wrap === null) return;
  const recent = loadRecent();
  if (recent.length === 0) {
    mount(wrap, null);
    return;
  }
  mount(
    wrap,
    el('div', 'market-recent-row', [
      el('span', 'muted', '最近查看'),
      ...recent.map((s) => {
        const chip = el('button', 'market-recent-chip', `${s.code} ${s.name}`);
        chip.type = 'button';
        chip.addEventListener('click', () => navigateToStock(s));
        return chip;
      }),
    ]),
  );
};

/* ============ 报价头 / 指标 / 关联入口（§11.2 / §11.3） ============ */

const setText = (id, text, className) => {
  const node = $(id);
  if (node === null) return;
  node.textContent = text;
  if (className !== undefined) node.className = className;
};

const renderQuoteHeader = (data) => {
  const { stock, quote, dataStatus } = data;
  setText('#market-quote-name', stock.name);
  setText('#market-quote-code', `${stock.id} · ${stock.exchange}`);
  setText(
    '#market-quote-price',
    fmtNum(quote.quote.close),
    `market-quote-price ${changeClass(quote.change)}`,
  );
  setText('#market-quote-change', fmtSigned(quote.change), changeClass(quote.change));
  setText('#market-quote-change-pct', fmtPct(quote.changePct), changeClass(quote.change));
  setText('#market-quote-open', fmtNum(quote.quote.open), 'num');
  setText('#market-quote-high', fmtNum(quote.quote.high), 'num');
  setText('#market-quote-low', fmtNum(quote.quote.low), 'num');
  setText(
    '#market-quote-prev',
    quote.previousClose === null ? '--' : fmtNum(quote.previousClose),
    'num',
  );
  setText('#market-quote-volume', formatVolume(quote.quote.volume), 'num');
  setText('#market-quote-fetched', fetchedAtLabel(dataStatus.quoteFetchedAt));
  setText('#market-quote-source', sourceSummary(dataStatus.sources, quote.quote.source));

  const badges = $('#market-quote-badges');
  if (badges !== null) {
    const items = [el('span', 'badge badge-session', sessionLabel(dataStatus.marketSession))];
    if (dataStatus.retrieval === 'local-fallback') {
      items.push(el('span', 'badge badge-amber', '旧快照'));
    }
    if (dataStatus.warnings.includes('provider-fallback')) {
      items.push(el('span', 'badge badge-amber', '含备用行情源'));
    }
    mount(badges, items);
  }
};

const QUOTE_PLACEHOLDER_IDS = [
  '#market-quote-name',
  '#market-quote-code',
  '#market-quote-open',
  '#market-quote-high',
  '#market-quote-low',
  '#market-quote-prev',
  '#market-quote-volume',
  '#market-quote-fetched',
  '#market-quote-source',
];

/** 报价卡常驻后，无股票 / 加载失败时清掉上一只股票残留的数据。 */
const resetQuoteHeader = () => {
  for (const id of QUOTE_PLACEHOLDER_IDS) setText(id, '--');
  setText('#market-quote-price', '--', 'market-quote-price');
  setText('#market-quote-change', '--');
  setText('#market-quote-change-pct', '--');
  const badges = $('#market-quote-badges');
  if (badges !== null) mount(badges, null);
};

const INDICATOR_ROWS = [
  { label: 'RSI14', value: (i) => fmtNum(i.rsi14) },
  { label: 'MACD DIF', value: (i) => fmtNum(i.macdDif) },
  { label: 'MACD DEA', value: (i) => fmtNum(i.macdDea) },
  { label: 'MACD HIST', value: (i) => fmtNum(i.macdHist) },
  // BOLL 预留：Tool 当前 indicators 不含 boll 字段时一律 --（以 Tool 输出为权威）。
  { label: 'BOLL 上轨', value: (i) => fmtNum(i.bollUpper) },
  { label: 'BOLL 中轨', value: (i) => fmtNum(i.bollMid) },
  { label: 'BOLL 下轨', value: (i) => fmtNum(i.bollLower) },
  { label: '20 日最高', value: (i) => fmtNum(i.high20) },
  { label: '20 日最低', value: (i) => fmtNum(i.low20) },
  { label: '成交量比', value: (i) => fmtNum(i.volRatio5_20) },
];

const renderIndicators = (data) => {
  const wrap = $('#market-indicators');
  if (wrap === null) return;
  mount(
    wrap,
    INDICATOR_ROWS.map((row) =>
      el('div', 'market-indicator', [
        el('div', 'label', row.label),
        el('div', 'value', row.value(data.indicators ?? {})),
      ]),
    ),
  );
  setText(
    '#market-indicators-meta',
    data.indicatorsAsOf === null ? '样本不足' : `截至 ${data.indicatorsAsOf}`,
  );
};

const renderLinks = (data) => {
  const wrap = $('#market-links');
  if (wrap === null) return;
  const id = encodeURIComponent(data.stock.id);
  const links = [
    { href: `#research?stockId=${id}`, label: '查看研究' },
    { href: `#advice?stockId=${id}`, label: '查看 Advice' },
    { href: `#holdings?stockId=${id}`, label: '持仓定位' },
  ];
  mount(
    wrap,
    links.map((l) => {
      const a = el('a', 'btn btn-outline btn-sm', l.label);
      a.setAttribute('href', l.href);
      return a;
    }),
  );
};

const markerLabel = (marker) => {
  const kind =
    marker.factKind === 'trade'
      ? '交易'
      : marker.factKind === 'advice'
        ? 'Advice'
        : marker.factKind === 'watch-trigger'
          ? '触发'
          : marker.factKind === 'strategy-signal'
            ? '信号'
            : marker.factKind === 'report'
              ? '报告'
              : marker.factKind === 'limit-up'
                ? '涨停'
                : '研究';
  return `${marker.date} · ${kind} · ${marker.title}`;
};

const renderLimitUpFacts = (data) => {
  const wrap = $('#market-limit-up');
  if (wrap === null) return;
  const facts = data.limitUp;
  if (facts === undefined || facts.status === 'unavailable') {
    mount(wrap, el('span', 'muted', '历史天梯不可用；未将不可用伪装成空结果。'));
    setText('#market-limit-up-status', '不可用');
    return;
  }
  setText(
    '#market-limit-up-status',
    facts.asOf === null
      ? '可用 · 时间未知'
      : `可用 · ${new Date(facts.asOf).toLocaleDateString('zh-CN')}`,
  );
  mount(
    wrap,
    facts.recent.length === 0
      ? el('span', 'muted', '可获得范围内暂无涨停记录')
      : el(
          'div',
          'market-limit-up-list',
          facts.recent.map((item) =>
            el('div', 'market-limit-up-row', [
              el('span', 'mono', item.date),
              el('strong', null, `${item.ladderLevel} 连板`),
              el('span', 'muted', item.reason === '--' ? '原因暂缺' : item.reason),
            ]),
          ),
        ),
  );
};

const renderMarkers = (data) => {
  const wrap = $('#market-markers');
  if (wrap === null) return;
  const markers = Array.isArray(data.markers) ? data.markers : [];
  mount(
    wrap,
    markers.length === 0
      ? el('span', 'muted', '当前周期暂无关联事实')
      : [
          el('span', 'muted', '图表事实：'),
          ...markers.map((marker) => {
            const link = el('a', `market-marker market-marker-${marker.tone}`, markerLabel(marker));
            link.setAttribute('href', marker.href);
            link.dataset.factId = marker.factId;
            return link;
          }),
        ],
  );
};

/* ============ 加载与渲染 ============ */

const showBanner = (message) => {
  const banner = $('#market-banner');
  if (banner === null) return;
  if (message === null) {
    banner.hidden = true;
    banner.textContent = '';
  } else {
    banner.textContent = message;
    banner.hidden = false;
  }
};

const paintRangeSwitch = () => {
  const wrap = $('#market-range-switch');
  if (wrap === null) return;
  wrap.querySelectorAll('button[data-range]').forEach((node) => {
    node.classList.toggle('active', node.getAttribute('data-range') === state.range);
  });
};

const bindRangeSwitch = () => {
  const wrap = $('#market-range-switch');
  if (wrap === null || wrap.dataset.bound === '1') return;
  wrap.dataset.bound = '1';
  wrap.addEventListener('click', (event) => {
    const target =
      event.target instanceof Element ? event.target.closest('button[data-range]') : null;
    if (target === null || state.stockId === null) return;
    const range = normalizeMarketRange(target.getAttribute('data-range'));
    if (range === state.range) return;
    window.location.hash = buildMarketHash(state.stockId, range, state.date);
  });
};

const renderData = async (data, requestId) => {
  const main = $('#market-main');
  const empty = $('#market-empty');
  if (main === null || empty === null) return;
  empty.hidden = true;
  main.hidden = false;
  renderQuoteHeader(data);
  renderIndicators(data);
  renderLinks(data);
  renderMarkers(data);
  renderLimitUpFacts(data);
  paintRangeSwitch();

  const chartContainer = $('#market-chart');
  const chartEmpty = $('#market-chart-empty');
  if (chartContainer === null || chartEmpty === null) return;
  // 无 bars 不建空 chart（§11.3）。
  if (!Array.isArray(data.candles) || data.candles.length === 0) {
    destroyChart();
    chartContainer.hidden = true;
    chartEmpty.hidden = false;
    return;
  }
  chartContainer.hidden = false;
  chartEmpty.hidden = true;
  if (state.chart === null) {
    const chart = await createMarketChart(chartContainer);
    const { route } = parseRouteHash(window.location.hash);
    if (!state.tracker.isCurrent(requestId) || route !== 'market') {
      chart.destroy();
      return;
    }
    state.chart = chart;
  }
  if (!state.tracker.isCurrent(requestId) || state.chart === null) return;
  state.chart.setData({
    candles: data.candles,
    ma5: computeMaSeries(data.candles, 5),
    ma10: computeMaSeries(data.candles, 10),
    ma20: computeMaSeries(data.candles, 20),
    markers: data.markers ?? [],
  });
};

const scheduleRefresh = (requestId) => {
  clearRefreshTimer();
  state.refreshTimer = setTimeout(() => {
    state.refreshTimer = null;
    // 页面隐藏时暂停刷新（§11.4）；恢复可见由 visibilitychange 立即补一次。
    if (document.visibilityState !== 'visible') return;
    if (!state.tracker.isCurrent(requestId)) return;
    void loadMarketView();
  }, REFRESH_MS);
};

const bindVisibility = () => {
  if (state.bound) return;
  state.bound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (state.stockId === null || state.data === null) return;
    const { route } = parseRouteHash(window.location.hash);
    if (route !== 'market') return;
    void loadMarketView();
  });
};

/** 拉取行情并渲染；失败时保留上一份成功画面（§11.4）。 */
const loadMarketView = async () => {
  if (state.stockId === null) return;
  const requestId = state.tracker.next();
  // 搜索候选/最近查看里已知名称时带上 stockName，tool 侧据此登记/补全真实名称（§7 约定）。
  const known = loadRecent().find((s) => s.id === state.stockId);
  const input =
    known === undefined
      ? {
          stockId: state.stockId,
          range: state.range,
          ...(state.date === null ? {} : { date: state.date }),
        }
      : {
          stockId: state.stockId,
          range: state.range,
          stockName: known.name,
          ...(state.date === null ? {} : { date: state.date }),
        };
  const r = await callApi('/api/tools/get_stock_market_view/call', {
    method: 'POST',
    body: JSON.stringify({ input }),
  });
  if (!state.tracker.isCurrent(requestId)) return;
  if (r.ok && r.data !== undefined) {
    state.data = r.data;
    showBanner(null);
    await renderData(r.data, requestId);
  } else {
    // 网络 / 上游错误：保留上一份成功画面 + error banner，不清图（§11.4）。
    const kind = r.error?.kind ?? 'internal';
    const message =
      kind === 'adapter_error' ? '行情源暂不可用' : (r.error?.message ?? `行情加载失败（${kind}）`);
    if (state.data !== null) {
      showBanner(`${message}，展示上次成功数据。`);
    } else {
      showBanner(message);
      destroyChart();
      resetQuoteHeader();
      const empty = $('#market-empty');
      const main = $('#market-main');
      if (empty !== null) {
        empty.hidden = false;
        empty.textContent = '';
        empty.append(el('p', 'placeholder', `${message}，请稍后重试。`));
      }
      if (main !== null) main.hidden = true;
    }
  }
  scheduleRefresh(requestId);
};

/** 路由入口：app.js 在 #market（含深链接参数变化）时调用。 */
const renderMarket = async (setStatus) => {
  bindSearch();
  bindRangeSwitch();
  bindVisibility();
  renderRecent();
  const { params } = parseRouteHash(window.location.hash);
  const stockId = params.get('stockId');
  const range = normalizeMarketRange(params.get('range'));
  const rawDate = params.get('date');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate ?? '') ? rawDate : null;
  // 无 stockId → 搜索空态（§11.1）。
  if (stockId === null || stockId.trim().length === 0) {
    clearRefreshTimer();
    destroyChart();
    state.stockId = null;
    state.date = null;
    state.data = null;
    state.tracker.next();
    showBanner(null);
    resetQuoteHeader();
    const empty = $('#market-empty');
    const main = $('#market-main');
    if (empty !== null) empty.hidden = false;
    if (main !== null) main.hidden = true;
    return;
  }
  const changed = state.stockId !== stockId || state.range !== range || state.date !== date;
  state.stockId = stockId;
  state.range = range;
  state.date = date;
  if (!changed && state.data !== null) {
    paintRangeSwitch();
    return;
  }
  state.data = null;
  destroyChart();
  setStatus?.(`加载 ${stockId} 行情…`);
  await loadMarketView();
};

export {
  buildMarketHash,
  buildMarketLink,
  changeClass,
  createRequestTracker,
  fetchedAtLabel,
  formatVolume,
  markerLabel,
  navigateToStock,
  normalizeMarketRange,
  parseRouteHash,
  pushRecentView,
  renderMarkers,
  renderMarket,
  sessionLabel,
  sourceLabel,
  sourceSummary,
  teardownMarket,
};
