/* apps/web/public/js/market-room.js —— 作战室页面（总览 / 板块追踪 / 成交分布）。
 *
 * 设计要点（ticket #36）：
 * - 只读：数据来自 GET /api/market/room/overview（最近已发布批次 + 既有情绪 / 指数契约），
 *   刷新页面不触发采集；
 * - 每个维度独立展示完整性与缺失原因；缺数写「缺失」，不写 0，也不下放量 / 缩量结论；
 * - 非交易日 / 盘前 / 无批次有明确空态，不把上一交易日数据当作当日盘面；
 * - 板块追踪与成交分布由后续票接入，当前只给空态占位。
 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import { formatAmount } from './market-shared.js';
import { $, el, mount } from './ui.js';

const ROOM_TABS = ['overview', 'sectors', 'turnover'];
const ROOM_TAB_LABELS = { overview: '总览', sectors: '板块追踪', turnover: '成交分布' };

const ROOM_TAB_PLACEHOLDERS = {
  sectors: '板块追踪视图尚未接入数据：将展示行业与概念的当日涨幅、窗口涨幅与上涨家数。',
  turnover: '成交分布视图尚未接入数据：将展示窗口成交占比与较上一窗口的变化。',
};

const DIMENSION_STATUS_LABELS = {
  complete: '完整',
  partial: '部分可用',
  unavailable: '缺失',
};

const VERDICT_LABELS = { expanded: '放量', contracted: '缩量', flat: '持平' };

const EMPTY_STATE_TEXTS = {
  no_batch: '尚无已发布的盘中批次',
  pre_open: '盘前尚无当日批次，不展示盘前数据',
  non_trading_day: '非交易日，不展示当日盘面数据',
  no_today_batch: '今日尚无已发布批次',
};

const COVERAGE_LABELS = { CN_A_SHARES_SH_SZ: '沪深 A 股', CN_A_SHARES_BJ: '北交所' };

const REFRESH_MS = 60_000;

let roomEpoch = 0;
let roomTimer = null;

const roomSection = () => $('#route-market-room');

/** hash 里的 tab（深链接 #market-room?tab=sectors）；非法值回退总览。 */
const roomTabFromHash = (hash = window.location.hash) => {
  const tab = new URLSearchParams(String(hash ?? '').split('?')[1] ?? '').get('tab') ?? 'overview';
  return ROOM_TABS.includes(tab) ? tab : 'overview';
};

const dimensionStatusLabel = (status) => DIMENSION_STATUS_LABELS[status] ?? '缺失';

/** 百分比文案（百分数单位，与后端 changePct / deltaPct 一致）。 */
const fmtPct = (value, signed = false) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '--';
  const sign = signed && value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
};

