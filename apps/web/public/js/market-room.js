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

import './room-index-minutes.js';
import { callApi } from './api.js';
import {
  amountMetaText,
  amountParamsFromHash,
  amountQuery,
  renderAmountPane,
} from './market-room-amount.js';
import { amountBlock } from './market-room-board.js';
import {
  eventsMetaText,
  eventsParamsFromHash,
  fetchRoomEvents,
  renderEventsPane,
} from './market-room-events.js';
import {
  hashWithoutReplayAt,
  hashWithReplayAt,
  replayAtFromHash,
  replayBannerText,
  replayEmptyNotice,
  replayHashSuffix,
  replayParam,
  replayQueryPrefix,
  replayQuerySuffix,
} from './market-room-replay.js';
import { fetchCoreStocks, renderCoreStocksPane } from './market-room-roles.js';
import {
  fetchRotation,
  renderOverviewThemePane,
  resetRotationUiState,
  rotationParamsFromHash,
  syncOverviewRotationEdges,
  updateOverviewThemePane,
} from './market-room-rotation.js';
import {
  fetchSectorDetail,
  renderSectorDetailPane,
  sectorDetailHash,
  sectorDetailParamsFromHash,
  toggleCompareSelection,
} from './market-room-sector-detail.js';
import {
  fetchThemeRotation,
  renderThemeSectorsPane,
  resetThemeLibraryUiState,
  themeLibraryMetaText,
  themeLibraryParamsFromHash,
} from './market-room-themes.js';
import { formatClock as fmtClock, formatAmount, formatPct } from './market-shared.js';
import { $, el, mount, sortableHeader } from './ui.js';

const ROOM_TABS = ['overview', 'sectors', 'turnover', 'events'];
const ROOM_TAB_LABELS = {
  overview: '总览',
  sectors: '板块追踪',
  turnover: '成交分布',
  events: '盘中事件',
};

const SECTOR_KINDS = ['industry', 'concept'];
const SECTOR_KIND_LABELS = { industry: '行业', concept: '题材' };
const SECTOR_SORTS = ['day', 'window5', 'window15'];
const SECTOR_SORT_LABELS = { day: '日涨幅', window5: '5 分钟', window15: '15 分钟' };
const SECTOR_WINDOWS = ['w5', 'w15'];
const SECTOR_WINDOW_LABELS = { w5: '5 分钟', w15: '15 分钟' };
const SECTOR_CONCEPT_SCOPES = ['focused', 'all'];

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
/** 时间轴拖动合并窗口：只让最新一次选择落屏。 */
const SEEK_DEBOUNCE_MS = 150;
const ROOM_DISCLAIMER = '本内容仅技术研究，不构成投资建议；投资有风险，决策需自行承担。';

let roomEpoch = 0;
let roomTimer = null;
let seekTimer = null;
let seekToken = 0;
let roomSetStatus = () => {};
/**
 * 最近一次成功的视图数据；请求失败时只在「同一分类 + 同一回放时点」下复用，
 * 避免把最新盘面画进历史回放。
 */
let roomSectorRanking = null;
let roomSectorRankingKey = null;
let roomAmountDistribution = null;
let roomAmountDistributionKey = null;
let roomEventsView = null;
let roomEventsViewKey = null;

/** 回放时点缓存键：null 表示最新模式；不同时点不共用缓存。 */
const replayCacheKey = (at) => (at === null || at === undefined ? '' : new Date(at).toISOString());

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

/** 板块追踪的深链接参数（#market-room?tab=sectors&kind=concept&sort=window5&window=w15&at=...）。 */
const sectorParamsFromHash = (hash = window.location.hash) => {
  const params = new URLSearchParams(String(hash ?? '').split('?')[1] ?? '');
  return {
    kind: pickParam(params, 'kind', SECTOR_KINDS, 'industry'),
    sort: pickParam(params, 'sort', SECTOR_SORTS, 'day'),
    window: pickParam(params, 'window', SECTOR_WINDOWS, 'w15'),
    conceptScope: pickParam(params, 'conceptScope', SECTOR_CONCEPT_SCOPES, 'focused'),
    at: replayAtFromHash(hash),
  };
};

