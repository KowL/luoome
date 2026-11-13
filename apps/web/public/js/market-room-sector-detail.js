/* apps/web/public/js/market-room-sector-detail.js —— 作战室板块详情（走势 / 对照 / 成分）。
 *
 * 设计要点（ticket #39）：
 * - 只读 GET /api/market/room/sector-detail；走势 method 由后端给出，页面原样标注
 *   「成分等权合成（非板块指数）」，不用大盘指数冒充板块走势；
 * - 成分上涨比例独立于板块指数与板块日涨幅展示；
 * - 多题材叠加：最多 3 个对照板块，共用批次时点；领先顺序变化只列事实，不写事件；
 * - 缺失样本、停牌退市、窗口不可比与基准时点差异都在详情内可见；
 * - 成分行可跳到现有行情页（#market?stockId=...&range=3m）。
 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import { replayAtFromHash, replayEmptyNotice, replayHashSuffix } from './market-room-replay.js';
import { stockHref } from './market-room-return.js';
import { formatAmount } from './market-shared.js';
import { el } from './ui.js';

const COMPARE_LIMIT = 3;
const TREND_COLORS = ['#cf4b4b', '#2f7ed8', '#2f9e5f', '#9a63c9'];
const SVG_NS = 'http://www.w3.org/2000/svg';

const EMPTY_TEXTS = {
  no_batch: '尚无已发布的盘中批次',
  pre_open: '盘前尚无当日批次，不展示盘前数据',
  non_trading_day: '非交易日，不展示当日盘面数据',
  no_today_batch: '今日尚无已发布批次',
  no_sector_catalog: '行业 / 概念目录尚未同步',
  no_members: '该板块没有 active 成分',
  sector_not_found: '该板块不在当前目录中（可能已下架或目录尚未同步）',
};

const KIND_LABELS = { industry: '行业', concept: '概念' };
const MEMBER_STATUS_LABELS = {
  listed: '正常',
  suspended: '停牌',
  delisted: '退市',
  unknown: '状态未知',
};

const fmtPct = (value, signed = false) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const sign = signed && value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
};

/** 成交额增量可正可负；formatAmount 只处理非负值，负号由这里补上。 */
const formatDeltaAmount = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value < 0 ? `-${formatAmount(Math.abs(value))}` : formatAmount(value);
};

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

const hashParams = (hash = window.location.hash) =>
  new URLSearchParams(String(hash ?? '').split('?')[1] ?? '');

/** 板块详情的深链接参数：sector 缺失表示未选中；compare 逗号分隔且去重截断；at 与榜单共用。 */
const sectorDetailParamsFromHash = (hash = window.location.hash) => {
  const params = hashParams(hash);
  const sector = params.get('sector');
  const sectorId = sector === null || sector.trim() === '' ? null : sector.trim();
  const compare = [
    ...new Set((params.get('compare') ?? '').split(',').map((value) => value.trim())),
  ]
    .filter((value) => value.length > 0 && value !== sectorId)
    .slice(0, COMPARE_LIMIT);
  return { sectorId, compareSectorIds: compare, at: replayAtFromHash(hash) };
};

/** 板块详情深链接：保留板块榜的 kind / sort / window，附带 sector 与 compare。 */
const sectorDetailHash = (params) => {
  const query = [
    'tab=sectors',
    `kind=${encodeURIComponent(params.kind)}`,
    `sort=${encodeURIComponent(params.sort)}`,
    `window=${encodeURIComponent(params.window)}`,
    `sector=${encodeURIComponent(params.sectorId)}`,
  ];
  if ((params.compareSectorIds ?? []).length > 0) {
    query.push(`compare=${encodeURIComponent([...params.compareSectorIds].join(','))}`);
  }
  const base = `market-room?${query.join('&')}`;
  return `${base}${replayHashSuffix(params.at)}`;
};

/** 板块详情请求路径（纯函数）：口径与对照全部显式带上。 */
const sectorDetailQuery = ({ sectorId, compareSectorIds = [], window, at }) => {
  const query = [`sectorId=${encodeURIComponent(sectorId)}`];
  if (window !== undefined) query.push(`window=${encodeURIComponent(window)}`);
  if (at !== undefined && at !== null) query.push(`at=${encodeURIComponent(at)}`);
  if (compareSectorIds.length > 0) {
    query.push(`compare=${encodeURIComponent([...compareSectorIds].join(','))}`);
  }
  return `?${query.join('&')}`;
};