/** 上海时钟 HH:mm；非法时间返回 '--'。 */
const fmtClock = (value) => {
  if (value === null || value === undefined) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleTimeString('zh-CN', {
    hour12: false,
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const coverageLabel = (coverage) => COVERAGE_LABELS[coverage] ?? coverage ?? '--';

/** 涨跌平家数（纯函数）：只描述分类样本，不补零。 */
const breadthCountsText = (value) =>
  value === undefined || value === null
    ? null
    : `上涨 ${value.advancing} · 下跌 ${value.declining} · 平 ${value.unchanged}`;

/** 中位数文案；无样本时写缺失而不是 0.00%。 */
const breadthMedianText = (value) => {
  if (value === undefined || value === null) return null;
  return value.medianChangePct === null
    ? '个股涨幅中位数缺失'
    : `个股涨幅中位数 ${fmtPct(value.medianChangePct, true)}`;
};

/** 统计口径：样本数 / 期望数 / 参与分类 / 缺失数全部写出。 */
const breadthSampleText = (value) =>
  value === undefined || value === null
    ? null
    : `样本 ${value.sampleCount} 只 / 期望 ${value.expectedCount} 只 · 参与分类 ${value.classifiedCount} 只 · 缺涨幅 ${value.missingChangePctCount} 只`;

/** 指数与多数个股背离提示；无基准指数时不编造结论。 */
const divergenceText = (value) => {
  const divergence = value?.divergence;
  if (divergence === undefined || divergence === null) return null;
  const benchmark = `${divergence.indexName} ${fmtPct(divergence.indexChangePct, true)}`;
  const median = `中位数 ${fmtPct(divergence.medianChangePct, true)}`;
  return divergence.divergent
    ? `指数与多数个股背离：${benchmark} / ${median}`
    : `指数与多数个股同向：${benchmark} / ${median}`;
};

/**
 * 成交额口径（纯函数）。
 * 没有可比的昨日同时点时 verdict 为 null：页面只显示缺失原因，不写 0、不写缩量。
 */
const amountSummary = (amount) => {
  const value = amount?.value;
  if (value === undefined || value === null) return null;
  const comparison = value.comparison;
  return {
    current: `累计成交额 ${formatAmount(value.currentAmount)}`,
    sample: `样本 ${value.currentSampleCount} 只 · 缺成交额 ${value.currentMissingAmountCount} 只`,
    previous:
      comparison === undefined
        ? '昨日同时点缺失'
        : `昨日同时点 ${formatAmount(comparison.previousAmount)}（${comparison.previousTradingDate} ${fmtClock(comparison.previousSampledAt)}）`,
    verdict:
      comparison === undefined
        ? null
        : `${VERDICT_LABELS[comparison.verdict] ?? comparison.verdict} ${fmtPct(comparison.deltaPct, true)}`,
  };
};

/** 空态文案；ready 返回 null。 */
const emptyStateText = (overview) => {
  if (overview?.state !== 'empty') return null;
  const base = EMPTY_STATE_TEXTS[overview.emptyReason] ?? '暂无当日盘面数据';
  const latest = overview.latestBatch;
  return latest === null || latest === undefined
    ? base
    : `${base} · 最近批次 ${latest.tradingDate} ${fmtClock(latest.sampledAt)}`;
};

/** 页头口径：覆盖范围 / 交易日 / 数据时点；空态给出原因。 */
const overviewMetaText = (overview) => {
  if (overview?.state === 'empty') return emptyStateText(overview);
  const coverage = overview?.coverage?.value;
  if (coverage === undefined) return '数据时点未知';
  return `${coverageLabel(coverage.coverage)} · 交易日 ${coverage.tradingDate} · 数据时点 ${fmtClock(coverage.sampledAt)}`;
};

const missingReasonText = (dimension) => dimension?.warnings?.[0] ?? '该维度暂不可用';

/* ---- DOM 渲染 ---- */

const statusBadge = (status) =>
  el('span', `room-status room-status-${status}`, dimensionStatusLabel(status));

const dimensionNote = (dimension) => {
  if (dimension === undefined || dimension.status === 'complete') return null;
  return el(
    'ul',
    'room-warnings',
    dimension.warnings.map((warning) => el('li', '', warning)),
  );
};

const fact = (label, value) =>
  el('div', 'room-fact', [el('span', 'label', label), el('span', 'value', value ?? '缺失')]);

const dataAsOfNote = (value) =>
  value.dataAsOf === undefined
    ? ' · 上游未提供行情时间'
    : ` · 行情时间 ${fmtClock(value.dataAsOf)}`;

const coverageCard = (coverage) => {
  const value = coverage.value;
  const body =
    value === undefined
      ? [el('p', 'placeholder', missingReasonText(coverage))]
      : [
          el('div', 'room-facts', [
            fact('覆盖范围', coverageLabel(value.coverage)),
            fact('交易日', value.tradingDate),
            fact('数据时点', fmtClock(value.sampledAt)),
            fact('样本', `${value.receivedCount} / 期望 ${value.expectedCount}`),
            fact('缺失 / 重复', `${value.missingCount} / ${value.duplicateCount}`),
            fact('来源', value.source),
          ]),
          el('p', 'room-caption', `抓取于 ${fmtClock(value.fetchedAt)}${dataAsOfNote(value)}`),
        ];
  return el('div', 'card room-card', [
    el('div', 'card-header', [
      el('div', [el('h2', '', '数据时点与覆盖'), el('div', 'card-meta', '最近已发布批次')]),
      statusBadge(coverage.status),
    ]),
    ...body,
    dimensionNote(coverage),
  ]);
};

const indexRow = (indexes) => {
  if (indexes.value === undefined) return el('p', 'placeholder', missingReasonText(indexes));
  return el(
    'div',
    'room-index-row',
    indexes.value.values.map((entry) =>
      el('div', 'room-index', [
        el('span', 'name', entry.name),
        el(
          'span',
          `value ${entry.changePct > 0 ? 'text-pos' : entry.changePct < 0 ? 'text-neg' : 'muted'}`,
          fmtPct(entry.changePct, true),
        ),
      ]),
    ),
  );
};

const breadthCard = (overview) => {
  const breadth = overview.breadth;
  const value = breadth.value;
  const children = [indexRow(overview.indexes)];
  if (value === undefined) {
    children.push(el('p', 'placeholder', missingReasonText(breadth)));
  } else {
    const divergence = divergenceText(value);
    children.push(
      el('div', 'room-breadth-row', [
        el('span', 'text-pos', `上涨 ${value.advancing}`),
        el('span', 'text-neg', `下跌 ${value.declining}`),
        el('span', 'muted', `平 ${value.unchanged}`),
        el('span', 'room-median', breadthMedianText(value)),
      ]),
      el('p', 'room-caption', breadthSampleText(value)),
    );
    if (divergence !== null) {
      children.push(
        el('p', value.divergence.divergent ? 'room-divergence' : 'room-caption', divergence),
      );
    }
  }
  return el('div', 'card room-card', [
    el('div', 'card-header', [
      el('div', [
        el('h2', '', '指数与个股宽度'),
        el('div', 'card-meta', '指数为实时行情 · 宽度与中位数来自批次样本'),
      ]),
      statusBadge(breadth.status),
    ]),
    ...children,
    dimensionNote(overview.indexes),
    dimensionNote(breadth),
  ]);
};

const amountCard = (amount) => {
  const summary = amountSummary(amount);
  const body =
    summary === null
      ? [el('p', 'placeholder', missingReasonText(amount))]
      : [
          el('div', 'room-facts', [
            fact('累计成交额', summary.current),
            fact('昨日同时点', summary.previous),
            fact('结论', summary.verdict ?? '缺失'),
            fact('口径', summary.sample),
          ]),
        ];
  return el('div', 'card room-card', [
    el('div', 'card-header', [
      el('div', [
        el('h2', '', '成交额与昨日同时点'),
        el('div', 'card-meta', '对比基准为上一交易日同一时刻的已发布批次'),
      ]),
      statusBadge(amount.status),
    ]),
    ...body,
    dimensionNote(amount),
  ]);
};

const limitUpCard = (limitUp) => {
  const value = limitUp.value;
  return el('div', 'card room-card', [
    el('div', 'card-header', [
      el('div', [el('h2', '', '短线情绪'), el('div', 'card-meta', '复用 A 股情绪契约，不重算')]),
      statusBadge(limitUp.status),
    ]),
    value === undefined
      ? el('p', 'placeholder', missingReasonText(limitUp))
      : el('div', 'room-facts', [
          fact('封板家数', `${value.sealedCount}`),
          fact('当前炸板', `${value.brokenCount}`),
          fact('最高连板', value.maxLadderLevel > 0 ? `${value.maxLadderLevel} 板` : '无连板'),
        ]),
    dimensionNote(limitUp),
  ]);
};

const renderOverviewPane = (overview) => {
  const empty = emptyStateText(overview);
  if (empty !== null) {
    return el('div', 'card room-empty', [
      el('h2', '', '当日盘面尚未开始'),
      el('p', '', empty),
      el('p', 'room-caption', '页面只读已发布批次；非交易日与盘前不展示上一交易日的当日盘面数据。'),
    ]);
  }
  return el('div', 'room-overview', [
    coverageCard(overview.coverage),
    breadthCard(overview),
    amountCard(overview.amount),
    limitUpCard(overview.limitUp),
  ]);
};

/* ---- 页面挂载与刷新 ---- */

const ensureShell = (section) => {
  if (section.querySelector('.room-tabs') !== null) return;
  const tabs = el(
    'div',
    'room-tabs',
    ROOM_TABS.map((tab) => {
      const button = el('button', 'btn btn-outline btn-sm', ROOM_TAB_LABELS[tab]);
      button.type = 'button';
      button.dataset.roomTab = tab;
      button.setAttribute('role', 'tab');
      button.addEventListener('click', () => {
        window.location.hash = `market-room?tab=${tab}`;
      });
      return button;
    }),
  );
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', '作战室视图');
  mount(section, [
    el('div', 'route-header room-head', [
      el('div', [
        el('span', 'section-kicker', 'MARKET ROOM'),
        el('h1', '', '作战室'),
        el('div', 'route-meta', '全市场盘中总览 · 只读已发布批次'),
      ]),
      tabs,
    ]),
    el('p', 'room-meta', '--'),
    el('div', 'room-pane'),
  ]);
};

const syncTabs = (section, tab) => {
  for (const button of section.querySelectorAll('[data-room-tab]')) {
    const active = button.dataset.roomTab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }
};

const setMeta = (section, text) => {
  const meta = section.querySelector('.room-meta');
  if (meta !== null) meta.textContent = text;
};

const renderPlaceholder = (section, tab) => {
  const pane = section.querySelector('.room-pane');
  if (pane === null) return;
  mount(pane, [
    el('div', 'card room-empty', [
      el('h2', '', ROOM_TAB_LABELS[tab] ?? '视图'),
      el('p', '', ROOM_TAB_PLACEHOLDERS[tab] ?? '该视图尚未接入数据。'),
      el('p', 'room-caption', '总览已可用；该视图接入后会沿用同一批次与时间点。'),
    ]),
  ]);
  setMeta(section, `${ROOM_TAB_LABELS[tab]} · 尚未接入数据`);
};

const renderOverview = (section, overview) => {
  const pane = section.querySelector('.room-pane');
  if (pane === null) return;
  mount(pane, renderOverviewPane(overview));
  setMeta(section, overviewMetaText(overview));
};

const fetchOverview = async () => {
  const result = await callApi('/api/market/room/overview', { timeoutMs: 15_000 });
  return result.ok ? (result.data?.overview ?? null) : null;
};

const refreshOverview = async (epoch, setStatus) => {
  const section = roomSection();
  if (section === null) return;
  const overview = await fetchOverview();
  if (epoch !== roomEpoch || roomSection()?.hidden !== false) return;
  if (overview === null) {
    setMeta(section, '刷新失败，保留上次成功结果');
    const pane = section.querySelector('.room-pane');
    if (pane !== null && pane.childElementCount === 0) {
      mount(pane, [
        el('div', 'card room-empty', [
          el('h2', '', '总览暂不可用'),
          el('p', '', '读取最近已发布批次失败，稍后会自动重试。'),
        ]),
      ]);
    }
    setStatus?.('作战室总览刷新失败', true);
    return;
  }
  renderOverview(section, overview);
};

const stopTimer = () => {
  if (roomTimer !== null) clearInterval(roomTimer);
  roomTimer = null;
};

const startTimer = (setStatus) => {
  stopTimer();
  roomTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (roomSection()?.hidden !== false) return;
    if (roomTabFromHash() !== 'overview') return;
    void refreshOverview(roomEpoch, setStatus);
  }, REFRESH_MS);
};

/** 进入作战室：渲染外壳 + 当前 tab；总览才读数据，占位视图不请求。 */
const renderMarketRoom = async (setStatus = () => {}) => {
  const section = roomSection();
  if (section === null) return;
  roomEpoch += 1;
  const epoch = roomEpoch;
  const tab = roomTabFromHash();
  ensureShell(section);
  syncTabs(section, tab);
  if (tab !== 'overview') {
    stopTimer();
    renderPlaceholder(section, tab);
    return;
  }
  await refreshOverview(epoch, setStatus);
  if (epoch !== roomEpoch) return;
  startTimer(setStatus);
};

/** 离开作战室：停止 60s 刷新并让在途响应失效。 */
const teardownMarketRoom = () => {
  roomEpoch += 1;
  stopTimer();
};

export {
  amountSummary,
  breadthCountsText,
  breadthMedianText,
  breadthSampleText,
  divergenceText,
  emptyStateText,
  overviewMetaText,
  renderMarketRoom,
  roomTabFromHash,
  teardownMarketRoom,
};