/** 板块榜请求路径（纯函数，便于单测）：口径与回放时点全部显式带上。 */
const sectorQuery = (params) =>
  `?kind=${encodeURIComponent(params.kind)}&sort=${encodeURIComponent(params.sort)}&window=${encodeURIComponent(params.window)}${params.kind === 'concept' ? `&conceptScope=${encodeURIComponent(params.conceptScope ?? 'focused')}` : ''}${replayQuerySuffix(params.at)}`;

/** 板块追踪深链接：切换口径时只改 hash，保留统一时间轴的 at。 */
const sectorHash = (params) =>
  `market-room?tab=sectors&kind=${params.kind}&sort=${params.sort}&window=${params.window}${params.kind === 'concept' ? `&conceptScope=${params.conceptScope ?? 'focused'}` : ''}${replayHashSuffix(params.at)}`;

/** 视图切换：保留同一个回放时点，四个视图跟随同一个 at。 */
const roomHash = (tab, at = null) => `market-room?tab=${tab}${replayHashSuffix(at)}`;

const dimensionStatusLabel = (status) => DIMENSION_STATUS_LABELS[status] ?? '缺失';

/** 百分比文案（百分数单位，与后端 changePct / deltaPct 一致）。 */
/** 总览表格沿用 '--' 作为缺失占位；其它作战室视图传 null 交给渲染层写「缺失」。 */
const fmtPctOrDash = (value, signed = false) => formatPct(value, signed, '--');

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
    : `个股涨幅中位数 ${fmtPctOrDash(value.medianChangePct, true)}`;
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
  const benchmark = `${divergence.indexName} ${fmtPctOrDash(divergence.indexChangePct, true)}`;
  const median = `中位数 ${fmtPctOrDash(divergence.medianChangePct, true)}`;
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
        : `${VERDICT_LABELS[comparison.verdict] ?? comparison.verdict} ${fmtPctOrDash(comparison.deltaPct, true)}`,
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
  if (overview?.state === 'empty') return '';
  const coverage = overview?.coverage?.value;
  if (coverage === undefined) return '数据时点未知';
  return `${coverageLabel(coverage.coverage)} · 交易日 ${coverage.tradingDate} · 数据时点 ${fmtClock(coverage.sampledAt)}`;
};

const missingReasonText = (dimension) => dimension?.warnings?.[0] ?? '该维度暂不可用';

/** 板块榜的缺失原因：取第一条 warning，没有则写缺失。 */
const sectorMissingText = (metric) => metric?.warnings?.[0] ?? '缺失';

