/* apps/web/public/js/market.js —— 行情页（docs/ddd/stock-market-view-detailed-design.md §11）。
 *
 * 数据只来自 POST /api/tools/get_stock_market_view/call 与 GET /api/stocks/search；
 * 页面不复制行情派生逻辑。图表实现全部在 market-chart.js，
 * 本文件不出现任何 lightweight-charts 类型。
 *
 * 纯函数在 market-shared.js、报价卡 / 指标在 market-quote.js、关联事实在
 * market-facts.js；本文件 re-export 保持既有导出面不变（market.test.js 直接 import）。
 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import { renderIndexStrip } from './index-strip.js';
import { createMarketChart, createMinuteBarChart } from './market-chart.js';
import { renderLimitUpFacts, renderMarkers } from './market-facts.js';
import {
  renderIndicators,
  renderLinks,
  renderQuoteHeader,
  resetQuoteHeader,
} from './market-quote.js';
import { renderMarketSentiment } from './market-sentiment.js';
import {
  buildMarketHash,
  createRequestTracker,
  normalizeMarketGranularity,
  normalizeMarketRange,
  parseRouteHash,
  pushRecentView,
} from './market-shared.js';
import { createStockSearchBox } from './search-box.js';
import { $, el, mount } from './ui.js';

/* ============ 页面状态（§11.4） ============ */

const RECENT_KEY = 'luoome.market.recent';
const REFRESH_ACTIVE_MS = 60_000;
const REFRESH_IDLE_MS = 300_000;
const EMPTY_TIP = '搜索并选择一只股票查看行情；支持深链接 #market?stockId=002594.SZ&range=3m。';

const state = {
  stockId: null,
  range: '3m',
  date: null,
  granularity: 'day',
  tracker: createRequestTracker(),
  data: null,
  chart: null,
  chartTab: 'kline',
  minuteInterval: '1m',
  minuteData: null,
  minuteChart: null,
  minuteChartMode: null,
  minuteTracker: createRequestTracker(),
  refreshTimer: null,
  bound: false,
  /** 「策略信号」开关：true 时 K 线图上叠加策略/Advice/交易标注（§11 关联事实）。 */
  showMarkers: false,
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

const destroyIntradayChart = () => {
  if (state.minuteChart !== null) {
    state.minuteChart.destroy();
    state.minuteChart = null;
    state.minuteChartMode = null;
  }
};

/** 离开行情页：停 timer、销毁图表、重置选中（§11.4）。 */
const teardownMarket = () => {
  clearRefreshTimer();
  destroyChart();
  destroyIntradayChart();
  state.stockId = null;
  state.data = null;
  state.date = null;
  state.granularity = 'day';
  state.chartTab = 'kline';
  state.minuteInterval = '1m';
  state.minuteData = null;
  state.tracker.next();
  state.minuteTracker.next();
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
  window.location.hash = buildMarketHash(stock.id, state.range, state.date, state.granularity);
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

/* ============ 加载与渲染 ============ */

/** 行情页顶部指数条：与 dashboard 共用 index-strip；失败静默（指数条只是辅助信息）。 */
const loadMarketIndices = async () => {
  const r = await callApi('/api/market/indices');
  if (!r.ok) return;
  renderIndexStrip('market-indices', r.data, null);
};

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
    window.location.hash = buildMarketHash(state.stockId, range, state.date, state.granularity);
  });
};

/* ============ 图表周期 tab（雪球式单排：分时 / 日K / 周K / 月K / 60分…1分） ============ */

/** 当前激活 tab：intraday=分时；kline 用粒度（day/week/month）；minute-k 用分钟间隔。 */
const activeChartTab = () => {
  if (state.chartTab === 'intraday') return 'intraday';
  if (state.chartTab === 'minute-k') return state.minuteInterval;
  return state.granularity;
};

