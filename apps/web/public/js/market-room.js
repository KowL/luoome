/* apps/web/public/js/market-room.js —— 作战室页面（总览 / 板块追踪 / 成交分布 / 盘中事件）。
 *
 * 设计要点（ticket #36 / #38）：
 * - 只读：数据来自 GET /api/market/room/overview 与 GET /api/market/room/sectors，
 *   刷新页面不触发采集；
 * - 每个维度独立展示完整性与缺失原因；缺数写「缺失」，不写 0，也不下放量 / 缩量结论；
 * - 非交易日 / 盘前 / 无批次有明确空态，不把上一交易日数据当作当日盘面；
 * - 板块追踪：行业 / 概念切换，同一张表同时给日涨幅与近 5 / 15 分钟窗口涨幅，
 *   三种口径分别排序；点开一行看上涨家数、有效成分、封板数与成交占比及口径说明；
 * - 成交分布（ticket #40）：窗口占比、百分点环比与 CR3 交给 market-room-amount.js，
 *   本文件只负责按 tab 取数与挂载；
 * - 盘中事件（ticket #42）：扩散 / 分化 / 换位按时间倒序，交给 market-room-events.js；
 *   本票只做展示与选中态，点事件切换三个视图的时点属于 #43。
 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import {
  amountMetaText,
  amountParamsFromHash,
  amountQuery,
  renderAmountPane,
} from './market-room-amount.js';
import {
  eventsMetaText,
  eventsParamsFromHash,
  fetchRoomEvents,
  renderEventsPane,
} from './market-room-events.js';
import { fetchCoreStocks, renderCoreStocksPane } from './market-room-roles.js';
import {
  fetchSectorDetail,
  renderSectorDetailPane,
  sectorDetailHash,
  sectorDetailParamsFromHash,
  toggleCompareSelection,
} from './market-room-sector-detail.js';
import { formatAmount } from './market-shared.js';
import { $, el, mount, sortableHeader } from './ui.js';

const ROOM_TABS = ['overview', 'sectors', 'turnover', 'events'];
const ROOM_TAB_LABELS = {
  overview: '总览',
  sectors: '板块追踪',
  turnover: '成交分布',
  events: '盘中事件',
};

const SECTOR_KINDS = ['industry', 'concept'];
const SECTOR_KIND_LABELS = { industry: '行业', concept: '概念' };
const SECTOR_SORTS = ['day', 'window5', 'window15'];
const SECTOR_SORT_LABELS = { day: '日涨幅', window5: '5 分钟', window15: '15 分钟' };
const SECTOR_WINDOWS = ['w5', 'w15'];
const SECTOR_WINDOW_LABELS = { w5: '5 分钟', w15: '15 分钟' };

const SECTOR_EMPTY_TEXTS = {
  no_batch: '尚无已发布的盘中批次',
  pre_open: '盘前尚无当日批次，不展示盘前数据',
  non_trading_day: '非交易日，不展示当日盘面数据',
  no_today_batch: '今日尚无已发布批次',
  no_sector_catalog: '行业 / 概念目录尚未同步',
  no_members: '目录里没有带 active 成分的板块',
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
/** 板块追踪最近一次成功的榜单，切换分类请求失败时只在同一分类下复用。 */
let roomSectorRanking = null;
let roomAmountDistribution = null;
let roomEventsView = null;

const roomSection = () => $('#route-market-room');

/** hash 里的 tab（深链接 #market-room?tab=sectors）；非法值回退总览。 */
const roomTabFromHash = (hash = window.location.hash) => {
  const tab = new URLSearchParams(String(hash ?? '').split('?')[1] ?? '').get('tab') ?? 'overview';
  return ROOM_TABS.includes(tab) ? tab : 'overview';
};

const pickParam = (params, key, allowed, fallback) => {
  const value = params.get(key);
  return value !== null && allowed.includes(value) ? value : fallback;
};

/** 板块追踪的深链接参数（#market-room?tab=sectors&kind=concept&sort=window5&window=w15）。 */
const sectorParamsFromHash = (hash = window.location.hash) => {
  const params = new URLSearchParams(String(hash ?? '').split('?')[1] ?? '');
  return {
    kind: pickParam(params, 'kind', SECTOR_KINDS, 'industry'),
    sort: pickParam(params, 'sort', SECTOR_SORTS, 'day'),
    window: pickParam(params, 'window', SECTOR_WINDOWS, 'w15'),
  };
};