/** 对照选择：已选则移除，否则追加并截断；不改动入参。 */
const toggleCompareSelection = (current, sectorId, limit = COMPARE_LIMIT) => {
  if (current.includes(sectorId)) return current.filter((value) => value !== sectorId);
  return [...current, sectorId].slice(0, limit);
};

/** 空态文案；ready 返回 null。 */
const sectorDetailEmptyText = (detail) => {
  if (detail?.state !== 'empty') return null;
  const base = EMPTY_TEXTS[detail.emptyReason] ?? '板块详情暂不可用';
  const anchor = detail.anchor;
  return anchor === null || anchor === undefined
    ? base
    : `${base} · 最近批次 ${anchor.tradingDate} ${fmtClock(anchor.sampledAt)}`;
};

/** 页头口径：板块身份 / 交易日 / 数据时点 / 窗口。 */
const detailMetaText = (detail) => {
  if (detail === undefined || detail === null) return '板块详情 · 刷新失败';
  if (detail.state === 'empty') return `板块详情 · ${sectorDetailEmptyText(detail)}`;
  const sector = detail.sector;
  const kind = KIND_LABELS[sector?.kind] ?? sector?.kind ?? '板块';
  const windowLabel = detail.window === 'w5' ? '5 分钟' : '15 分钟';
  return `${sector?.name ?? '--'} · ${kind} ${sector?.vendorCode ?? ''} · 交易日 ${detail.tradingDate ?? '--'} · 数据时点 ${fmtClock(detail.anchor?.sampledAt)} · 窗口 ${windowLabel}`;
};

/** 走势口径文案：method 原样透出，非指数口径必须带原因。 */
const trendMethodText = (trend) => {
  if (trend === undefined || trend === null) return null;
  const label = trend.method === 'sector_index' ? '板块指数走势' : '成分等权合成走势（非板块指数）';
  return {
    label,
    note: trend.methodNote,
    reason: trend.indexFallbackReason,
  };
};

/** 成分上涨比例（独立于板块指数）文案。 */
const breadthAdvanceText = (breadth) => {
  if (breadth === undefined || breadth === null) return null;
  const ratio = breadth.advanceRatio;
  if (ratio === null) {
    return '成分上涨比例缺失（无有效成分）';
  }
  return `成分上涨比例 ${ratio.toFixed(2)}%（上涨 ${breadth.advancing} / 有效 ${breadth.sampleCount}）`;
};

/** 成分样本口径：成分 / 有效 / 缺失 / 停牌退市。 */
const breadthSampleText = (breadth) => {
  if (breadth === undefined || breadth === null) return null;
  return `成分 ${breadth.memberCount} · 有效 ${breadth.sampleCount} · 缺失 ${breadth.missingCount} · 停牌退市 ${breadth.nonTradableCount}`;
};

/** 走势图模型：共用批次时点，缺失值断线；纯函数，便于单测。 */
const trendChartModel = (detail, options = {}) => {
  const width = options.width ?? 640;
  const height = options.height ?? 220;
  const series = [detail?.trend, ...(detail?.comparisons ?? [])].filter(
    (entry) => entry !== null && entry !== undefined,
  );
  if (series.length === 0) return null;
  const pointCount = series[0].points.length;
  if (pointCount === 0) return null;
  const values = series.flatMap((entry) =>
    entry.points.map((point) => point.value).filter((value) => typeof value === 'number'),
  );
  if (values.length === 0) return null;
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const spread = maxValue - minValue;
  const padding = spread === 0 ? 1 : Math.max(0.5, spread * 0.08);
  const yMin = minValue - padding;
  const yMax = maxValue + padding;
  const plot = { left: 46, right: 12, top: 12, bottom: 26 };
  const innerWidth = width - plot.left - plot.right;
  const innerHeight = height - plot.top - plot.bottom;
  const xOf = (index) =>
    pointCount === 1
      ? plot.left + innerWidth / 2
      : plot.left + (innerWidth * index) / (pointCount - 1);
  const yOf = (value) => plot.top + innerHeight - ((value - yMin) / (yMax - yMin)) * innerHeight;

  const modeled = series.map((entry, seriesIndex) => {
    const segments = [];
    let current = [];
    entry.points.forEach((point, index) => {
      if (point.value === null) {
        if (current.length > 0) segments.push(current);
        current = [];
        return;
      }
      current.push([xOf(index), yOf(point.value)]);
    });
    if (current.length > 0) segments.push(current);
    return {
      sectorId: entry.sectorId,
      name: entry.name,
      color: TREND_COLORS[seriesIndex % TREND_COLORS.length],
      segments,
      missingPointCount: entry.points.filter((point) => point.value === null).length,
      baseSampledAt: entry.coverage?.baseSampledAt ?? null,
      lastValue: [...entry.points].reverse().find((point) => point.value !== null)?.value ?? null,
    };
  });

  const tickStep = Math.max(1, Math.ceil(pointCount / 6));
  const xTicks = series[0].points
    .map((point, index) => ({ x: xOf(index), label: fmtClock(point.sampledAt), index }))
    .filter((tick) => tick.index % tickStep === 0 || tick.index === pointCount - 1);
  const yTicks = [0, 0.5, 1].map((ratio) => {
    const value = yMax - (yMax - yMin) * ratio;
    return { y: yOf(value), label: value.toFixed(2) };
  });

  return { width, height, plot, series: modeled, xTicks, yTicks, yMin, yMax, pointCount };
};