/** 「策略信号」开关：切换 K 线图上的关联事实标注，默认关闭。 */
const paintMarkerToggle = () => {
  const toggle = $('#market-marker-toggle');
  if (toggle === null) return;
  toggle.classList.toggle('active', state.showMarkers);
  toggle.setAttribute('aria-pressed', String(state.showMarkers));
};

const applyMarkerVisibility = () => {
  state.chart?.setMarkers(state.showMarkers ? (state.data?.markers ?? []) : []);
};

const bindMarkerToggle = () => {
  const toggle = $('#market-marker-toggle');
  if (toggle === null || toggle.dataset.bound === '1') return;
  toggle.dataset.bound = '1';
  toggle.addEventListener('click', () => {
    state.showMarkers = !state.showMarkers;
    paintMarkerToggle();
    applyMarkerVisibility();
  });
};

/* ============ 独立 MinuteBar：分时 / 分钟 K，共用真实 raw OHLCV 与状态账本 ============ */

const MINUTE_WARNING_LABELS = {
  'unsupported-capability': '未配置分钟行情源',
  'provider-error': '分钟源请求失败',
  'no-data': '分钟源无数据',
  'local-fallback': '使用本地留存',
  'historical-provider-unavailable': '远端仅支持当日',
  'session-in-progress': '交易时段尚未结束',
  'gaps-detected': '序列存在缺口',
  'outside-trading-session': '已剔除非交易时段桶',
  'mixed-provider-date': '已剔除混合日期/周期',
  'source-date-mismatch': '来源日期与请求不一致',
};

const minuteStatusLabel = (status) =>
  status === 'complete' ? '完整' : status === 'partial' ? '部分可用' : '不可用';

const renderMinuteStatus = (data) => {
  const wrap = $('#market-minute-status');
  if (wrap === null) return;
  wrap.dataset.status = data?.status ?? 'unavailable';
  const warnings = Array.isArray(data?.warnings)
    ? data.warnings.map((warning) => MINUTE_WARNING_LABELS[warning] ?? warning)
    : [];
  const detail =
    data?.status === 'unavailable'
      ? warnings.join(' · ') || '没有可展示的分钟 OHLCV；Quote 与日 K 不受影响。'
      : `${data.date ?? '--'} · ${data.bars?.length ?? 0} 根 · ${warnings.join(' · ') || '未检测到内部缺口'}`;
  mount(wrap, [
    el('strong', '', `分钟数据 ${minuteStatusLabel(data?.status)}`),
    el('span', '', detail),
    el(
      'span',
      'minute-status-meta',
      `${data?.sources?.join('/') || '--'} · RAW · 留存 ${data?.retentionDays ?? 30} 天`,
    ),
  ]);
};

const paintChartTabs = () => {
  const onKline = state.chartTab === 'kline';
  const active = activeChartTab();
  const tabs = $('#market-chart-tabs');
  if (tabs !== null) {
    tabs.querySelectorAll('button[data-chart-tab]').forEach((node) => {
      node.classList.toggle('active', node.getAttribute('data-chart-tab') === active);
    });
  }
  // range 只对 K 线粒度有意义（分钟 tab 固定当日序列）
  const rangeSwitch = $('#market-range-switch');
  if (rangeSwitch !== null) rangeSwitch.hidden = !onKline;
  const intradayWrap = $('#market-intraday-chart');
  const minuteHasBars = Array.isArray(state.minuteData?.bars) && state.minuteData.bars.length > 0;
  if (intradayWrap !== null) intradayWrap.hidden = onKline || !minuteHasBars;
  const minuteStatus = $('#market-minute-status');
  if (minuteStatus !== null) minuteStatus.hidden = onKline;
  const klineWrap = $('#market-chart');
  const klineEmpty = $('#market-chart-empty');
  if (!onKline) {
    if (klineWrap !== null) klineWrap.hidden = true;
    if (klineEmpty !== null) klineEmpty.hidden = true;
  } else {
    // K 线可见性以 chart 是否存在为准（与 renderData 同口径）
    const hasChart = state.chart !== null;
    if (klineWrap !== null) klineWrap.hidden = !hasChart;
    if (klineEmpty !== null) klineEmpty.hidden = hasChart;
  }
};

