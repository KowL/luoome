/* apps/web/public/js/indices.js —— 指数页渲染器（#indices 路由）。
 *
 * 设计要点（参考 finance-workbench MarketIndices.tsx）：
 * - 顶部 6 大指数卡片（index-defs.js INDEX_DEFS，渲染与看盘页共用 index-strip.js），
 *   点击卡片切换下方分时图；数据缺失时卡片值 '--'（不隐藏卡片结构）
 * - 分时图复用 market-chart.js 的 createIntradayChart（与行情页同一图表组件模块）：
 *   昨收基准虚线 + 以昨收为中心的对称纵轴（0 轴居中），时间轴由图表自绘
 *   （不画均价线：指数的 cumAmount/cumVolume 是全市场累计口径，相除不是指数点位，无意义）
 * - 数据：卡片走 /api/market/indices（invokeIndexQuotes 15s 缓存），
 *   分时走 /api/market/indices/intraday?code=（fetch_intraday_minutes tool）
 * - 10s 定时刷新（页面隐藏时跳过）；离开路由由 app.js 调 teardownIndices 清理
 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import { INDEX_DEFS } from './index-defs.js';
import { renderIndexCards } from './index-strip.js';
import { createIntradayChart } from './market-chart.js';
import { formatAmount } from './market-shared.js';
import { $, el, fmtNum, fmtSigned, mount } from './ui.js';

const REFRESH_MS = 10_000;
/** 与 style.css 的 .indices-chart 高度一致。 */
const CHART_HEIGHT = 280;

let selectedCode = INDEX_DEFS[0].code;
let refreshTimer = null;
let latestQuotes = null;
let intradayChart = null;
let chartPromise = null;
/** 图表创建 in-flight 期间的失效令牌：占位 / teardown 时递增，使晚到的创建结果自毁。 */
let chartEpoch = 0;

const selectedIndexFromHash = (hash = window.location.hash) => {
  const code = new URLSearchParams(hash.split('?')[1] ?? '').get('code');
  return INDEX_DEFS.some((def) => def.code === code) ? code : INDEX_DEFS[0].code;
};

/* ---- 纯函数（indices.test.js 直接单测） ---- */

/**
 * 分时点序列 → 绘图模型。preClose 为昨收（quote 缺时为 null，基准退化为首分钟价）。
 * points 是过滤后的有效价格点（分时图与明细共用）；纵轴居中由 createIntradayChart 负责。
 */
const buildIntradayModel = (points, preClose) => {
  const clean = (Array.isArray(points) ? points : []).filter(
    (p) => typeof p?.price === 'number' && Number.isFinite(p.price) && p.price > 0,
  );
  if (clean.length === 0) return null;
  const prices = clean.map((p) => p.price);
  const base =
    typeof preClose === 'number' && Number.isFinite(preClose) && preClose > 0
      ? preClose
      : prices[0];
  const last = clean.at(-1);
  return {
    points: clean,
    prices,
    base,
    open: prices[0],
    high: Math.max(...prices),
    low: Math.min(...prices),
    lastPrice: prices.at(-1),
    lastVolume: typeof last.cumVolume === 'number' ? last.cumVolume : null,
    lastAmount: typeof last?.cumAmount === 'number' ? last.cumAmount : null,
  };
};

/** 指数快照 → 昨收（close - change）；无快照返回 null。 */
const prevCloseOf = (quote) =>
  quote !== null && quote !== undefined && typeof quote.close === 'number'
    ? quote.close - (quote.change ?? 0)
    : null;

/* ---- 分时图生命周期 ---- */

const destroyChart = () => {
  chartEpoch += 1;
  if (intradayChart !== null) {
    intradayChart.destroy();
    intradayChart = null;
  }
};

/** 懒创建分时图（并发复用同一 promise）；晚到结果在占位 / 离开路由后自毁。 */
const ensureChart = (container) => {
  if (intradayChart !== null) return Promise.resolve(intradayChart);
  if (chartPromise !== null) return chartPromise;
  const epoch = chartEpoch;
  container.replaceChildren();
  chartPromise = createIntradayChart(container, { height: CHART_HEIGHT }).then((chart) => {
    chartPromise = null;
    if (epoch !== chartEpoch || $('#route-indices')?.hidden !== false) {
      chart.destroy();
      return null;
    }
    intradayChart = chart;
    return intradayChart;
  });
  return chartPromise;
};

/* ---- 页面渲染 ---- */

const quoteByCode = (code) => {
  const list = Array.isArray(latestQuotes?.indices) ? latestQuotes.indices : [];
  return list.find((idx) => String(idx.code) === code) ?? null;
};