const svgNode = (tag, attributes = {}) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
};

const trendChartSvg = (model) => {
  if (model === null) {
    return el('p', 'placeholder', '走势缺失：所选时点没有可用样本。');
  }
  const svg = svgNode('svg', {
    viewBox: `0 0 ${model.width} ${model.height}`,
    class: 'room-detail-chart',
    role: 'img',
    'aria-label': '板块走势对照图',
  });
  for (const tick of model.yTicks) {
    svg.append(
      svgNode('line', {
        x1: model.plot.left,
        x2: model.width - model.plot.right,
        y1: tick.y,
        y2: tick.y,
        class: 'room-chart-grid',
      }),
    );
    const label = svgNode('text', {
      x: model.plot.left - 6,
      y: tick.y + 3,
      class: 'room-chart-label',
      'text-anchor': 'end',
    });
    label.textContent = tick.label;
    svg.append(label);
  }
  for (const tick of model.xTicks) {
    const label = svgNode('text', {
      x: tick.x,
      y: model.height - 8,
      class: 'room-chart-label',
      'text-anchor': 'middle',
    });
    label.textContent = tick.label;
    svg.append(label);
  }
  for (const entry of model.series) {
    for (const segment of entry.segments) {
      if (segment.length === 1) {
        svg.append(
          svgNode('circle', {
            cx: segment[0]?.[0] ?? 0,
            cy: segment[0]?.[1] ?? 0,
            r: 2.5,
            fill: entry.color,
          }),
        );
        continue;
      }
      svg.append(
        svgNode('polyline', {
          points: segment.map(([x, y]) => `${x},${y}`).join(' '),
          fill: 'none',
          stroke: entry.color,
          'stroke-width': 2,
          'stroke-linejoin': 'round',
          'stroke-linecap': 'round',
        }),
      );
    }
  }
  return svg;
};

/** 对照板块候选：当前榜前 6 个（排除目标），已选中的始终保留。 */
const compareCandidates = (ranking, detail) => {
  const targetId = detail?.sector?.sectorId;
  const rows = (ranking?.rows ?? []).filter((row) => row.sectorId !== targetId).slice(0, 6);
  const known = new Set(rows.map((row) => row.sectorId));
  const selected = detail?.comparisons ?? [];
  for (const series of selected) {
    if (known.has(series.sectorId)) continue;
    rows.push({ sectorId: series.sectorId, name: series.name, kind: series.kind });
    known.add(series.sectorId);
  }
  return rows;
};

/** 领先顺序变化：只列出发生变化的时点，附上一时点顺序；无变化时给出事实说明。 */
const leaderChangeLines = (detail) => {
  const names = new Map(
    [detail?.trend, ...(detail?.comparisons ?? [])]
      .filter((series) => series !== null && series !== undefined)
      .map((series) => [series.sectorId, series.name]),
  );
  const points = detail?.leaderOrder ?? [];
  const lines = [];
  for (const [index, point] of points.entries()) {
    if (!point.reordered) continue;
    const current = point.entries.map((entry) => entry.name).join(' › ');
    const previousOrder = (point.previousOrder ?? [])
      .map((sectorId) => names.get(sectorId) ?? sectorId)
      .join(' › ');
    const previousPoint = [...points.slice(0, index)]
      .reverse()
      .find((entry) => entry.entries.length > 0);
    const missing = point.missingSectorIds
      .map((sectorId) => names.get(sectorId) ?? sectorId)
      .join(' / ');
    lines.push({
      sampledAt: point.sampledAt,
      text: `${fmtClock(point.sampledAt)} ${current}`,
      previous:
        previousOrder === '' || previousPoint === undefined
          ? null
          : `${fmtClock(previousPoint.sampledAt)}：${previousOrder}`,
      missing: missing === '' ? null : `该时点缺少：${missing}`,
    });
  }
  return { lines, changed: lines.length > 0 };
};