/** 板块榜请求路径（纯函数，便于单测）：口径全部显式带上，便于与服务端日志对照。 */
const sectorQuery = (params) =>
  `?kind=${encodeURIComponent(params.kind)}&sort=${encodeURIComponent(params.sort)}&window=${encodeURIComponent(params.window)}`;

/** 板块追踪深链接：切换行业 / 概念或排序口径时只改 hash，由路由统一重绘。 */
const sectorHash = (params) =>
  `market-room?tab=sectors&kind=${params.kind}&sort=${params.sort}&window=${params.window}`;

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

/** 板块榜的缺失原因：取第一条 warning，没有则写缺失。 */
const sectorMissingText = (metric) => metric?.warnings?.[0] ?? '缺失';

const sectorValueText = (metric) => {
  if (metric?.value === null || metric?.value === undefined) return null;
  return fmtPct(metric.value, true);
};

const sectorShareText = (turnover) => {
  if (turnover?.value === null || turnover?.value === undefined) return null;
  return `${turnover.value.toFixed(2)}%`;
};

const sectorBreadthText = (day) =>
  day === undefined || day === null
    ? null
    : `上涨 ${day.advancing} · 下跌 ${day.declining} · 平 ${day.unchanged}`;

/** 样本口径：有效成分（分母）/ 板块成分 / 缺失 / 停牌退市，全部写出来。 */
const sectorSampleText = (metric) =>
  metric === undefined || metric === null
    ? null
    : `有效 ${metric.sampleCount} / 成分 ${metric.memberCount} · 缺失 ${metric.missingCount} · 停牌退市 ${metric.nonTradableCount}`;

/** 窗口两端与跨度；不可比时写明原因，不显示 0。 */
const windowSpanText = (ref) => {
  if (ref === undefined || ref === null) return '窗口缺失';
  if (ref.status === 'unavailable') return `缺失：${ref.reason ?? '窗口不可比'}`;
  const start = fmtClock(ref.startSampledAt);
  const end = fmtClock(new Date(new Date(ref.startSampledAt).getTime() + (ref.spanMs ?? 0)));
  const suffix = ref.status === 'partial' ? '（批次不完整）' : '';
  return `${start} → ${end} · ${Math.round((ref.spanMs ?? 0) / 60_000)} 分钟${suffix}`;
};

/** 表格单元格文案（纯函数）：缺失一律 null，由渲染层写「缺失」。 */
const sectorRowCells = (row) => ({
  rank: row.rank === null || row.rank === undefined ? '—' : String(row.rank),
  day: sectorValueText(row.day),
  window5: sectorValueText(row.window5),
  window15: sectorValueText(row.window15),
  breadth: `上涨 ${row.day.advancing} / 有效 ${row.day.sampleCount}`,
  breadthSub: `成分 ${row.day.memberCount} · 缺失 ${row.day.missingCount} · 停牌退市 ${row.day.nonTradableCount}`,
  limitUp:
    row.limitUp.value === null || row.limitUp.value === undefined ? null : `${row.limitUp.value}`,
  turnover: sectorShareText(row.turnover),
});

/** 展开行的口径事实：每个数字都带分母 / 样本数说明。 */
const sectorDetailFacts = (row, ranking) => {
  const denominator = ranking?.turnover?.marketAmountDelta ?? null;
  return [
    { label: '日涨幅', value: sectorValueText(row.day) ?? '缺失' },
    { label: '近 5 分钟', value: sectorValueText(row.window5) ?? '缺失' },
    { label: '近 15 分钟', value: sectorValueText(row.window15) ?? '缺失' },
    { label: '上涨 / 下跌 / 平', value: sectorBreadthText(row.day) ?? '缺失' },
    { label: '有效成分（分母）', value: sectorSampleText(row.day) ?? '缺失' },
    {
      label: '封板数',
      value:
        row.limitUp.value === null || row.limitUp.value === undefined
          ? '缺失'
          : `${row.limitUp.value} 只`,
    },
    { label: '窗口成交占比', value: sectorShareText(row.turnover) ?? '缺失' },
    {
      label: '成分增量 / 全市场增量',
      value:
        row.turnover.numeratorAmount === null || denominator === null
          ? '缺失'
          : `${formatAmount(row.turnover.numeratorAmount)} / ${formatAmount(denominator)}`,
    },
    { label: '窗口起点（5 分钟）', value: windowSpanText(ranking?.windows?.w5) },
    { label: '窗口起点（15 分钟）', value: windowSpanText(ranking?.windows?.w15) },
  ];
};

