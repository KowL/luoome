// apps/web/public/js/dragon-tiger-flow.js —— 龙虎榜「资金流向拓扑」视图。
//
// 数据来自 /api/dragon-tiger/flow（dragon_tiger_flow tool → fuyao 龙虎榜跨交易日聚合）：
// - 概念累计净额轨迹（跨 5/10/20 个交易日，区间起点归零，右端直接标注并避让）
// - 区间净流向排行（点击联动下方个股贡献与拓扑）
// - 机构 / 游资 / 其他 → 概念 → 股票 的资金构成
// 口径由后端统一计算（一股多概念按概念数等分净额），前端只做展示与交互，不臆造字段。

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import { formatAmount } from './market-shared.js';
import { $, el, mount } from './ui.js';

const MAX_CHART_CONCEPTS = 8;
const MAX_TOPOLOGY_STOCKS = 5;
const CHART_HEIGHT = 360;
const BOTTOM_CHART_HEIGHT = 268;

const POSITIVE_COLORS = ['#e0484f', '#c62f3c', '#f0667a', '#a8232e', '#e8615e', '#8f1b24'];
const NEGATIVE_COLORS = ['#0f9d58', '#14a3a3', '#2f8f6b', '#3f66d8', '#0e7c66', '#4f7ec4'];

const DAYS_OPTIONS = [
  [5, '5日'],
  [10, '10日'],
  [20, '20日'],
];
const BOARD_OPTIONS = [
  ['all', '全部榜'],
  ['org', '机构榜'],
  ['hot', '游资榜'],
];
const RANGE_OPTIONS = [
  [1, '仅1日榜'],
  [3, '3日榜'],
];

/** 视图状态（跨重绘保留；切换页面返回时仍停在原区间）。 */
const flowState = { days: 10, board: 'all', rangeDays: 1, selected: null };

let lastData = null;
let refs = null;
let renderToken = 0;
let activeContainer = null;
let activeOptions = null;
let resizeHandler = null;
let themeObserver = null;

/* ---- 纯函数（dragon-tiger-flow.test.js 直接单测） ---- */

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

/** 元 → 亿元文本（无符号）。 */
const formatYi = (n, digits = 2) => (isNum(n) ? `${(n / 1e8).toFixed(digits)}亿` : '--');