/** 当前领先顺序（最新时点），用于标题旁的一行事实。 */
const latestLeaderText = (detail) => {
  const point = [...(detail?.leaderOrder ?? [])]
    .reverse()
    .find((entry) => entry.entries.length > 0);
  if (point === undefined) return null;
  return `${fmtClock(point.sampledAt)} 领先：${point.entries.map((entry) => entry.name).join(' › ')}`;
};

/** 缺失样本汇总：逐时点列出缺失 / 停牌 / 不可用原因。 */
const missingSamplesText = (detail) => {
  const points = detail?.trend?.points ?? [];
  const lines = [];
  for (const point of points) {
    if (point.value === null) {
      lines.push(
        `${fmtClock(point.sampledAt)} 走势缺失（样本 ${point.sampleCount} / 成分 ${point.memberCount}）：${point.warnings[0] ?? '无原因'}`,
      );
      continue;
    }
    if (point.missingCount > 0 || point.nonTradableCount > 0 || point.status !== 'complete') {
      lines.push(
        `${fmtClock(point.sampledAt)} 样本 ${point.sampleCount} / 成分 ${point.memberCount} · 缺失 ${point.missingCount} · 停牌退市 ${point.nonTradableCount}`,
      );
    }
  }
  return lines;
};

/** 详情说明去重：口径、缺失原因、对照未解析与基准差异。 */
const detailNotes = (detail) => {
  if (detail === undefined || detail === null || detail.state !== 'ready') return [];
  const notes = [
    ...(detail.notes ?? []),
    detail.trend?.methodNote,
    detail.trend?.indexFallbackReason,
    ...(detail.trend?.warnings ?? []),
    ...(detail.comparisons ?? []).flatMap((series) => [
      `${series.name}：${series.methodNote}`,
      ...(series.warnings ?? []),
    ]),
    ...(detail.breadth?.warnings ?? []),
    ...(detail.day?.warnings ?? []),
    ...(detail.windowMetric?.warnings ?? []),
    ...(detail.turnover?.warnings ?? []),
    ...(detail.limitUp?.warnings ?? []),
  ];
  return [...new Set(notes.filter((note) => typeof note === 'string' && note.length > 0))];
};

/** 成分行文案（纯函数）：缺失一律 null，由渲染层写「缺失」；returnTo 保留作战室现场。 */
const memberRowCells = (member, returnTo = null) => {
  const share =
    member.windowAmountSharePct === null || member.windowAmountSharePct === undefined
      ? null
      : `${member.windowAmountSharePct.toFixed(2)}%`;
  return {
    code: member.code,
    name: member.name ?? null,
    day: fmtPct(member.dayChangePct, true),
    window: fmtPct(member.windowChangePct, true),
    amount: formatDeltaAmount(member.windowAmountDelta),
    share,
    sealed:
      member.sealed === null || member.sealed === undefined
        ? null
        : member.sealed
          ? member.ladderLevel === null
            ? '封板'
            : `封板 ${member.ladderLevel} 板`
          : '未封',
    status: MEMBER_STATUS_LABELS[member.memberStatus] ?? member.memberStatus,
    inBatch: member.inBatch,
    href: stockHref(member.stockId, returnTo),
  };
};

/** 成分排序：缺失日涨幅排最后，再按代码稳定排序（与后端一致的可读顺序）。 */
const sortedMembers = (detail) =>
  [...(detail?.members ?? [])].sort((left, right) => {
    if (left.dayChangePct === null && right.dayChangePct !== null) return 1;
    if (left.dayChangePct !== null && right.dayChangePct === null) return -1;
    if (left.dayChangePct !== null && right.dayChangePct !== null) {
      if (right.dayChangePct !== left.dayChangePct) return right.dayChangePct - left.dayChangePct;
    }
    return left.code.localeCompare(right.code);
  });

/* ---- DOM 渲染 ---- */

const detailCell = (text, className = 'num') => {
  if (text === null) {
    const cell = el('td', `${className} room-missing`, '缺失');
    return cell;
  }
  return el('td', className, text);
};