const bindChartTabs = () => {
  const wrap = $('#market-chart-tabs');
  if (wrap === null || wrap.dataset.bound === '1') return;
  wrap.dataset.bound = '1';
  wrap.addEventListener('click', (event) => {
    const target =
      event.target instanceof Element ? event.target.closest('button[data-chart-tab]') : null;
    if (target === null || state.stockId === null) return;
    const tab = target.getAttribute('data-chart-tab');
    if (tab === null || tab === activeChartTab()) return;
    if (tab === 'day' || tab === 'week' || tab === 'month') {
      // K 线粒度走深链接（与 range 切换同口径），hashchange 驱动重载；
      // hash 未变（粒度本就是它）时直接用既有 K 线数据，无需重拉。
      state.chartTab = 'kline';
      destroyIntradayChart();
      paintChartTabs();
      window.location.hash = buildMarketHash(state.stockId, state.range, state.date, tab);
      return;
    }
    state.chartTab = tab === 'intraday' ? 'intraday' : 'minute-k';
    state.minuteInterval = tab === 'intraday' ? '1m' : tab;
    state.minuteData = null;
    destroyIntradayChart();
    paintChartTabs();
    void loadIntradayView();
  });
};

/** 拉独立 MinuteBar；unavailable / partial 仍保留 tab 并展示事实状态。 */
const loadIntradayView = async () => {
  if (state.stockId === null) return;
  const requestId = state.minuteTracker.next();
  const r = await callApi('/api/tools/get_stock_minute_bars/call', {
    method: 'POST',
    body: JSON.stringify({
      input: {
        stockId: state.stockId,
        interval: state.minuteInterval,
        ...(state.date === null ? {} : { date: state.date }),
      },
    }),
    timeoutMs: 30_000,
  });
  if (!state.minuteTracker.isCurrent(requestId)) return;
  state.minuteData =
    r.ok && r.data !== undefined
      ? r.data
      : {
          status: 'unavailable',
          bars: [],
          sources: [],
          warnings: ['provider-error'],
          retentionDays: 30,
        };
  renderMinuteStatus(state.minuteData);
  paintChartTabs();
  if (!Array.isArray(state.minuteData.bars) || state.minuteData.bars.length === 0) {
    destroyIntradayChart();
    paintChartTabs();
    return;
  }
  const mode = state.chartTab === 'minute-k' ? 'candlestick' : 'line';
  if (state.minuteChart === null || state.minuteChartMode !== mode) {
    destroyIntradayChart();
    const container = $('#market-intraday-chart');
    if (container === null) return;
    const chart = await createMinuteBarChart(container, mode);
    const { route } = parseRouteHash(window.location.hash);
    if (!state.minuteTracker.isCurrent(requestId) || route !== 'market') {
      chart.destroy();
      return;
    }
    state.minuteChart = chart;
    state.minuteChartMode = mode;
  }
  state.minuteChart.setData(state.minuteData.bars);
  paintChartTabs();
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
  // 无 bars 不建空 chart（§11.3）；K 线 / 分时 / 空态可见性统一由 paintChartTabs 按 chartTab 决定。
  if (!Array.isArray(data.candles) || data.candles.length === 0) {
    destroyChart();
    paintChartTabs();
    return;
  }
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
    markers: state.showMarkers ? (data.markers ?? []) : [],
  });
  paintChartTabs();
};

/** 轮询间隔分档：盘中（含午间休市）60s，盘外 300s 降频。 */
const refreshIntervalMs = () => {
  const session = state.data?.dataStatus?.marketSession;
  return session === 'trading' || session === 'midday-break' ? REFRESH_ACTIVE_MS : REFRESH_IDLE_MS;
};