/** 展开行的说明：口径、缺失原因与全局提示合并去重，便于核对「为什么是缺失」。 */
const sectorDetailNotes = (row, ranking) => {
  const notes = [
    row.day.method,
    row.window5.method,
    row.turnover.method,
    row.limitUp.method,
    ...(ranking?.notes ?? []),
    ...row.day.warnings,
    ...row.window5.warnings,
    ...row.window15.warnings,
    ...row.turnover.warnings,
    ...row.limitUp.warnings,
    ...(ranking?.turnover?.reason === null || ranking?.turnover?.reason === undefined
      ? []
      : [ranking.turnover.reason]),
    ...(ranking?.limitUp?.reason === null || ranking?.limitUp?.reason === undefined
      ? []
      : [ranking.limitUp.reason]),
  ];
  return [...new Set(notes.filter((note) => typeof note === 'string' && note.length > 0))];
};

/** 空态文案；ready 返回 null。 */
const sectorEmptyText = (ranking) => {
  if (ranking?.state !== 'empty') return null;
  const base = SECTOR_EMPTY_TEXTS[ranking.emptyReason] ?? '暂无板块数据';
  const anchor = ranking.anchor;
  return anchor === null || anchor === undefined
    ? base
    : `${base} · 最近批次 ${anchor.tradingDate} ${fmtClock(anchor.sampledAt)}`;
};