const toneClass = (value) => (value > 0 ? 'pos' : value < 0 ? 'neg' : '');

const memberTable = (detail, returnTo = null) => {
  const head = el('thead', '', [
    el('tr', '', [
      el('th', '', '成分'),
      el('th', 'num', '日涨幅'),
      el('th', 'num', '窗口涨幅'),
      el('th', 'num', '窗口成交额增量'),
      el('th', 'num', '增量占比'),
      el('th', '', '封板'),
      el('th', '', '状态'),
    ]),
  ]);
  const rows = sortedMembers(detail).map((member) => {
    const cells = memberRowCells(member, returnTo);
    const name = el('a', 'room-member-link', cells.name ?? cells.code);
    name.href = cells.href;
    name.title = `查看 ${member.stockId} 行情`;
    const dayCell = detailCell(cells.day);
    if (cells.day !== null) dayCell.classList.add(toneClass(member.dayChangePct));
    const windowCell = detailCell(cells.window);
    if (cells.window !== null) windowCell.classList.add(toneClass(member.windowChangePct));
    return el('tr', member.inBatch ? '' : 'room-member-missing', [
      el('td', '', [
        name,
        el(
          'span',
          'cell-sub muted',
          cells.inBatch ? member.stockId : `${member.stockId} · 不在锚点批次`,
        ),
      ]),
      dayCell,
      windowCell,
      detailCell(cells.amount),
      detailCell(cells.share),
      detailCell(cells.sealed),
      el('td', '', cells.status),
    ]);
  });
  const table = el('table', 'table room-detail-member-table', [head, el('tbody', '', rows)]);
  return el('div', 'table-wrap', table);
};

const legend = (model) =>
  el(
    'div',
    'room-detail-legend',
    model.series.map((entry) =>
      el('span', 'room-detail-legend-item', [
        el('span', 'room-detail-dot', ''),
        el('span', '', entry.name),
        el('span', 'mono muted', entry.lastValue === null ? '缺失' : entry.lastValue.toFixed(2)),
        el('span', 'muted', `基准 ${fmtClock(entry.baseSampledAt)}`),
        entry.missingPointCount > 0
          ? el('span', 'room-detail-missing', `缺 ${entry.missingPointCount} 点`)
          : null,
      ]),
    ),
  );

const compareStrip = (ranking, detail, params, onToggleCompare) => {
  const selected = new Set(params.compareSectorIds);
  const candidates = compareCandidates(ranking, detail);
  if (candidates.length === 0) {
    return el('p', 'room-caption', '暂无可对照板块（板块榜尚未就绪）。');
  }
  const buttons = candidates.map((candidate) => {
    const active = selected.has(candidate.sectorId);
    const button = el(
      'button',
      `btn btn-outline btn-sm${active ? ' active' : ''}`,
      `${active ? '已叠加' : '+ 叠加'} ${candidate.name}`,
    );
    button.type = 'button';
    button.setAttribute('aria-pressed', String(active));
    button.addEventListener('click', () => onToggleCompare(candidate.sectorId));
    return button;
  });
  return el('div', 'room-detail-compare', [
    el('span', 'room-detail-compare-label muted', `对照题材（最多 ${COMPARE_LIMIT} 个）`),
    ...buttons,
  ]);
};