const scheduleRefresh = (requestId) => {
  clearRefreshTimer();
  state.refreshTimer = setTimeout(() => {
    state.refreshTimer = null;
    // 页面隐藏时暂停刷新（§11.4）；恢复可见由 visibilitychange 立即补一次。
    if (document.visibilityState !== 'visible') return;
    if (!state.tracker.isCurrent(requestId)) return;
    void loadMarketView();
  }, refreshIntervalMs());
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
          granularity: state.granularity,
          ...(state.date === null ? {} : { date: state.date }),
        }
      : {
          stockId: state.stockId,
          range: state.range,
          granularity: state.granularity,
          stockName: known.name,
          ...(state.date === null ? {} : { date: state.date }),
        };
  const r = await callApi('/api/tools/get_stock_market_view/call', {
    method: 'POST',
    body: JSON.stringify({ input }),
    timeoutMs: 30_000,
  });
  if (!state.tracker.isCurrent(requestId)) return;
  if (r.ok && r.data !== undefined) {
    state.data = r.data;
    showBanner(null);
    await renderData(r.data, requestId);
    if (state.chartTab === 'intraday' || state.chartTab === 'minute-k') {
      void loadIntradayView();
    }
  } else {
    // 网络 / 上游错误：保留上一份成功画面 + error banner，不清图（§11.4）。
    const kind = r.error?.kind ?? 'internal';
    const message =
      kind === 'adapter_error'
        ? '行情源暂不可用'
        : kind === 'timeout'
          ? '请求超时，稍后自动重试'
          : (r.error?.message ?? `行情加载失败（${kind}）`);
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
        // 只改占位文案，不清空 #market-empty 子树（#market-sentiment 要留给情绪面板）
        const tip = $('#market-empty-tip');
        if (tip !== null) tip.textContent = `${message}，请稍后重试。`;
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
  bindChartTabs();
  bindMarkerToggle();
  bindVisibility();
  renderRecent();
  void loadMarketIndices();
  const { params } = parseRouteHash(window.location.hash);
  const stockId = params.get('stockId');
  const range = normalizeMarketRange(params.get('range'));
  const granularity = normalizeMarketGranularity(params.get('granularity'));
  const rawDate = params.get('date');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate ?? '') ? rawDate : null;
  // 无 stockId → 搜索空态（§11.1）。
  if (stockId === null || stockId.trim().length === 0) {
    clearRefreshTimer();
    destroyChart();
    destroyIntradayChart();
    state.stockId = null;
    state.date = null;
    state.data = null;
    state.granularity = 'day';
    state.chartTab = 'kline';
    state.minuteInterval = '1m';
    state.minuteData = null;
    state.tracker.next();
    state.minuteTracker.next();
    showBanner(null);
    resetQuoteHeader();
    const empty = $('#market-empty');
    const main = $('#market-main');
    if (empty !== null) empty.hidden = false;
    const tip = $('#market-empty-tip');
    if (tip !== null) tip.textContent = EMPTY_TIP;
    if (main !== null) main.hidden = true;
    void renderMarketSentiment();
    return;
  }
  const changed =
    state.stockId !== stockId ||
    state.range !== range ||
    state.date !== date ||
    state.granularity !== granularity;
  state.stockId = stockId;
  state.range = range;
  state.date = date;
  state.granularity = granularity;
  if (!changed && state.data !== null) {
    paintRangeSwitch();
    paintChartTabs();
    return;
  }
  state.data = null;
  destroyChart();
  destroyIntradayChart();
  // 换股：在途分时 fetch 作废，tab 状态回到 K 线（对齐空态分支 / teardown）
  state.minuteTracker.next();
  state.chartTab = 'kline';
  state.minuteInterval = '1m';
  state.minuteData = null;
  setStatus?.(`加载 ${stockId} 行情…`);
  await loadMarketView();
};

export { markerLabel, renderMarkers } from './market-facts.js';
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
} from './market-shared.js';
export { navigateToStock, renderMarket, teardownMarket };