const sectorValueText = (metric) => {
  if (metric?.value === null || metric?.value === undefined) return null;
  return fmtPctOrDash(metric.value, true);
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

/** 只有部分维度不完整时才挂状态胶囊，完整时页面上不出现标签。 */
const boardStatus = (dimensions) => {
  const statuses = dimensions.map((dimension) => dimension?.status ?? 'complete');
  if (statuses.includes('unavailable')) return 'unavailable';
  if (statuses.includes('partial')) return 'partial';
  return null;
};

const boardNotes = (dimensions) => {
  const notes = [
    ...new Set(
      dimensions
        .filter((dimension) => dimension !== undefined && dimension.status !== 'complete')
        .flatMap((dimension) => dimension.warnings ?? [])
        .filter((note) => typeof note === 'string' && note.length > 0),
    ),
  ];
  if (notes.length === 0) return null;
  return el('details', 'room-detail-notes', [
    el('summary', '', `口径与缺失说明（${notes.length} 条）`),
    el(
      'ul',
      'room-warnings',
      notes.map((note) => el('li', '', note)),
    ),
  ]);
};

/** 盘面卡的一个指标：标签（小字）在上、数字在下，颜色只表达涨跌。 */
const statItem = (label, value, tone = '') =>
  el('div', 'room-stat', [
    el('span', 'room-stat-label', label),
    el('span', `room-stat-value mono ${tone}`.trim(), value),
  ]);

const toneOf = (value) => {
  if (!Number.isFinite(value)) return '';
  return value > 0 ? 'text-pos' : value < 0 ? 'text-neg' : 'muted';
};

const indexMinutesCard = (overview) => {
  const element = el('room-index-minutes');
  element.indexes = overview.indexes?.value?.values ?? [];
  return element;
};

/** 宽度与短线情绪并成一行指标；样本口径与背离文案进 tooltip，不占版面。 */
const breadthStats = (overview) => {
  const breadth = overview.breadth;
  const limitUp = overview.limitUp;
  const value = breadth.value;
  if (value === undefined) {
    return [el('p', 'room-missing', missingReasonText(breadth))];
  }
  const median = value.medianChangePct;
  const medianNode = statItem('中位数', fmtPctOrDash(median, true), toneOf(median));
  medianNode.title = [breadthMedianText(value), breadthSampleText(value)]
    .filter((text) => text !== null)
    .join(' · ');
  const stats = [
    statItem('上涨', `${value.advancing}`, 'text-pos'),
    statItem('下跌', `${value.declining}`, 'text-neg'),
    statItem('平', `${value.unchanged}`, 'muted'),
    medianNode,
  ];
  const divergence = value.divergence;
  if (divergence !== undefined && divergence !== null) {
    const node = statItem(
      '指数 / 个股',
      divergence.divergent ? '背离' : '同向',
      divergence.divergent ? 'room-warn' : 'muted',
    );
    node.title = divergenceText(value) ?? '';
    stats.push(node);
  }
  if (limitUp.value === undefined) {
    stats.push(el('p', 'room-missing', missingReasonText(limitUp)));
    return stats;
  }
  stats.push(
    statItem('封板', `${limitUp.value.sealedCount}`, 'text-pos'),
    statItem(
      '炸板',
      limitUp.value.brokenCount === null ? '缺失' : `${limitUp.value.brokenCount}`,
      limitUp.value.brokenCount === null ? 'room-missing' : '',
    ),
    statItem(
      '最高连板',
      limitUp.value.maxLadderLevel > 0 ? `${limitUp.value.maxLadderLevel} 板` : '无连板',
    ),
  );
  return stats;
};

/** 总览第一张卡：成交额 + 指数分时 + 宽度 + 短线情绪，同一批次同一时点。 */
const boardCard = (overview, at) => {
  const dimensions = [overview.amount, overview.breadth, overview.limitUp, overview.indexes];
  const status = boardStatus(dimensions);
  const stats = el('div', 'room-board-stats', breadthStats(overview));
  const counts = breadthCountsText(overview.breadth?.value);
  if (counts !== null) stats.setAttribute('aria-label', counts);
  return el('section', `card room-board${at === null ? '' : ' room-board-flat'}`, [
    el('div', 'card-header', [el('h2', '', '盘面'), status === null ? null : statusBadge(status)]),
    amountBlock(overview.amount),
    at === null ? el('div', 'room-board-minutes', indexMinutesCard(overview)) : null,
    stats,
    boardNotes(dimensions),
  ]);
};

const renderOverviewPane = (overview, at, rotation, onSeek) => {
  const empty = emptyStateText(overview);
  if (empty !== null) {
    const replayNotice = overview?.emptyReason === 'no_batch' ? replayEmptyNotice(at) : null;
    return el('div', 'card room-empty', [
      el('h2', '', replayNotice === null ? '当日盘面尚未开始' : '该时点不可回放'),
      el('p', '', replayNotice ?? empty),
    ]);
  }
  return el('div', 'room-overview', [
    el('div', 'room-board-slot', boardCard(overview, at)),
    renderOverviewThemePane(rotation, rotationParamsFromHash(), { onSeek }),
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
    el('details', 'room-detail-notes', [
      el('summary', '', `口径与缺失说明（${notes.length} 条）`),
      el(
        'ul',
        'room-warnings',
        notes.map((note) => el('li', '', note)),
      ),
    ]),
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
  const breadthCell = el('td', 'num room-sector-breadth', cells.breadth);
  breadthCell.title = cells.breadthSub;
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

const sectorVisibleRows = (ranking) => ranking.rows;

const sectorCoverageText = (ranking, params) => {
  const catalogCount = ranking.coverage.catalogSectorCount ?? ranking.coverage.sectorCount;
  if (params.kind === 'concept' && params.conceptScope === 'focused') {
    return `共 ${ranking.coverage.rowCount} 个题材（精选口径；原始目录 ${catalogCount} 个，已过滤 ${ranking.coverage.filteredSectorCount ?? 0} 个非题材标签或完全重复项）`;
  }
  return `共 ${ranking.coverage.rowCount} 个板块（目录 ${ranking.coverage.sectorCount} 个，${ranking.coverage.omittedSectorCount} 个无 active 成分未列出）`;
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
    sectorVisibleRows(ranking).flatMap((row) => sectorRowPair(row, ranking, params)),
  );
  const table = el('table', 'table room-sector-table', [head, body]);
  const wrap = el('div', 'table-wrap', table);
  return wrap;
};

const renderSectorsPane = (ranking, params = sectorParamsFromHash()) => {
  if (ranking === null || ranking === undefined) {
    return el('div', 'card room-empty', [
      el('h2', '', '板块榜暂不可用'),
      el('p', '', '读取板块盘中榜失败，稍后会自动重试。'),
    ]);
  }
  const empty = sectorEmptyText(ranking);
  if (empty !== null) {
    const replayNotice = ranking?.emptyReason === 'no_batch' ? replayEmptyNotice(params.at) : null;
    return el('div', 'card room-empty', [
      el('h2', '', replayNotice === null ? '板块榜尚未就绪' : '该时点不可回放'),
      el('p', '', replayNotice ?? empty),
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
          el('div', 'card-meta', `数据时点 ${sampledAt}`),
        ]),
        el('div', 'room-sector-controls', [sectorKindSwitch(params)]),
      ]),
      sectorTable(ranking, params),
      sectorScopeNotes(ranking, params),
    ]),
    detailSlot,
  ]);
};