const renderCards = () => {
  renderIndexCards('indices-cards', INDEX_DEFS, latestQuotes, {
    selectedCode,
    onSelect: (code) => {
      if (code === selectedCode) return;
      selectedCode = code;
      renderCards();
      void renderChart();
    },
  });
};

const detailCell = (label, value, cls = '') =>
  el('div', 'indices-detail-cell', [
    el('div', 'label', label),
    el('div', `value mono ${cls}`.trim(), value),
  ]);

const renderDetail = (model, quote) => {
  const wrap = $('#indices-detail');
  if (wrap === null) return;
  if (model === null) {
    mount(wrap, []);
    return;
  }
  const base = model.base;
  const openCls = model.open >= base ? 'text-pos' : 'text-neg';
  mount(wrap, [
    detailCell('今开', fmtNum(model.open), openCls),
    detailCell('最高', fmtNum(model.high), 'text-pos'),
    detailCell('最低', fmtNum(model.low), 'text-neg'),
    detailCell('昨收', quote !== null ? fmtNum(prevCloseOf(quote)) : `${fmtNum(model.base)}*`),
    detailCell('成交量', model.lastVolume === null ? '--' : formatAmount(model.lastVolume)),
    detailCell('成交额', model.lastAmount === null ? '--' : formatAmount(model.lastAmount)),
  ]);
};

const renderChart = async () => {
  const def = INDEX_DEFS.find((d) => d.code === selectedCode) ?? INDEX_DEFS[0];
  const quote = quoteByCode(def.code);
  const chartWrap = $('#indices-chart');
  if (chartWrap === null) return;

  $('#indices-chart-title').textContent = `${def.name} 分时走势`;
  const priceNode = $('#indices-price');
  const changeNode = $('#indices-change');
  if (quote !== null) {
    const cls = quote.change > 0 ? 'text-pos' : quote.change < 0 ? 'text-neg' : '';
    priceNode.textContent = fmtNum(quote.close);
    priceNode.className = `indices-price mono ${cls}`;
    changeNode.textContent = `${fmtSigned(quote.change)}（${fmtSigned(quote.changePct)}%）`;
    changeNode.className = `indices-change mono ${cls}`;
  } else {
    priceNode.textContent = '--';
    changeNode.textContent = '--';
  }

  const showPlaceholder = (text) => {
    destroyChart();
    mount(chartWrap, el('p', 'placeholder', text));
  };

  const meta = $('#indices-chart-meta');
  if (def.intradayStockId === null) {
    if (meta !== null) meta.textContent = `${def.code} · 该指数暂无分时数据`;
    showPlaceholder('该指数暂无分时数据。');
    renderDetail(null, quote);
    return;
  }

  const r = await callApi(`/api/market/indices/intraday?code=${encodeURIComponent(def.code)}`);
  if (!r.ok) {
    if (meta !== null) meta.textContent = `${def.code} · 加载失败`;
    showPlaceholder(`分时数据加载失败（${r.error?.kind ?? 'internal'}）。`);
    renderDetail(null, quote);
    return;
  }
  const model = buildIntradayModel(r.data?.points ?? [], prevCloseOf(quote));
  if (model === null) {
    const reason =
      r.data?.supported === false ? '数据源不支持分时' : '盘前 / 非交易日 / 上游不可用';
    if (meta !== null) meta.textContent = `${def.code} · 暂无分时数据`;
    showPlaceholder(`暂无分时数据（${reason}）。`);
    renderDetail(null, quote);
    return;
  }

  if (meta !== null) {
    const parts = [`${def.code} · 实时分时`];
    if (r.data?.date !== undefined) parts.push(String(r.data.date));
    if (quote === null) parts.push('基准=首分钟价（快照不可用）');
    meta.textContent = parts.join(' · ');
  }
  const chart = await ensureChart(chartWrap);
  if (chart === null) return;
  chart.setData(model.points, model.base);
  renderDetail(model, quote);
};

const refreshAll = async () => {
  const r = await callApi('/api/market/indices');
  if (r.ok) latestQuotes = r.data;
  renderCards();
  await renderChart();
};

const renderIndicesPage = async (setStatus) => {
  const root = $('#route-indices');
  if (root === null) return;
  selectedCode = selectedIndexFromHash();
  try {
    await refreshAll();
  } catch (error) {
    setStatus(`指数页加载失败：${error instanceof Error ? error.message : String(error)}`, true);
  }
  if (refreshTimer !== null) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    void refreshAll();
  }, REFRESH_MS);
};

const teardownIndices = () => {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  destroyChart();
};

export { buildIntradayModel, prevCloseOf, renderIndicesPage, teardownIndices };