/** 页头口径：分类 / 交易日 / 数据时点 / 排序口径 / 占比窗口。 */
const sectorMetaText = (ranking) => {
  if (ranking === undefined || ranking === null) return '板块追踪 · 刷新失败，保留上次成功结果';
  if (ranking.state === 'empty') return `板块追踪 · ${sectorEmptyText(ranking)}`;
  const kind = SECTOR_KIND_LABELS[ranking.kind] ?? ranking.kind;
  const sort = SECTOR_SORT_LABELS[ranking.sort] ?? ranking.sort;
  const windowLabel = SECTOR_WINDOW_LABELS[ranking.window] ?? ranking.window;
  const sampledAt = ranking.anchor === null ? '--' : fmtClock(ranking.anchor.sampledAt);
  return `${kind} · 交易日 ${ranking.tradingDate} · 数据时点 ${sampledAt} · 按${sort}排序 · 占比窗口 ${windowLabel}`;
};

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
      el('div', null, [el('h2', '', '数据时点与覆盖'), el('div', 'card-meta', '最近已发布批次')]),
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
      el('div', null, [
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
      el('div', null, [
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
      el('div', null, [
        el('h2', '', '短线情绪'),
        el('div', 'card-meta', '复用 A 股情绪契约，不重算'),
      ]),
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

/* ---- 板块追踪（ticket #38） ---- */

const sectorSortHeader = (label, sortKey, params, onSort) =>
  sortableHeader(label, sortKey, { key: params.sort, order: 'desc' }, onSort, 'num');

const sectorOnSort = (params) => (sortKey) => {
  if (!SECTOR_SORTS.includes(sortKey)) return;
  window.location.hash = sectorHash({ ...params, sort: sortKey });
};

const sectorKindSwitch = (params) => {
  const buttons = SECTOR_KINDS.map((kind) => {
    const button = el('button', 'btn btn-outline btn-sm', SECTOR_KIND_LABELS[kind]);
    button.type = 'button';
    button.classList.toggle('active', params.kind === kind);
    button.setAttribute('aria-pressed', String(params.kind === kind));
    button.addEventListener('click', () => {
      if (params.kind === kind) return;
      window.location.hash = sectorHash({ ...params, kind });
    });
    return button;
  });
  const group = el('div', 'room-kind-switch', buttons);
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', '板块分类');
  return group;
};

const missingCell = (metric, className = 'num') => {
  const cell = el('td', `${className} room-missing`, '缺失');
  cell.title = sectorMissingText(metric);
  return cell;
};

const valueCell = (metric, className = 'num') => {
  const text = sectorValueText(metric);
  if (text === null) return missingCell(metric, className);
  const tone = metric.value > 0 ? 'pos' : metric.value < 0 ? 'neg' : '';
  return el('td', `${className} ${tone}`.trim(), text);
};

const sectorDetailRow = (row, ranking) => {
  const facts = sectorDetailFacts(row, ranking).map((fact) =>
    el('div', 'room-fact', [el('span', 'label', fact.label), el('span', 'value', fact.value)]),
  );
  const notes = sectorDetailNotes(row, ranking);
  const cell = el('td', '', [
    el('div', 'room-facts', facts),
    el(
      'ul',
      'room-warnings',
      notes.map((note) => el('li', '', note)),
    ),
  ]);
  cell.colSpan = 8;
  return el('tr', 'room-sector-detail', cell);
};

const sectorRowPair = (row, ranking, params) => {
  const cells = sectorRowCells(row);
  const detailParams = sectorDetailParamsFromHash();
  const expanded = detailParams.sectorId === row.sectorId;
  const rankCell = el('td', 'num muted', cells.rank);
  const nameCell = el('td', '', [
    el('span', 'room-sector-name', row.name),
    el('span', 'cell-sub muted', `${SECTOR_KIND_LABELS[row.kind] ?? row.kind} · ${row.vendorCode}`),
  ]);
  const breadthCell = el('td', 'num', [
    el('span', '', cells.breadth),
    el('span', 'cell-sub muted', cells.breadthSub),
  ]);
  const limitUpCell =
    cells.limitUp === null ? missingCell(row.limitUp) : el('td', 'num', cells.limitUp);
  const turnoverCell =
    cells.turnover === null ? missingCell(row.turnover) : el('td', 'num', cells.turnover);

  const main = el('tr', `room-sector-row${expanded ? ' expanded' : ''}`, [
    rankCell,
    nameCell,
    valueCell(row.day),
    valueCell(row.window5),
    valueCell(row.window15),
    breadthCell,
    limitUpCell,
    turnoverCell,
  ]);
  main.dataset.sectorId = row.sectorId;
  main.tabIndex = 0;
  main.setAttribute('aria-expanded', String(expanded));
  const toggle = () => {
    if (expanded) {
      window.location.hash = sectorHash(params);
      return;
    }
    window.location.hash = sectorDetailHash({
      ...params,
      sectorId: row.sectorId,
      compareSectorIds: detailParams.compareSectorIds,
    });
  };
  main.addEventListener('click', toggle);
  main.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggle();
  });
  return expanded ? [main, sectorDetailRow(row, ranking)] : [main];
};

const sectorTable = (ranking, params) => {
  const head = el('thead', '', [
    el('tr', '', [
      el('th', '', '名次'),
      el('th', '', '板块'),
      sectorSortHeader('日涨幅', 'day', params, sectorOnSort(params)),
      sectorSortHeader('近 5 分钟', 'window5', params, sectorOnSort(params)),
      sectorSortHeader('近 15 分钟', 'window15', params, sectorOnSort(params)),
      el('th', 'num', '上涨 / 有效'),
      el('th', 'num', '封板'),
      el('th', 'num', `成交占比（${SECTOR_WINDOW_LABELS[ranking.window] ?? ranking.window}）`),
    ]),
  ]);
  const body = el(
    'tbody',
    '',
    ranking.rows.flatMap((row) => sectorRowPair(row, ranking, params)),
  );
  const table = el('table', 'table room-sector-table', [head, body]);
  const wrap = el('div', 'table-wrap', table);
  return wrap;
};

const sectorWindowStrip = (ranking) =>
  el('div', 'room-window-strip', [
    el('span', 'label', '窗口'),
    el('span', 'value mono', `5 分钟 ${windowSpanText(ranking.windows.w5)}`),
    el('span', 'value mono', `15 分钟 ${windowSpanText(ranking.windows.w15)}`),
  ]);

const renderSectorsPane = (ranking, params = sectorParamsFromHash()) => {
  if (ranking === null || ranking === undefined) {
    return el('div', 'card room-empty', [
      el('h2', '', '板块榜暂不可用'),
      el('p', '', '读取板块盘中榜失败，稍后会自动重试。'),
    ]);
  }
  const empty = sectorEmptyText(ranking);
  if (empty !== null) {
    return el('div', 'card room-empty', [
      el('h2', '', '板块榜尚未就绪'),
      el('p', '', empty),
      el('p', 'room-caption', '页面只读已发布批次；非交易日与盘前不展示上一交易日的当日盘面数据。'),
    ]);
  }
  const sampledAt = ranking.anchor === null ? '--' : fmtClock(ranking.anchor.sampledAt);
  const detailSlot =
    sectorDetailParamsFromHash().sectorId === null
      ? null
      : el('div', 'room-sector-detail-slot', el('p', 'room-caption', '正在读取板块详情…'));
  return el('div', 'room-sectors', [
    el('div', 'card room-card', [
      el('div', 'card-header', [
        el('div', null, [
          el('h2', '', '板块盘中榜'),
          el(
            'div',
            'card-meta',
            `数据时点 ${sampledAt} · 排序 ${SECTOR_SORT_LABELS[ranking.sort] ?? ranking.sort} · 点表头切换口径`,
          ),
        ]),
        sectorKindSwitch(params),
      ]),
      sectorWindowStrip(ranking),
      sectorTable(ranking, params),
      el(
        'p',
        'room-caption',
        `共 ${ranking.coverage.rowCount} 个板块（目录 ${ranking.coverage.sectorCount} 个，${ranking.coverage.omittedSectorCount} 个无 active 成分未列出）`,
      ),
    ]),
    detailSlot,
    el('div', 'card room-card', [
      el('div', 'card-header', [
        el('div', null, [
          el('h2', '', '口径说明'),
          el('div', 'card-meta', '概念成分可重叠，占比不可加总'),
        ]),
        el(
          'span',
          `room-status room-status-${ranking.turnover.status}`,
          DIMENSION_STATUS_LABELS[ranking.turnover.status] ?? '缺失',
        ),
      ]),
      ranking.turnover.reason === null
        ? el(
            'p',
            'room-caption',
            `全市场分母 ${formatAmount(ranking.turnover.marketAmountDelta ?? 0)}（去重 ${ranking.turnover.marketSampleCount} / ${ranking.turnover.marketTotalCount} 只）`,
          )
        : el('p', 'placeholder', ranking.turnover.reason),
      el(
        'ul',
        'room-warnings',
        ranking.notes.map((note) => el('li', '', note)),
      ),
    ]),
  ]);
};

const renderSectors = (section, ranking, params) => {
  const pane = section.querySelector('.room-pane');
  if (pane === null) return;
  mount(pane, renderSectorsPane(ranking, params));
  setMeta(section, sectorMetaText(ranking));
};

const fetchSectors = async (params) => {
  const result = await callApi(`/api/market/room/sectors${sectorQuery(params)}`, {
    timeoutMs: 15_000,
  });
  return result.ok ? (result.data?.ranking ?? null) : null;
};

const refreshSectors = async (epoch, setStatus, params = sectorParamsFromHash()) => {
  const section = roomSection();
  if (section === null) return;
  const detailParams = sectorDetailParamsFromHash();
  const ranking = await fetchSectors(params);
  if (epoch !== roomEpoch || roomSection()?.hidden !== false) return;
  if (ranking !== null) roomSectorRanking = ranking;
  // 刷新失败时只在同一分类下复用上次结果，避免把行业数据画在概念切换后。
  const fallback = roomSectorRanking?.kind === params.kind ? roomSectorRanking : null;
  const current = ranking ?? fallback;
  renderSectors(section, current, params);
  if (ranking === null) setStatus?.('板块盘中榜刷新失败，保留上次成功结果', true);
  if (detailParams.sectorId === null) return;
  const [detail, core] = await Promise.all([
    fetchSectorDetail({
      sectorId: detailParams.sectorId,
      compareSectorIds: detailParams.compareSectorIds,
      window: params.window,
    }),
    fetchCoreStocks({ sectorId: detailParams.sectorId }),
  ]);
  if (epoch !== roomEpoch || roomSection()?.hidden !== false) return;
  const slot = roomSection()?.querySelector('.room-sector-detail-slot');
  if (slot === null || slot === undefined) return;
  mount(slot, [
    renderSectorDetailPane(detail, {
      ranking: current,
      params: detailParams,
      onToggleCompare: (sectorId) => {
        window.location.hash = sectorDetailHash({
          ...params,
          sectorId: detailParams.sectorId,
          compareSectorIds: toggleCompareSelection(detailParams.compareSectorIds, sectorId),
        });
      },
      onClose: () => {
        window.location.hash = sectorHash(params);
      },
    }),
    renderCoreStocksPane(core),
  ]);
};

/* ---- 成交分布（ticket #40） ---- */

const renderAmount = (section, distribution, params) => {
  const pane = section.querySelector('.room-pane');
  if (pane === null) return;
  mount(pane, renderAmountPane(distribution, params));
  setMeta(section, amountMetaText(distribution));
};

const fetchAmount = async (params) => {
  const result = await callApi(`/api/market/room/amount-distribution${amountQuery(params)}`, {
    timeoutMs: 15_000,
  });
  return result.ok ? (result.data?.distribution ?? null) : null;
};

const refreshAmount = async (epoch, setStatus, params = amountParamsFromHash()) => {
  const section = roomSection();
  if (section === null) return;
  const distribution = await fetchAmount(params);
  if (epoch !== roomEpoch || roomSection()?.hidden !== false) return;
  if (distribution !== null) roomAmountDistribution = distribution;
  // 刷新失败时只在同一分类下复用上次结果，避免把行业数据画在概念切换后。
  const fallback = roomAmountDistribution?.kind === params.kind ? roomAmountDistribution : null;
  renderAmount(section, distribution ?? fallback, params);
  if (distribution === null) setStatus?.('成交分布刷新失败，保留上次成功结果', true);
};

/* ---- 盘中事件（ticket #42） ---- */

const renderEvents = (section, view, params) => {
  const pane = section.querySelector('.room-pane');
  if (pane === null) return;
  mount(pane, renderEventsPane(view, params));
  setMeta(section, eventsMetaText(view));
};

const refreshEvents = async (epoch, setStatus, params = eventsParamsFromHash()) => {
  const section = roomSection();
  if (section === null) return;
  const view = await fetchRoomEvents();
  if (epoch !== roomEpoch || roomSection()?.hidden !== false) return;
  if (view !== null) roomEventsView = view;
  renderEvents(section, view ?? roomEventsView, params);
  if (view === null) setStatus?.('盘中事件刷新失败，保留上次成功结果', true);
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
      el('div', null, [
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
    const tab = roomTabFromHash();
    if (tab === 'overview') void refreshOverview(roomEpoch, setStatus);
    else if (tab === 'sectors') void refreshSectors(roomEpoch, setStatus, sectorParamsFromHash());
    else if (tab === 'turnover') void refreshAmount(roomEpoch, setStatus, amountParamsFromHash());
    else void refreshEvents(roomEpoch, setStatus, eventsParamsFromHash());
  }, REFRESH_MS);
};

/** 进入作战室：渲染外壳 + 当前 tab；三个视图各自读已发布批次。 */
const renderMarketRoom = async (setStatus = () => {}) => {
  const section = roomSection();
  if (section === null) return;
  roomEpoch += 1;
  const epoch = roomEpoch;
  const tab = roomTabFromHash();
  ensureShell(section);
  syncTabs(section, tab);
  if (tab === 'overview') {
    await refreshOverview(epoch, setStatus);
  } else if (tab === 'sectors') {
    await refreshSectors(epoch, setStatus, sectorParamsFromHash());
  } else if (tab === 'turnover') {
    await refreshAmount(epoch, setStatus, amountParamsFromHash());
  } else {
    await refreshEvents(epoch, setStatus, eventsParamsFromHash());
  }
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
  sectorBreadthText,
  sectorDetailFacts,
  sectorDetailNotes,
  sectorEmptyText,
  sectorHash,
  sectorMetaText,
  sectorParamsFromHash,
  sectorQuery,
  sectorRowCells,
  sectorSampleText,
  teardownMarketRoom,
  windowSpanText,
};