/** 榜单口径不铺在页面上：分母、覆盖与缺失原因一并折叠，展开才能核对。 */
const sectorScopeNotes = (ranking, params) => {
  const denominator =
    ranking.turnover.reason === null
      ? `全市场分母 ${formatAmount(ranking.turnover.marketAmountDelta ?? 0)}（去重 ${ranking.turnover.marketSampleCount} / ${ranking.turnover.marketTotalCount} 只）`
      : ranking.turnover.reason;
  const lines = [denominator, sectorCoverageText(ranking, params), ...ranking.notes].filter(
    (line) => typeof line === 'string' && line.length > 0,
  );
  return el('details', 'room-detail-notes', [
    el('summary', '', `口径与缺失说明（${lines.length} 条）`),
    el(
      'ul',
      'room-warnings',
      lines.map((line) => el('li', '', line)),
    ),
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

/** 小屏上板块详情在榜单之后：进入 / 返回时把详情滚进视口，避免用户以为没打开。 */
const NARROW_VIEWPORT = '(max-width: 768px)';

const isNarrowViewport = () =>
  typeof window.matchMedia === 'function' && window.matchMedia(NARROW_VIEWPORT).matches;

const focusSectorDetail = (slot) => {
  if (!isNarrowViewport() || slot.querySelector('.room-sector-detail') === null) return;
  slot.scrollIntoView({ block: 'start' });
};

const refreshThemeSectors = async (epoch, setStatus, params) => {
  const section = roomSection();
  if (section === null) return;
  const rotation = await fetchThemeRotation({
    ...themeLibraryParamsFromHash(),
    window: params.window,
    at: params.at,
  });
  if (epoch !== roomEpoch || roomSection()?.hidden !== false) return;
  const pane = section.querySelector('.room-pane');
  if (pane === null) return;
  mount(
    pane,
    renderThemeSectorsPane(rotation, {
      ...themeLibraryParamsFromHash(),
      window: params.window,
      at: params.at,
    }),
  );
  setMeta(section, themeLibraryMetaText(rotation));
  if (rotation === null) setStatus?.('题材盘中表现刷新失败，保留上次成功结果', true);
};

const refreshSectors = async (
  epoch,
  setStatus,
  params = sectorParamsFromHash(),
  { focusDetail = false } = {},
) => {
  const section = roomSection();
  if (section === null) return;
  if (params.kind === 'concept') {
    await refreshThemeSectors(epoch, setStatus, params);
    return;
  }
  const detailParams = sectorDetailParamsFromHash();
  // 进个股页的返回现场：取本次渲染对应的作战室 hash（含 at / 分类 / 排序 / 窗口 / 选中板块）。
  const returnTo = window.location.hash.replace(/^#/, '');
  const ranking = await fetchSectors(params);
  if (epoch !== roomEpoch || roomSection()?.hidden !== false) return;
  const cacheKey = `${params.kind}:${params.conceptScope}:${replayCacheKey(params.at)}`;
  if (ranking !== null) {
    roomSectorRanking = ranking;
    roomSectorRankingKey = cacheKey;
  }
  // 刷新失败时只在同一分类、同一回放时点下复用上次结果。
  const fallback =
    roomSectorRanking?.kind === params.kind && roomSectorRankingKey === cacheKey
      ? roomSectorRanking
      : null;
  const current = ranking ?? fallback;
  renderSectors(section, current, params);
  if (ranking === null) setStatus?.('板块盘中榜刷新失败，保留上次成功结果', true);
  if (detailParams.sectorId === null) return;
  const [detail, core] = await Promise.all([
    fetchSectorDetail({
      sectorId: detailParams.sectorId,
      compareSectorIds: detailParams.compareSectorIds,
      window: params.window,
      at: params.at,
    }),
    fetchCoreStocks({ sectorId: detailParams.sectorId, at: params.at }),
  ]);
  if (epoch !== roomEpoch || roomSection()?.hidden !== false) return;
  // 板块详情与核心股共用一次批量观察请求，不逐只请求。
  const briefs = await fetchSectorBriefs(sectorBriefStockIds(detail, core));
  if (epoch !== roomEpoch || roomSection()?.hidden !== false) return;
  const slot = roomSection()?.querySelector('.room-sector-detail-slot');
  if (slot === null || slot === undefined) return;
  mount(slot, [
    renderSectorDetailPane(detail, {
      ranking: current,
      params: detailParams,
      returnTo,
      briefs,
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
    renderCoreStocksPane(core, { returnTo, briefs }),
  ]);
  if (focusDetail) focusSectorDetail(slot);
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
  const cacheKey = `${params.kind}:${params.conceptScope}:${replayCacheKey(params.at)}`;
  if (distribution !== null) {
    roomAmountDistribution = distribution;
    roomAmountDistributionKey = cacheKey;
  }
  // 刷新失败时只在同一分类、同一回放时点下复用上次结果。
  const fallback =
    roomAmountDistribution?.kind === params.kind && roomAmountDistributionKey === cacheKey
      ? roomAmountDistribution
      : null;
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
  const view = await fetchRoomEvents(params);
  if (epoch !== roomEpoch || roomSection()?.hidden !== false) return;
  const cacheKey = replayCacheKey(params.at);
  if (view !== null) {
    roomEventsView = view;
    roomEventsViewKey = cacheKey;
  }
  // 刷新失败时只在同一回放时点下复用上次结果：别把最新事件画进历史回放。
  const fallback = roomEventsViewKey === cacheKey ? roomEventsView : null;
  renderEvents(section, view ?? fallback, params);
  if (view === null) setStatus?.('盘中事件刷新失败，保留上次成功结果', true);
};

/** 板块详情 / 核心股行的一次批量观察（P2-6）：失败返回 null，徽标缺失但不打断主视图。 */
const sectorBriefStockIds = (detail, core) => {
  const ids = new Set();
  for (const member of detail?.members ?? []) ids.add(member.stockId);
  for (const kind of ['ignition', 'turnover', 'height']) {
    for (const holder of core?.roles?.[kind]?.holders ?? []) ids.add(holder.stockId);
  }
  return [...ids].filter((id) => typeof id === 'string' && id.length > 0).slice(0, 50);
};

const fetchSectorBriefs = async (stockIds) => {
  if (stockIds.length === 0) return new Map();
  const result = await callApi(
    `/api/stock-briefs?stockIds=${encodeURIComponent(stockIds.join(','))}`,
    { timeoutMs: 15_000 },
  );
  if (!result.ok) return null;
  return new Map((result.data?.items ?? []).map((item) => [item.stockId, item]));
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
        window.location.hash = roomHash(tab, replayAtFromHash());
      });
      return button;
    }),
  );
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', '作战室视图');
  mount(section, [
    el('div', 'route-header room-head', [el('div', null, [el('h1', '', '作战室')]), tabs]),
    el('p', 'room-meta', '--'),
    replayBar(),
    el('div', 'room-pane'),
    el('p', 'room-disclaimer', ROOM_DISCLAIMER),
  ]);
};

/** 顶部回放条：显示当前回放时点并可一键回到最新；最新模式隐藏。 */
const replayBar = () => {
  const bar = el('div', 'room-replay');
  bar.hidden = true;
  bar.setAttribute('role', 'status');
  return bar;
};

const renderReplayBar = (section, at) => {
  const bar = section.querySelector('.room-replay');
  if (bar === null) return;
  const text = replayBannerText(at);
  if (text === null) {
    bar.hidden = true;
    bar.replaceChildren();
    return;
  }
  const button = el('button', 'btn btn-outline btn-sm', '回到最新');
  button.type = 'button';
  button.addEventListener('click', () => {
    window.location.hash = hashWithoutReplayAt();
  });
  mount(bar, [el('span', 'room-replay-text', text), el('span', 'room-replay-sep', '·'), button]);
  bar.hidden = false;
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

/**
 * 时间轴拖动：只改 hash 的 at（replaceState，不堆浏览器历史），合并 150ms 后重取；
 * 每次选择带 token，只有最新一次选择能把结果写回界面（旧响应直接丢弃）。
 */
const seekOverviewAt = (at) => {
  const section = roomSection();
  if (section === null || at === null || at === undefined) return;
  const hash = hashWithReplayAt(at);
  if (window.location.hash !== `#${hash}`) {
    window.history.replaceState(window.history.state, '', `#${hash}`);
  }
  renderReplayBar(section, at);
  const epoch = roomEpoch;
  if (seekTimer !== null) clearTimeout(seekTimer);
  seekTimer = setTimeout(() => {
    seekTimer = null;
    const token = ++seekToken;
    void refreshOverview(epoch, roomSetStatus, at, { token });
  }, SEEK_DEBOUNCE_MS);
};

const renderOverview = (section, overview, at, rotation) => {
  const pane = section.querySelector('.room-pane');
  if (pane === null) return;
  const existing = pane.querySelector('.room-overview');
  const rotationNode = existing?.querySelector('.room-rotation');
  if (
    existing !== null &&
    rotationNode !== null &&
    rotationNode !== undefined &&
    overview?.state === 'ready' &&
    updateOverviewThemePane(rotationNode, rotation, rotationParamsFromHash())
  ) {
    mount(existing.querySelector('.room-board-slot'), boardCard(overview, at));
    setMeta(section, overviewMetaText(overview));
    return;
  }
  mount(pane, renderOverviewPane(overview, at, rotation, seekOverviewAt));
  setMeta(section, overviewMetaText(overview));
  syncOverviewRotationEdges(pane);
};

const fetchOverview = async (at = null) => {
  const result = await callApi(`/api/market/room/overview${replayQueryPrefix(at)}`, {
    timeoutMs: 15_000,
  });
  return result.ok ? (result.data?.overview ?? null) : null;
};

/**
 * 响应只允许写回「当前仍是同一个回放时点」的界面：拖动、轮询与回到最新并发时，
 * 更早发出、更晚返回的请求不会覆盖最新选择。
 */
const isCurrentReplayAt = (at) => replayParam(at) === replayParam(replayAtFromHash());

const refreshOverview = async (epoch, setStatus, at = replayAtFromHash(), options = {}) => {
  const section = roomSection();
  if (section === null) return;
  const overview = await fetchOverview(at);
  if (epoch !== roomEpoch || roomSection()?.hidden !== false) return;
  if (options.token !== undefined && options.token !== seekToken) return;
  if (!isCurrentReplayAt(at)) return;
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
  const anchor = overview.latestBatch?.sampledAt;
  let rotation = null;
  if (overview.state === 'ready' && anchor) {
    rotation = await fetchRotation({ ...rotationParamsFromHash(), at });
    if (epoch !== roomEpoch || roomSection()?.hidden !== false) return;
    if (options.token !== undefined && options.token !== seekToken) return;
    if (!isCurrentReplayAt(at)) return;
  }
  // 刷新不跳顶：先记录滚动位置，渲染后恢复；展开题材由 hash 保持。
  const scrollTop = window.scrollY;
  renderOverview(section, overview, at, rotation);
  if (window.scrollY !== scrollTop) window.scrollTo({ top: scrollTop, left: 0 });
};

const stopTimer = () => {
  if (roomTimer !== null) clearInterval(roomTimer);
  roomTimer = null;
};

const refreshCurrentTab = (setStatus) => {
  if (document.visibilityState !== 'visible') return;
  if (roomSection()?.hidden !== false) return;
  const tab = roomTabFromHash();
  if (tab === 'overview') void refreshOverview(roomEpoch, setStatus, replayAtFromHash());
  else if (tab === 'sectors') void refreshSectors(roomEpoch, setStatus, sectorParamsFromHash());
  else if (tab === 'turnover') void refreshAmount(roomEpoch, setStatus, amountParamsFromHash());
  else void refreshEvents(roomEpoch, setStatus, eventsParamsFromHash());
};

let visibilityBound = false;

/** 重新可见时立即刷新一次，不等下一个 60s 周期。 */
const bindVisibilityRefresh = (setStatus) => {
  if (visibilityBound) return;
  visibilityBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshCurrentTab(setStatus);
  });
};