/** 元 → 带符号亿元文本。 */
const formatSignedYi = (n, digits = 2) => {
  if (!isNum(n)) return '--';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}${formatYi(Math.abs(n), digits)}`;
};

const signedCls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

/** 轨迹图只画净额绝对值最大的前 N 个概念（保持传入的原始顺序）。 */
const topConcepts = (concepts, limit = MAX_CHART_CONCEPTS) => {
  const list = Array.isArray(concepts)
    ? concepts.filter((c) => c !== null && typeof c === 'object')
    : [];
  return [...list]
    .sort((a, b) => Math.abs(b.netAmount ?? 0) - Math.abs(a.netAmount ?? 0))
    .slice(0, limit);
};

/** 按净额方向分配色阶：净流入红系、净流出绿系；同色系内按排名换色。 */
const assignConceptColors = (concepts) => {
  const colors = new Map();
  let positiveRank = 0;
  let negativeRank = 0;
  for (const concept of Array.isArray(concepts) ? concepts : []) {
    const inflow = (concept.netAmount ?? 0) >= 0;
    const palette = inflow ? POSITIVE_COLORS : NEGATIVE_COLORS;
    const rank = inflow ? positiveRank : negativeRank;
    if (inflow) positiveRank += 1;
    else negativeRank += 1;
    colors.set(concept.name, palette[rank % palette.length]);
  }
  return colors;
};

/** 轨迹 y 轴范围：必须包含 0，两端留 8% 余量；全 0 时给对称区间。 */
const axisRange = (values, padRatio = 0.08) => {
  const nums = (Array.isArray(values) ? values : []).filter(isNum);
  let min = Math.min(0, ...nums);
  let max = Math.max(0, ...nums);
  if (min === max) {
    min = -1;
    max = 1;
  }
  const pad = (max - min) * padRatio;
  return { min: min - pad, max: max + pad };
};

/**
 * 右端标签防碰撞：按目标 y 升序排，向下压开最小间距，
 * 越界后整体回推，并再次夹在 [top, bottom] 内。
 */
const layoutLabels = (items, { top, bottom, minGap }) => {
  const list = (Array.isArray(items) ? items : []).map((item) => ({
    ...item,
    y: Math.min(bottom, Math.max(top, item.y)),
  }));
  list.sort((a, b) => a.y - b.y);
  for (let i = 1; i < list.length; i += 1) {
    list[i].y = Math.max(list[i].y, list[i - 1].y + minGap);
  }
  const last = list[list.length - 1];
  if (last !== undefined && last.y > bottom) {
    const shift = last.y - bottom;
    for (const item of list) item.y -= shift;
  }
  const first = list[0];
  if (first !== undefined && first.y < top) {
    const shift = top - first.y;
    for (const item of list) item.y += shift;
  }
  for (const item of list) item.y = Math.min(bottom, Math.max(top, item.y));
  return list;
};

/** 最近的可拾取点（画布坐标，超出 maxDistance 返回 null）。 */
const nearestPoint = (points, x, y, maxDistance = 26) => {
  let best = null;
  let bestDistance = maxDistance;
  for (const point of Array.isArray(points) ? points : []) {
    const distance = Math.hypot(x - point.x, y - point.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }
  return best;
};

/** 后端 warning 码 → 可读文案。 */
const flowWarningText = (warnings) => {
  const list = Array.isArray(warnings) ? warnings : [];
  const parts = [];
  for (const warning of list) {
    const raw = String(warning);
    if (raw === 'calendar-fallback') parts.push('交易日历不可用，已回退内置节假日历');
    else if (raw.startsWith('future-date:'))
      parts.push(`请求日 ${raw.slice(12)} 晚于今天，已回退到最近交易日`);
    else if (raw.startsWith('non-trading-day:'))
      parts.push(`请求日 ${raw.slice(16)} 非交易日，已向前对齐`);
    else if (raw.startsWith('latest-day-pending:'))
      parts.push(`${raw.slice(19)} 个最近交易日榜单尚未发布，已回退到最近已发布日`);
    else if (raw.startsWith('partial-data:'))
      parts.push(`${raw.slice(13)} 个交易日上游取数失败，按 0 计入`);
    else if (raw.startsWith('calendar-short:')) parts.push(`仅取到 ${raw.slice(15)} 个交易日`);
    else if (raw === 'empty-list') parts.push('区间内无上榜数据');
    else parts.push(raw);
  }
  return parts.join('；');
};

/** 交易日轴标签：D-(n-1) … D-0。 */
const dayLabel = (index, days) => `D-${Math.max(0, days - 1 - index)}`;

/* ---- DOM 助手 ---- */

const stat = (label, value, cls = '') =>
  el('div', 'stat', [el('div', 'label', label), el('div', `value ${cls}`.trim(), String(value))]);

const panel = (title, subtitle, body, extraCls = '') =>
  el('section', `dragon-flow-panel ${extraCls}`.trim(), [
    el('div', 'dragon-flow-panel-head', [
      el('h3', '', title),
      subtitle === '' ? null : el('span', 'dragon-flow-panel-sub', subtitle),
    ]),
    body,
  ]);

const segmented = (options, active, onPick, ariaLabel) => {
  const group = el('div', 'dragon-flow-seg');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', ariaLabel);
  for (const [value, label] of options) {
    const btn = el('button', `btn btn-outline btn-sm${active === value ? ' active' : ''}`, label);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', active === value ? 'true' : 'false');
    btn.addEventListener('click', () => {
      if (active === value) return;
      onPick(value);
    });
    group.append(btn);
  }
  return group;
};

/**
 * 错误 → 可读提示（纯函数，单测覆盖）。
 * 404 是「服务端还没加载新路由」的典型症状：前端静态文件已更新、后端进程仍是旧代码。
 */
const flowErrorHint = (error) => {
  const kind = error?.kind ?? 'internal';
  const message = String(error?.message ?? error?.cause ?? '未知错误');
  if (kind === 'invalid_input' && message.includes('FUYAO_API_KEY')) {
    return {
      kind: 'config',
      title: '资金流向拓扑需要同花顺（fuyao）数据',
      detail:
        '概念 / 机构 / 游资字段来自 fuyao 龙虎榜接口。请在设置页配置 FUYAO_API_KEY 后刷新本页。',
    };
  }
  if (kind === 'internal' && message.includes('HTTP 404')) {
    return {
      kind: 'route-missing',
      title: '资金流向拓扑接口未加载',
      detail:
        '当前 luoome web 进程里没有 /api/dragon-tiger/flow 路由，通常是服务启动早于代码更新。' +
        '请重启 luoome web（luoome restart）后刷新本页。',
    };
  }
  return {
    kind,
    title: '资金流向拓扑加载失败',
    detail:
      kind === 'adapter_error' ? '上游同花顺龙虎榜服务暂不可用，请稍后重试或检查网络。' : message,
  };
};

const errorCard = (error) => {
  const hint = flowErrorHint(error);
  if (hint.kind === 'route-missing') {
    return el('div', 'dragon-flow-empty', [
      el('h3', '', hint.title),
      el('p', 'muted', hint.detail),
    ]);
  }
  if (hint.kind === 'config') {
    const settingsLink = el('a', 'btn btn-sm', '去设置 fuyao 凭据');
    settingsLink.setAttribute('href', '#settings');
    return el('div', 'dragon-flow-empty', [
      el('h3', '', hint.title),
      el('p', 'muted', hint.detail),
      settingsLink,
    ]);
  }
  return el('div', 'dragon-flow-empty', [
    el('h3', '', hint.title),
    el('p', 'error', `加载失败：${hint.kind}（${hint.detail}）`),
  ]);
};

/* ---- 画布基础 ---- */

const themeColors = () => {
  const css = getComputedStyle(document.body);
  const read = (name, fallback) => {
    const value = css.getPropertyValue(name).trim();
    return value.length > 0 ? value : fallback;
  };
  return {
    ink: read('--ink', '#1c2536'),
    inkSoft: read('--ink-soft', '#4d5a70'),
    muted: read('--muted', '#76849a'),
    line: read('--line', 'rgba(28,37,54,.1)'),
    zero: read('--line-strong', 'rgba(28,37,54,.24)'),
    pos: read('--pos', '#e0484f'),
    neg: read('--neg', '#0f9d58'),
    surface: read('--panel-solid-base', '#ffffff'),
  };
};

const setupCanvas = (canvas, height) => {
  if (canvas === null) return null;
  const rect = canvas.getBoundingClientRect();
  const parentWidth = canvas.parentElement?.getBoundingClientRect().width ?? 0;
  const width = Math.max(280, Math.round(rect.width > 0 ? rect.width : parentWidth));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
};

const fitText = (ctx, text, maxWidth) => {
  const value = String(text);
  if (ctx.measureText(value).width <= maxWidth) return value;
  let out = value;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
};

const roundRect = (ctx, x, y, width, height, radius) => {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
};

/* ---- 轨迹图 ---- */

const drawTrajectory = () => {
  const canvas = refs?.trajectory;
  if (canvas === undefined || canvas === null || lastData === null) return;
  const prepared = setupCanvas(canvas, CHART_HEIGHT);
  if (prepared === null) return;
  const { ctx, width, height } = prepared;
  const theme = themeColors();
  const concepts = topConcepts(lastData.concepts, MAX_CHART_CONCEPTS);
  refs.trajectoryPoints = [];
  if (concepts.length === 0) {
    ctx.fillStyle = theme.muted;
    ctx.font = '13px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('区间内暂无可展示的概念轨迹', width / 2, height / 2);
    return;
  }
  const colors = assignConceptColors(concepts);
  const days = Math.max(1, lastData.days ?? concepts[0]?.series?.length ?? 1);
  const pad = {
    left: 60,
    right: Math.min(210, Math.max(132, width * 0.23)),
    top: 18,
    bottom: 30,
  };
  const range = axisRange(concepts.flatMap((concept) => concept.series ?? []));
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const xOf = (index) => pad.left + (days <= 1 ? plotWidth / 2 : (index / (days - 1)) * plotWidth);
  const yOf = (value) => pad.top + ((range.max - value) / (range.max - range.min)) * plotHeight;

  // 网格与 y 轴刻度
  ctx.strokeStyle = theme.line;
  ctx.lineWidth = 1;
  ctx.font = '10px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  ctx.fillStyle = theme.muted;
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i += 1) {
    const value = range.min + ((range.max - range.min) * i) / 4;
    const y = yOf(value);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    ctx.fillText(formatYi(value, 1), pad.left - 8, y + 3);
  }
  ctx.textAlign = 'left';
  ctx.fillText('累计净额（亿元）', pad.left, 12);

  // 零轴固定
  const zeroY = yOf(0);
  ctx.strokeStyle = theme.zero;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(pad.left, zeroY);
  ctx.lineTo(width - pad.right, zeroY);
  ctx.stroke();

  // 折线
  const labelEntries = [];
  for (const concept of concepts) {
    const series = Array.isArray(concept.series) ? concept.series : [];
    const color = colors.get(concept.name) ?? theme.inkSoft;
    const selected = flowState.selected === concept.name;
    ctx.strokeStyle = color;
    ctx.lineWidth = selected ? 3 : 1.6;
    ctx.globalAlpha = flowState.selected === null || selected ? 1 : 0.72;
    ctx.beginPath();
    series.forEach((value, index) => {
      const x = xOf(index);
      const y = yOf(value);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      refs.trajectoryPoints.push({
        x,
        y,
        concept: concept.name,
        index,
        value,
        color,
      });
    });
    ctx.stroke();
    ctx.globalAlpha = 1;
    const end = series[series.length - 1] ?? 0;
    const actualY = yOf(end);
    labelEntries.push({ name: concept.name, color, value: end, y: actualY, actualY, selected });
  }

  // 右端直接标注：先避让再画引线
  const labels = layoutLabels(labelEntries, {
    top: pad.top + 8,
    bottom: height - pad.bottom - 6,
    minGap: 16,
  });
  ctx.font = '10px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  for (const label of labels) {
    const anchorX = width - pad.right;
    ctx.strokeStyle = label.color;
    ctx.lineWidth = label.selected ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(anchorX, label.actualY);
    ctx.lineTo(anchorX + 6, label.y);
    ctx.lineTo(anchorX + 12, label.y);
    ctx.stroke();
    ctx.fillStyle = label.color;
    ctx.textAlign = 'left';
    const text = `${label.name} ${formatSignedYi(label.value, 1)}`;
    ctx.fillText(fitText(ctx, text, width - anchorX - 18), anchorX + 16, label.y + 4);
  }

  // 交易日轴
  ctx.fillStyle = theme.muted;
  ctx.textAlign = 'center';
  const stride = Math.max(1, Math.ceil(days / 5));
  for (let index = 0; index < days; index += stride) {
    ctx.fillText(dayLabel(index, days), xOf(index), height - 10);
  }
  if ((days - 1) % stride !== 0) {
    ctx.fillText(dayLabel(days - 1, days), xOf(days - 1), height - 10);
  }
};

/* ---- 概念个股贡献 ---- */

const selectedConcept = () => {
  const concepts = Array.isArray(lastData?.concepts) ? lastData.concepts : [];
  return concepts.find((concept) => concept.name === flowState.selected) ?? null;
};

const drawStockBars = () => {
  const canvas = refs?.stocks;
  if (canvas === undefined || canvas === null || lastData === null) return;
  const prepared = setupCanvas(canvas, BOTTOM_CHART_HEIGHT);
  if (prepared === null) return;
  const { ctx, width, height } = prepared;
  const theme = themeColors();
  const concept = selectedConcept();
  const stocks = Array.isArray(concept?.stocks) ? concept.stocks : [];
  ctx.font = '12px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  if (concept === null || stocks.length === 0) {
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'center';
    ctx.fillText('所选概念暂无个股明细', width / 2, height / 2);
    return;
  }
  const pad = { left: 86, right: 84, top: 16, bottom: 14 };
  const maxValue = Math.max(1, ...stocks.map((stock) => Math.abs(stock.netAmount ?? 0)));
  const zeroX = pad.left + (width - pad.left - pad.right) / 2;
  const rowHeight = (height - pad.top - pad.bottom) / stocks.length;
  const barHeight = Math.max(8, Math.min(14, rowHeight * 0.5));
  for (const [index, stock] of stocks.entries()) {
    const centerY = pad.top + rowHeight * (index + 0.5);
    const value = stock.netAmount ?? 0;
    const barWidth = Math.max(
      2,
      (Math.abs(value) / maxValue) * ((width - pad.left - pad.right) / 2 - 8),
    );
    ctx.fillStyle = value >= 0 ? theme.pos : theme.neg;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(
      value >= 0 ? zeroX : zeroX - barWidth,
      centerY - barHeight / 2,
      barWidth,
      barHeight,
    );
    ctx.globalAlpha = 1;
    ctx.fillStyle = theme.inkSoft;
    ctx.textAlign = 'right';
    ctx.fillText(fitText(ctx, stock.name ?? stock.code, pad.left - 8), pad.left - 8, centerY + 4);
    // 金额固定在右列：长绿条不会把数字压到股票名上
    ctx.fillStyle = value >= 0 ? theme.pos : theme.neg;
    ctx.textAlign = 'right';
    ctx.fillText(formatSignedYi(value), width - 10, centerY + 4);
  }
  ctx.strokeStyle = theme.zero;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(zeroX, pad.top);
  ctx.lineTo(zeroX, height - pad.bottom);
  ctx.stroke();
  ctx.fillStyle = theme.muted;
  ctx.textAlign = 'left';
  ctx.font = '10px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  ctx.fillText('正贡献在右 · 负贡献在左（亿元）', pad.left, 11);
};

/* ---- 资金构成拓扑 ---- */

const drawTopology = () => {
  const canvas = refs?.topology;
  if (canvas === undefined || canvas === null || lastData === null) return;
  const prepared = setupCanvas(canvas, BOTTOM_CHART_HEIGHT);
  if (prepared === null) return;
  const { ctx, width, height } = prepared;
  const theme = themeColors();
  const concept = selectedConcept();
  ctx.font = '12px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  if (concept === null) {
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'center';
    ctx.fillText('请选择一个概念', width / 2, height / 2);
    return;
  }

  const sources = [
    { label: '机构', value: concept.orgNetAmount ?? 0, color: '#3f66d8' },
    { label: '游资', value: concept.hotNetAmount ?? 0, color: '#d97706' },
    { label: '其他', value: concept.otherNetAmount ?? 0, color: theme.muted },
  ];
  const stocks = (Array.isArray(concept.stocks) ? concept.stocks : []).slice(
    0,
    MAX_TOPOLOGY_STOCKS,
  );
  const compact = width < 460;
  const boxWidth = compact ? 74 : 96;
  const boxHeight = 32;
  const centerWidth = compact ? 92 : 120;
  const centerHeight = 48;
  const centerX = width * (compact ? 0.48 : 0.5);
  const centerY = height * 0.48;
  const stockBoxWidth = Math.min(compact ? 92 : 132, width * 0.34);
  const sourceX = 6;
  const sourceYs = [height * 0.2, height * 0.5, height * 0.8];
  const maxSource = Math.max(1, ...sources.map((source) => Math.abs(source.value)));

  // 源 → 概念
  sources.forEach((source, index) => {
    const y = sourceYs[index] ?? centerY;
    ctx.strokeStyle = source.color;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 2 + Math.min(9, (Math.abs(source.value) / maxSource) * 7);
    ctx.beginPath();
    ctx.moveTo(sourceX + boxWidth, y);
    ctx.bezierCurveTo(
      sourceX + boxWidth + (centerX - sourceX - boxWidth) * 0.55,
      y,
      centerX - centerWidth / 2 - 34,
      centerY,
      centerX - centerWidth / 2,
      centerY,
    );
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = theme.surface;
    ctx.strokeStyle = source.color;
    ctx.lineWidth = 1;
    roundRect(ctx, sourceX, y - boxHeight / 2, boxWidth, boxHeight, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = theme.ink;
    ctx.textAlign = 'left';
    ctx.fillText(source.label, sourceX + 9, y - 1);
    ctx.fillStyle = source.value >= 0 ? theme.pos : theme.neg;
    ctx.textAlign = 'right';
    ctx.fillText(formatSignedYi(source.value, 1), sourceX + boxWidth - 8, y + 12);
  });

  // 概念节点
  ctx.fillStyle = theme.surface;
  ctx.strokeStyle = theme.zero;
  ctx.lineWidth = 1.2;
  roundRect(
    ctx,
    centerX - centerWidth / 2,
    centerY - centerHeight / 2,
    centerWidth,
    centerHeight,
    8,
  );
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = theme.ink;
  ctx.textAlign = 'center';
  ctx.fillText(fitText(ctx, concept.name, centerWidth - 12), centerX, centerY - 2);
  ctx.fillStyle = (concept.netAmount ?? 0) >= 0 ? theme.pos : theme.neg;
  ctx.font = '11px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  ctx.fillText(formatSignedYi(concept.netAmount, 1), centerX, centerY + 14);

  // 概念 → 个股
  const stockX = width - stockBoxWidth - 6;
  const stockGap = stocks.length <= 1 ? 0 : (height - 60) / (stocks.length - 1);
  stocks.forEach((stock, index) => {
    const y = stocks.length <= 1 ? centerY : 30 + stockGap * index;
    const value = stock.netAmount ?? 0;
    ctx.strokeStyle = value >= 0 ? theme.pos : theme.neg;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(centerX + centerWidth / 2, centerY);
    ctx.bezierCurveTo(centerX + centerWidth / 2 + 40, centerY, stockX - 34, y, stockX, y);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = theme.surface;
    ctx.strokeStyle = theme.line;
    ctx.lineWidth = 1;
    roundRect(ctx, stockX, y - 14, stockBoxWidth, 28, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = theme.ink;
    ctx.textAlign = 'left';
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillText(fitText(ctx, stock.name ?? stock.code, stockBoxWidth - 52), stockX + 8, y + 4);
    ctx.fillStyle = value >= 0 ? theme.pos : theme.neg;
    ctx.textAlign = 'right';
    ctx.fillText(formatSignedYi(value, 1), stockX + stockBoxWidth - 7, y + 4);
  });
  if (stocks.length === 0) {
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'right';
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
    ctx.fillText('无个股明细', width - 12, centerY + 4);
  }
};

/* ---- 交互 ---- */

const drawAll = () => {
  drawTrajectory();
  drawStockBars();
  drawTopology();
};

const syncSelection = () => {
  const concept = selectedConcept();
  if (refs?.selectedTitle !== undefined && refs.selectedTitle !== null) {
    refs.selectedTitle.textContent = concept === null ? '未选择概念' : `${concept.name} · 个股贡献`;
  }
  if (refs?.rankList !== undefined && refs.rankList !== null) {
    for (const row of refs.rankList.querySelectorAll('[data-concept]')) {
      const active = row.dataset.concept === flowState.selected;
      row.classList.toggle('active', active);
      row.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }
};

const pickConcept = (name) => {
  if (flowState.selected === name) return;
  flowState.selected = name;
  syncSelection();
  drawAll();
};

const bindTrajectoryHover = () => {
  const canvas = refs?.trajectory;
  const tooltip = refs?.tooltip;
  if (canvas === undefined || canvas === null || tooltip === undefined || tooltip === null) return;
  const hide = () => {
    tooltip.classList.remove('show');
  };
  canvas.addEventListener('mousemove', (event) => {
    const rect = canvas.getBoundingClientRect();
    const point = nearestPoint(
      refs.trajectoryPoints ?? [],
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
    if (point === null) {
      hide();
      return;
    }
    const concept = (lastData?.concepts ?? []).find((item) => item.name === point.concept);
    const date =
      lastData?.tradingDates?.[point.index] ?? dayLabel(point.index, lastData?.days ?? 1);
    tooltip.replaceChildren(
      el('div', 'dragon-flow-tip-title', `${point.concept} · ${date}`),
      el(
        'div',
        `dragon-flow-tip-value ${signedCls(point.value)}`,
        `区间累计 ${formatSignedYi(point.value)}`,
      ),
      el(
        'div',
        'dragon-flow-tip-sub',
        `机构 ${formatSignedYi(concept?.orgNetAmount ?? 0)} · 游资 ${formatSignedYi(concept?.hotNetAmount ?? 0)}`,
      ),
    );
    const parentRect = tooltip.parentElement.getBoundingClientRect();
    const left = Math.min(
      Math.max(4, rect.left - parentRect.left + point.x + 12),
      parentRect.width - tooltip.offsetWidth - 4,
    );
    const top = Math.min(
      Math.max(4, rect.top - parentRect.top + point.y - 18),
      parentRect.height - tooltip.offsetHeight - 4,
    );
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
    tooltip.classList.add('show');
  });
  canvas.addEventListener('mouseleave', hide);
  canvas.addEventListener('click', (event) => {
    const rect = canvas.getBoundingClientRect();
    const point = nearestPoint(
      refs.trajectoryPoints ?? [],
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
    if (point !== null) pickConcept(point.concept);
  });
};

/* ---- 页面拼装 ---- */

const rankBar = (absValue, maxAbs, color) => {
  const wrap = el('span', 'dragon-flow-rank-bar');
  const fill = el('i');
  fill.style.width = `${maxAbs === 0 ? 0 : (absValue / maxAbs) * 100}%`;
  fill.style.background = color;
  wrap.append(fill);
  return wrap;
};

const renderRankRow = (concept, maxAbs, colors) => {
  const value = concept.netAmount ?? 0;
  const color = colors.get(concept.name) ?? (value >= 0 ? '#e0484f' : '#0f9d58');
  const row = el('button', 'dragon-flow-rank');
  row.type = 'button';
  row.dataset.concept = concept.name;
  row.setAttribute('aria-pressed', flowState.selected === concept.name ? 'true' : 'false');
  row.append(
    el('span', `dragon-flow-rank-dir ${signedCls(value)}`, value >= 0 ? '↗' : '↘'),
    el('span', 'dragon-flow-rank-main', [
      el('span', 'dragon-flow-rank-name', concept.name),
      el(
        'small',
        'dragon-flow-rank-sub',
        `机构 ${formatSignedYi(concept.orgNetAmount ?? 0)} · 游资 ${formatSignedYi(concept.hotNetAmount ?? 0)}`,
      ),
      rankBar(Math.abs(value), maxAbs, color),
    ]),
    el('strong', `dragon-flow-rank-value ${signedCls(value)}`, formatSignedYi(value)),
  );
  row.addEventListener('click', () => pickConcept(concept.name));
  return row;
};

const renderChartPanel = () => {
  const canvasWrap = el('div', 'dragon-flow-canvas-wrap', [
    el('canvas', 'dragon-flow-canvas dragon-flow-trajectory'),
    el('div', 'dragon-flow-tooltip'),
  ]);
  refs.trajectory = $('.dragon-flow-trajectory', canvasWrap);
  refs.tooltip = $('.dragon-flow-tooltip', canvasWrap);
  return panel(
    '概念累计净额轨迹',
    '亿元 · 区间起点归零 · 右端直接标注并避让 · 点击折线联动',
    canvasWrap,
    'dragon-flow-chart-panel',
  );
};

const renderRankPanel = (data) => {
  const colors = assignConceptColors(data.concepts ?? []);
  const maxAbs = Math.max(
    0,
    ...(data.concepts ?? []).map((concept) => Math.abs(concept.netAmount ?? 0)),
  );
  const list = el('div', 'dragon-flow-ranks');
  for (const concept of data.concepts ?? []) {
    list.append(renderRankRow(concept, maxAbs, colors));
  }
  refs.rankList = list;
  return panel(
    '区间净流向排行',
    (() => {
      const total = data.stats?.conceptCount ?? (data.concepts ?? []).length;
      const shown = (data.concepts ?? []).length;
      return `共 ${total} 个概念${shown < total ? ` · 前 ${shown}` : ''} · 点击联动`;
    })(),
    list,
    'dragon-flow-rank-panel',
  );
};

const renderBottomPanels = () => {
  const stockWrap = el('div', 'dragon-flow-canvas-wrap', [
    el('canvas', 'dragon-flow-canvas dragon-flow-stocks'),
  ]);
  const topologyWrap = el('div', 'dragon-flow-canvas-wrap', [
    el('canvas', 'dragon-flow-canvas dragon-flow-topology'),
  ]);
  refs.stocks = $('.dragon-flow-stocks', stockWrap);
  refs.topology = $('.dragon-flow-topology', topologyWrap);
  refs.selectedTitle = el('span', 'dragon-flow-panel-sub', '');
  const stocksPanel = panel('所选概念个股贡献', '', stockWrap, 'dragon-flow-stock-panel');
  const stockHead = $('.dragon-flow-panel-head', stocksPanel);
  stockHead.append(refs.selectedTitle);
  const topologyPanel = panel(
    '资金构成拓扑',
    '机构 / 游资 / 其他 → 概念 → 个股',
    topologyWrap,
    'dragon-flow-topology-panel',
  );
  return el('div', 'dragon-flow-bottom', [stocksPanel, topologyPanel]);
};

const rerender = (dateOverride) => {
  if (activeContainer === null) return;
  if (typeof dateOverride === 'string' && dateOverride.length > 0) {
    activeOptions = { ...(activeOptions ?? {}), date: dateOverride };
  }
  void renderDragonTigerFlow(activeContainer, activeOptions ?? {});
};

const renderControls = (data, options) => {
  const refreshBtn = el('button', 'btn', '刷新');
  refreshBtn.type = 'button';
  refreshBtn.addEventListener('click', () => rerender());
  const dateInput = el('input', 'date-input', data.endDate);
  dateInput.type = 'date';
  dateInput.value = data.endDate;
  dateInput.setAttribute('aria-label', '选择资金流向截止交易日');
  dateInput.addEventListener('change', () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput.value)) return;
    options.onDateChange?.(dateInput.value);
    rerender(dateInput.value);
  });
  return el('div', 'dragon-flow-controls', [
    el('span', 'dragon-flow-control-label', '区间'),
    segmented(
      DAYS_OPTIONS,
      flowState.days,
      (value) => {
        flowState.days = value;
        rerender();
      },
      '统计区间',
    ),
    el('span', 'dragon-flow-control-label', '榜单'),
    segmented(
      BOARD_OPTIONS,
      flowState.board,
      (value) => {
        flowState.board = value;
        rerender();
      },
      '榜单口径',
    ),
    el('span', 'dragon-flow-control-label', '口径'),
    segmented(
      RANGE_OPTIONS,
      flowState.rangeDays,
      (value) => {
        flowState.rangeDays = value;
        rerender();
      },
      '上榜区间',
    ),
    dateInput,
    refreshBtn,
  ]);
};

const renderSummary = (data) => {
  const stats = data.stats ?? {};
  return el('div', 'stat-grid dragon-flow-summary', [
    stat('上榜股票', stats.stockCount ?? 0),
    stat('区间净额', formatSignedYi(stats.netAmount), signedCls(stats.netAmount)),
    stat('机构净额', formatSignedYi(stats.orgNetAmount), signedCls(stats.orgNetAmount)),
    stat('游资净额', formatSignedYi(stats.hotNetAmount), signedCls(stats.hotNetAmount)),
    stat('买入额', formatAmount(stats.buyAmount)),
    stat('卖出额', formatAmount(stats.sellAmount)),
    stat('Top5 集中度', `${((stats.top5Concentration ?? 0) * 100).toFixed(1)}%`),
  ]);
};

const renderMeta = (data) =>
  el(
    'p',
    'muted dragon-flow-meta',
    `来源 ${data.source ?? 'fuyao'} · 区间 ${data.startDate} → ${data.endDate} · ${data.days} 个交易日` +
      ` · ${data.stats?.detailCount ?? 0} 条上榜明细 · 榜单 ${BOARD_OPTIONS.find(([value]) => value === data.board)?.[1] ?? data.board}` +
      ` · ${data.rangeDays === 3 ? '3 日榜（窗口重叠，累计仅作观察）' : '仅 1 日榜'} · 60s 自动刷新`,
  );

const renderContent = (data, options) => {
  refs = {
    trajectory: null,
    stocks: null,
    topology: null,
    rankList: null,
    selectedTitle: null,
    tooltip: null,
  };
  const warning = flowWarningText(data.warnings);
  const root = el('div', 'dragon-flow', [
    renderControls(data, options),
    renderMeta(data),
    ...(warning === '' ? [] : [el('p', 'dragon-warning dragon-flow-warning', warning)]),
    renderSummary(data),
    el('div', 'dragon-flow-main', [renderChartPanel(), renderRankPanel(data)]),
    renderBottomPanels(),
    el(
      'p',
      'muted dragon-flow-footnote',
      '口径：一股多概念按概念数等分净额（概念总额与股票总额守恒）；机构 / 游资 / 其他来自同花顺龙虎榜席位字段，' +
        '并在所选榜单内部闭合（机构榜即机构净额，游资榜即游资净额）。买入 / 卖出为个股上榜买入 / 卖出合计。' +
        '数据源 同花顺金融数据 API · 官方为交易日级收盘榜单，不含盘中分时 · 非投资建议。',
    ),
  ]);
  return root;
};

const bindGlobalListeners = () => {
  unbindGlobalListeners();
  resizeHandler = () => drawAll();
  window.addEventListener('resize', resizeHandler);
  if (typeof MutationObserver === 'function') {
    themeObserver = new MutationObserver(() => drawAll());
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  }
};

const unbindGlobalListeners = () => {
  if (resizeHandler !== null) {
    window.removeEventListener('resize', resizeHandler);
    resizeHandler = null;
  }
  if (themeObserver !== null) {
    themeObserver.disconnect();
    themeObserver = null;
  }
};

const buildQuery = (date) => {
  const params = new URLSearchParams();
  if (typeof date === 'string' && date.length > 0) params.set('date', date);
  params.set('days', String(flowState.days));
  params.set('board', flowState.board);
  params.set('rangeDays', String(flowState.rangeDays));
  return params.toString();
};

/**
 * 渲染资金流向拓扑视图到 container。
 * options: { date?, setStatus?, onDateChange?, onStateChange? }
 */
const renderDragonTigerFlow = async (container, options = {}) => {
  if (container === null || container === undefined) return;
  lastData = null;
  activeContainer = container;
  activeOptions = options;
  renderToken += 1;
  const token = renderToken;
  mount(container, [el('p', 'muted', '加载资金流向拓扑…')]);
  options.setStatus?.('加载龙虎榜资金流向…');
  const r = await callApi(`/api/dragon-tiger/flow?${buildQuery(options.date)}`);
  if (token !== renderToken || !container.isConnected) return;
  if (!r.ok) {
    refs = null;
    const hint = flowErrorHint(r.error);
    mount(container, [
      errorCard(r.error),
      el('p', 'muted dragon-flow-footnote', '数据源：同花顺金融数据 API · 非投资建议'),
    ]);
    options.setStatus?.(`${hint.title}：${hint.detail}`, true);
    return;
  }
  lastData = r.data;
  const concepts = Array.isArray(lastData.concepts) ? lastData.concepts : [];
  if (!concepts.some((concept) => concept.name === flowState.selected)) {
    flowState.selected = topConcepts(concepts, 1)[0]?.name ?? null;
  }
  const content = renderContent(lastData, { onDateChange: options.onDateChange });
  mount(container, content);
  syncSelection();
  bindTrajectoryHover();
  bindGlobalListeners();
  requestAnimationFrame(() => {
    if (!container.isConnected) return;
    drawAll();
  });
  const warning = flowWarningText(lastData.warnings);
  options.setStatus?.(
    `资金流向 ${lastData.startDate} → ${lastData.endDate} 加载完成（${concepts.length} 个概念${
      warning === '' ? '' : `；${warning}`
    }）`,
  );
};

/** 离开路由时清理：停止重绘监听并释放画布引用。 */
const teardownDragonTigerFlow = () => {
  unbindGlobalListeners();
  lastData = null;
  refs = null;
  activeContainer = null;
  activeOptions = null;
};

export {
  assignConceptColors,
  axisRange,
  dayLabel,
  flowErrorHint,
  flowWarningText,
  formatSignedYi,
  formatYi,
  layoutLabels,
  nearestPoint,
  renderDragonTigerFlow,
  teardownDragonTigerFlow,
  topConcepts,
};