const renderSectorDetailPane = (
  detail,
  { ranking = null, params, returnTo = null, onToggleCompare = () => {}, onClose = () => {} } = {},
) => {
  const empty = sectorDetailEmptyText(detail);
  if (detail === null || detail === undefined) {
    return el('div', 'card room-empty room-sector-detail', [
      el('h2', '', '板块详情暂不可用'),
      el('p', '', '读取板块详情失败，稍后会自动重试。'),
    ]);
  }
  if (empty !== null) {
    const close = el('button', 'btn btn-outline btn-sm', '关闭详情');
    close.type = 'button';
    close.addEventListener('click', () => onClose());
    const replayNotice = detail.emptyReason === 'no_batch' ? replayEmptyNotice(params?.at) : null;
    return el('div', 'card room-empty room-sector-detail', [
      el('div', 'card-header', [
        el('div', null, [
          el('h2', '', detail.sector?.name ?? '板块详情'),
          el('div', 'card-meta', replayNotice ?? empty),
        ]),
        close,
      ]),
      el(
        'p',
        'room-caption',
        '页面只读已发布批次；非交易日、盘前与缺失样本都不会用旧数据或 0 补齐。',
      ),
    ]);
  }

  const method = trendMethodText(detail.trend);
  const model = trendChartModel(detail);
  const changes = leaderChangeLines(detail);
  const missing = missingSamplesText(detail);
  const close = el('button', 'btn btn-outline btn-sm', '关闭详情');
  close.type = 'button';
  close.addEventListener('click', () => onClose());

  const breadth = detail.breadth;
  const breadthBlock =
    breadth === null
      ? el('p', 'placeholder', '成分上涨比例缺失')
      : el('div', 'room-detail-breadth', [
          el('div', 'room-detail-breadth-value', breadthAdvanceText(breadth) ?? '缺失'),
          el('p', 'room-caption', breadthSampleText(breadth) ?? ''),
          el('div', 'room-detail-breadth-counts', [
            el('span', 'text-pos', `上涨 ${breadth.advancing}`),
            el('span', 'text-neg', `下跌 ${breadth.declining}`),
            el('span', 'muted', `平 ${breadth.unchanged}`),
          ]),
        ]);

  const notes = detailNotes(detail);
  return el('div', 'card room-card room-sector-detail', [
    el('div', 'card-header', [
      el('div', null, [
        el('h2', '', `板块详情 · ${detail.sector?.name ?? '--'}`),
        el('div', 'card-meta', detailMetaText(detail)),
      ]),
      close,
    ]),
    el('div', 'room-detail-method', [
      el('span', 'room-status room-status-partial', method?.label ?? '走势口径缺失'),
      el('p', 'room-caption', method?.note ?? ''),
      method?.reason === null || method?.reason === undefined
        ? null
        : el('p', 'room-warnings-caption', method.reason),
    ]),
    breadthBlock,
    el('div', 'room-detail-chart-block', [
      trendChartSvg(model),
      model === null ? null : legend(model),
      el('p', 'room-caption', latestLeaderText(detail) ?? '领先顺序缺失'),
    ]),
    compareStrip(ranking, detail, params ?? { compareSectorIds: [] }, onToggleCompare),
    el('div', 'room-detail-leaders', [
      el('h3', '', '领先顺序变化'),
      changes.changed
        ? el(
            'ul',
            'room-detail-leader-list',
            changes.lines.map((line) =>
              el('li', '', [
                el('span', 'room-detail-leader-text', line.text),
                line.previous === null ? null : el('span', 'cell-sub muted', line.previous),
                line.missing === null ? null : el('span', 'cell-sub muted', line.missing),
              ]),
            ),
          )
        : el('p', 'room-caption', '所选时点内领先顺序未变化（只呈现事实，不生成事件）。'),
    ]),
    el('div', 'room-detail-members', [
      el('h3', '', '成分明细'),
      el(
        'p',
        'room-caption',
        `共 ${detail.members.length} 只 active 成分；封板状态来自当日连板天梯，缺失写「缺失」不写「未封」。`,
      ),
      memberTable(detail, returnTo),
    ]),
    missing.length > 0
      ? el('div', 'room-detail-missing-block', [
          el('h3', '', '缺失样本'),
          el(
            'ul',
            'room-warnings',
            missing.map((line) => el('li', '', line)),
          ),
        ])
      : el('p', 'room-caption', '所选时点内每个批次都有样本；口径差异见下方说明。'),
    el('details', 'room-detail-notes', [
      el('summary', '', `口径与缺失说明（${notes.length} 条）`),
      el(
        'ul',
        'room-warnings',
        notes.map((note) => el('li', '', note)),
      ),
    ]),
  ]);
};

/** 读取板块详情；失败返回 null，由调用方保留上次结果或写空态。 */
const fetchSectorDetail = async (params) => {
  const result = await callApi(`/api/market/room/sector-detail${sectorDetailQuery(params)}`, {
    timeoutMs: 15_000,
  });
  return result.ok ? (result.data?.detail ?? null) : null;
};

export {
  breadthAdvanceText,
  breadthSampleText,
  COMPARE_LIMIT,
  compareCandidates,
  detailMetaText,
  detailNotes,
  fetchSectorDetail,
  latestLeaderText,
  leaderChangeLines,
  memberRowCells,
  missingSamplesText,
  renderSectorDetailPane,
  sectorDetailEmptyText,
  sectorDetailHash,
  sectorDetailParamsFromHash,
  sectorDetailQuery,
  sortedMembers,
  toggleCompareSelection,
  trendChartModel,
  trendMethodText,
};