const startTimer = (setStatus) => {
  stopTimer();
  roomTimer = setInterval(() => {
    refreshCurrentTab(setStatus);
  }, REFRESH_MS);
};

/** 进入作战室：渲染外壳 + 当前 tab；三个视图各自读已发布批次。 */
const renderMarketRoom = async (setStatus = () => {}) => {
  const section = roomSection();
  if (section === null) return;
  roomEpoch += 1;
  const epoch = roomEpoch;
  const tab = roomTabFromHash();
  const at = replayAtFromHash();
  ensureShell(section);
  bindVisibilityRefresh(setStatus);
  roomSetStatus = setStatus;
  syncTabs(section, tab);
  renderReplayBar(section, at);
  if (tab === 'overview') {
    await refreshOverview(epoch, setStatus, at);
  } else if (tab === 'sectors') {
    await refreshSectors(epoch, setStatus, sectorParamsFromHash(), {
      focusDetail: isNarrowViewport() && sectorDetailParamsFromHash().sectorId !== null,
    });
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
  seekToken += 1;
  if (seekTimer !== null) clearTimeout(seekTimer);
  seekTimer = null;
  stopTimer();
  resetThemeLibraryUiState();
  resetRotationUiState();
};

export {
  amountSummary,
  breadthCountsText,
  breadthMedianText,
  breadthSampleText,
  divergenceText,
  emptyStateText,
  overviewMetaText,
  ROOM_DISCLAIMER,
  renderMarketRoom,
  roomHash,
  roomTabFromHash,
  sectorBreadthText,
  sectorCoverageText,
  sectorDetailFacts,
  sectorDetailNotes,
  sectorEmptyText,
  sectorHash,
  sectorMetaText,
  sectorParamsFromHash,
  sectorQuery,
  sectorRowCells,
  sectorSampleText,
  sectorVisibleRows,
  teardownMarketRoom,
  windowSpanText,
};
