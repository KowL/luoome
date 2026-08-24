/* apps/web/public/js/indices.js —— 指数页渲染器（#indices 路由）。
 *
 * 设计要点（参考 finance-workbench MarketIndices.tsx）：
 * - 顶部 6 大指数卡片（index-defs.js INDEX_DEFS，渲染与看盘页共用 index-strip.js），
 *   点击卡片切换下方分时图；数据缺失时卡片值 '--'（不隐藏卡片结构）
 * - 分时图为原生 SVG（零新依赖）：价格线 + 昨收基准虚线 + 面积渐变
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
import { formatAmount } from './market-shared.js';
import { $, el, fmtNum, fmtSigned, mount } from './ui.js';

const REFRESH_MS = 10_000;
const SVG_NS = 'http://www.w3.org/2000/svg';

let selectedCode = INDEX_DEFS[0].code;
let refreshTimer = null;
let latestQuotes = null;

/* ---- 纯函数（indices.test.js 直接单测） ---- */

/* 分时点的 time 是 UTC ISO（如 '2026-08-21T01:31:00.000Z'，来自 tool 层归一化），
 * 显示统一换算到交易所时区 Asia/Shanghai，避免随本机时区漂移。 */
const fmtHhmm = (d) => {
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Shanghai',
  });
};

/**
 * 分时点序列 → 绘图模型。preClose 为昨收（quote 缺时为 null，基准线退化为首分钟价）。
 * 纵轴范围只由价格与基准决定（cumVolume/cumAmount 仅用于明细，不参与绘图）。
 */
const buildIntradayModel = (points, preClose) => {
  const clean = (Array.isArray(points) ? points : []).filter(
    (p) => typeof p?.price === 'number' && Number.isFinite(p.price) && p.price > 0,
  );
  if (clean.length === 0) return null;
  const labels = clean.map((p) => fmtHhmm(p.time));
  const prices = clean.map((p) => p.price);
  const base =
    typeof preClose === 'number' && Number.isFinite(preClose) && preClose > 0
      ? preClose
      : prices[0];
  const allValues = [...prices, base];
  const pad = Math.abs(base) * 0.001 || 1;
  const min = Math.min(...allValues) - pad;
  const max = Math.max(...allValues) + pad;
  const last = clean.at(-1);
  return {
    labels,
    prices,
    base,
    min,
    max,
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

/* ---- SVG 分时图 ---- */

const svgNode = (tag, attrs) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

const renderChartSvg = (model) => {
  const { prices, base, min, max } = model;
  const range = max - min || 1;
  const n = prices.length;
  const xOf = (i) => (i / Math.max(n - 1, 1)) * 100;
  const yOf = (v) => 100 - ((v - min) / range) * 100;
  const pricePoints = prices.map((p, i) => `${xOf(i).toFixed(2)},${yOf(p).toFixed(2)}`).join(' ');
  const baseY = yOf(base);
  const isUp = prices.at(-1) >= base;
  const color = isUp ? 'var(--pos)' : 'var(--neg)';

  const svg = svgNode('svg', {
    class: 'indices-chart-svg',
    viewBox: '0 0 100 100',
    preserveAspectRatio: 'none',
  });
  // 网格
  for (const y of [20, 40, 60, 80]) {
    svg.append(svgNode('line', { x1: 0, y1: y, x2: 100, y2: y, class: 'chart-grid-line' }));
  }
  // 昨收基准虚线
  svg.append(svgNode('line', { x1: 0, y1: baseY, x2: 100, y2: baseY, class: 'chart-base-line' }));
  // 面积渐变
  const defs = svgNode('defs', {});
  const grad = svgNode('linearGradient', { id: 'indicesAreaGrad', x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(svgNode('stop', { offset: '0%', class: isUp ? 'grad-pos-a' : 'grad-neg-a' }));
  grad.append(svgNode('stop', { offset: '100%', class: isUp ? 'grad-pos-b' : 'grad-neg-b' }));
  defs.append(grad);
  svg.append(defs);
  svg.append(
    svgNode('polygon', {
      points: `0,${baseY.toFixed(2)} ${pricePoints} 100,${baseY.toFixed(2)}`,
      fill: 'url(#indicesAreaGrad)',
    }),
  );
  // 价格线
  svg.append(
    svgNode('polyline', { points: pricePoints, stroke: color, class: 'chart-price-line' }),
  );
  return svg;
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

const hideTimeAxis = () => {
  const axis = $('#indices-timeaxis');
  if (axis !== null) axis.hidden = true;
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

  const meta = $('#indices-chart-meta');
  if (def.intradayStockId === null) {
    if (meta !== null) meta.textContent = `${def.code} · 该指数暂无分时数据`;
    mount(chartWrap, el('p', 'placeholder', '该指数暂无分时数据。'));
    hideTimeAxis();
    renderDetail(null, quote);
    return;
  }

  const r = await callApi(`/api/market/indices/intraday?code=${encodeURIComponent(def.code)}`);
  if (!r.ok) {
    if (meta !== null) meta.textContent = `${def.code} · 加载失败`;
    mount(
      chartWrap,
      el('p', 'placeholder', `分时数据加载失败（${r.error?.kind ?? 'internal'}）。`),
    );
    hideTimeAxis();
    renderDetail(null, quote);
    return;
  }
  const points = r.data?.points ?? [];
  const model = buildIntradayModel(points, prevCloseOf(quote));
  if (model === null) {
    const reason =
      r.data?.supported === false ? '数据源不支持分时' : '盘前 / 非交易日 / 上游不可用';
    if (meta !== null) meta.textContent = `${def.code} · 暂无分时数据`;
    mount(chartWrap, el('p', 'placeholder', `暂无分时数据（${reason}）。`));
    hideTimeAxis();
    renderDetail(null, quote);
    return;
  }

  if (meta !== null) {
    const parts = [`${def.code} · 实时分时`];
    if (r.data?.date !== undefined) parts.push(String(r.data.date));
    if (quote === null) parts.push('基准=首分钟价（快照不可用）');
    meta.textContent = parts.join(' · ');
  }
  mount(chartWrap, renderChartSvg(model));
  const axis = $('#indices-timeaxis');
  if (axis !== null) {
    axis.hidden = false;
    const mid = model.labels[Math.floor(model.labels.length / 2)] ?? '--';
    mount(axis, [
      el('span', null, model.labels[0] ?? '--'),
      el('span', null, mid),
      el('span', null, model.labels.at(-1) ?? '--'),
    ]);
  }
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
};

export { buildIntradayModel, prevCloseOf, renderIndicesPage, teardownIndices };
