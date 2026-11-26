/* apps/web/public/js/market-room-themes.js —— 作战室「系统题材库」。
 *
 * - 只读 GET /api/market/room/themes：库内已启用题材按固定顺序展示，不按当日涨跌重排；
 * - 日 / 5 / 15 分钟涨幅与日内走势由 core 按各批次当时有效成分计算，前端只排序成分行；
 * - 展开题材显示当时有效成分的同期表现；点击股票打开本地已发布批次的 1 分钟序列；
 * - 原始概念目录 / 成分不在作战室展示，只在来源 / 管理端保留；
 * - 缺失一律显示原因，不补 0、不插值。
 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import { replayAtFromHash, replayQuerySuffix } from './market-room-replay.js';
import { formatAmount, formatClock, formatPct } from './market-shared.js';
import { closeModal, openModal } from './modal.js';
import { $, el } from './ui.js';

const WINDOWS = ['w5', 'w15'];

const EMPTY_TEXTS = {
  no_batch: '尚无已发布的盘中批次',
  pre_open: '盘前尚无当日批次，不展示盘前数据',
  non_trading_day: '非交易日，不展示当日盘面数据',
  no_today_batch: '今日尚无已发布批次',
  no_theme_library: '系统题材库尚未导入或新建题材，请到「设置 → 题材库」维护',
  no_active_theme: '系统题材库里没有已启用题材',
  no_members: '已启用题材当前没有生效成分',
};

const textParam = (params, key) => {
  const value = params.get(key);
  return value === null || value.trim() === '' ? null : value.trim();
};

/** 题材库视图参数：window / at 沿用作战室回放；theme 控制展开的题材。 */
export const themeLibraryParamsFromHash = (hash = window.location.hash) => {
  const params = new URLSearchParams(String(hash ?? '').split('?')[1] ?? '');
  const window = params.get('window');
  return {
    window: WINDOWS.includes(window) ? window : 'w15',
    theme: textParam(params, 'theme'),
    at: replayAtFromHash(hash),
  };
};

export const themeLibraryQuery = (params) => {
  const theme =
    typeof params.theme === 'string' && params.theme.length > 0
      ? `&themeId=${encodeURIComponent(params.theme)}`
      : '';
  return `?window=${encodeURIComponent(params.window)}${theme}${replayQuerySuffix(params.at)}`;
};

/** 只改 theme 参数，保留当前 tab / kind / window / at 等深链接。 */
export const themeLibraryHash = (themeId, hash = window.location.hash) => {
  const base = String(hash ?? '').replace(/^#/, '');
  const [route, rawQuery = ''] = base.split('?');
  const params = new URLSearchParams(rawQuery);
  if (typeof themeId === 'string' && themeId.length > 0) params.set('theme', themeId);
  else params.delete('theme');
  return `${route.length === 0 ? 'market-room' : route}?${params.toString()}`;
};

export const themeLibraryEmptyText = (rotation) => {
  if (rotation === null || rotation === undefined) {
    return '读取系统题材行情失败，稍后会自动重试';
  }
  if (rotation.state !== 'empty') return null;
  return EMPTY_TEXTS[rotation.emptyReason] ?? '暂无题材行情';
};

export const themeLibraryMetaText = (rotation) => {
  if (rotation === null || rotation === undefined) return '系统题材 · 刷新失败，保留上次成功结果';
  if (rotation.state === 'empty') return `系统题材 · ${themeLibraryEmptyText(rotation)}`;
  const sampledAt = rotation.anchor === null ? '--' : formatClock(rotation.anchor.sampledAt);
  return `系统题材 · ${rotation.tradingDate} · ${sampledAt} 批次 · 固定顺序 ${rotation.themes.length} 个`;
};

const pctText = (value) => formatPct(value, true, null);

const metricCell = (metric, className = 'num') => {
  if (metric === null || metric === undefined || metric.value === null) {
    const cell = el('td', `${className} room-missing`, '缺失');
    cell.title = metric?.warnings?.[0] ?? '没有可用样本';
    return cell;
  }
  const tone = metric.value > 0 ? 'text-pos' : metric.value < 0 ? 'text-neg' : '';
  return el('td', `${className} ${tone}`.trim(), pctText(metric.value));
};

const pctCell = (value) => {
  if (value === null || value === undefined) return el('td', 'num room-missing', '缺失');
  const tone = value > 0 ? 'text-pos' : value < 0 ? 'text-neg' : '';
  return el('td', `num ${tone}`.trim(), pctText(value));
};

/** 日内走势折线：只用有值点连线，缺口不插值；全缺失时返回空标记。 */
export const trendPolyline = (points, width = 120, height = 28) => {
  const values = (points ?? []).map((point) => point.value);
  const available = values.filter((value) => Number.isFinite(value));
  if (available.length === 0) return { line: [], min: null, max: null };
  const min = Math.min(...available);
  const max = Math.max(...available);
  const span = max - min;
  const step = values.length <= 1 ? 0 : width / (values.length - 1);
  const line = [];
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) return;
    const x = step * index;
    const y = span === 0 ? height / 2 : height - ((value - min) / span) * height;
    line.push([Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
  });
  return { line, min, max };
};

const trendSvg = (trend) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'room-library-trend');
  svg.setAttribute('viewBox', '0 0 120 28');
  svg.setAttribute('role', 'img');
  const { line, min, max } = trendPolyline(trend?.points ?? []);
  if (line.length === 0) {
    svg.setAttribute('aria-label', '日内走势缺失');
    return svg;
  }
  svg.setAttribute('aria-label', `日内走势 ${line.length} 个点`);
  const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  polyline.setAttribute('points', line.map(([x, y]) => `${x},${y}`).join(' '));
  polyline.setAttribute('fill', 'none');
  polyline.setAttribute('vector-effect', 'non-scaling-stroke');
  polyline.setAttribute(
    'class',
    min !== null && max !== null && (min + max) / 2 < 0 ? 'trend-line neg' : 'trend-line pos',
  );
  svg.append(polyline);
  return svg;
};

const stockTitle = (member, theme) => `${member.name ?? member.code} · ${theme.name}`;

const seriesSummary = (series) => {
  if (series === null || series === undefined) return '1 分钟序列读取失败';
  if (series.state === 'empty')
    return series.emptyReason === undefined ? '1 分钟序列缺失' : '1 分钟序列缺失';
  const last = series.points.at(-1);
  return `点 ${series.coverage.pointCount} · 缺口 ${series.coverage.gapCount} · 最新 ${last?.close ?? '缺失'} · ${formatClock(series.anchor?.sampledAt)}`;
};

export const openStockModal = async (member, theme, anchor) => {
  const facts = el(
    'div',
    'room-stock-modal-facts',
    [
      ['股票', `${member.name ?? ''} ${member.code}`.trim()],
      ['日涨幅', pctText(member.dayChangePct) ?? '缺失'],
      ['近 5 分钟', pctText(member.window5ChangePct) ?? '缺失'],
      ['近 15 分钟', pctText(member.window15ChangePct) ?? '缺失'],
      ['今日累计成交额', member.todayAmount === null ? '缺失' : formatAmount(member.todayAmount)],
      [
        '封板 / 连板',
        member.sealed === null
          ? '缺失（无天梯快照）'
          : member.sealed
            ? `封板${member.ladderLevel === null ? '' : ` · ${member.ladderLevel} 连板`}`
            : '未封板',
      ],
      ['生效起点', formatClock(member.effectiveFrom)],
      ['数据时点', anchor === null ? '缺失' : formatClock(anchor.sampledAt)],
    ].map(([label, value]) =>
      el('div', 'room-stock-modal-fact', [
        el('span', 'label', label),
        el('span', 'value', String(value)),
      ]),
    ),
  );
  const note = el('p', 'room-caption', '正在读取本地已发布批次的 1 分钟序列…');
  const body = el('div', 'room-stock-modal', [
    facts,
    note,
    el('p', 'room-caption', '只呈现可核验行情与成交额，不构成买卖建议。'),
  ]);
  openModal(stockTitle(member, theme), body);
  if (anchor === null) {
    note.textContent = '没有可用于读取序列的批次时点';
    return;
  }
  const result = await callApi(
    `/api/market/room/stock-series?stockId=${encodeURIComponent(member.stockId)}&at=${encodeURIComponent(anchor.sampledAt)}`,
    { timeoutMs: 15_000 },
  );
  if ($('#modal-overlay')?.hidden !== false) return;
  if (!result.ok) {
    note.textContent = '1 分钟序列读取失败';
    return;
  }
  note.textContent = seriesSummary(result.data?.series ?? null);
};

const stockButton = (member, theme, anchor) => {
  const button = el('button', 'room-stock compact');
  button.type = 'button';
  button.dataset.stockId = member.stockId;
  button.setAttribute('data-stock-id', member.stockId);
  button.append(
    el('span', 'room-stock-main', [
      el('strong', '', member.name ?? member.code),
      el('span', 'muted mono', member.name === null ? '' : ` ${member.code}`),
    ]),
  );
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    void openStockModal(member, theme, anchor ?? null);
  });
  return button;
};

export const memberTable = (theme, anchor = null) => {
  const head = el('thead', '', [
    el('tr', '', [
      el('th', '', '股票'),
      el('th', 'num', '日涨幅'),
      el('th', 'num', '5 分钟'),
      el('th', 'num', '15 分钟'),
      el('th', 'num', '今日成交额'),
      el('th', '', '封板 / 连板'),
    ]),
  ]);
  const body = el(
    'tbody',
    '',
    theme.members.map((member) =>
      el('tr', '', [
        el('td', '', stockButton(member, theme, anchor)),
        pctCell(member.dayChangePct),
        pctCell(member.window5ChangePct),
        pctCell(member.window15ChangePct),
        el('td', 'num', member.todayAmount === null ? '缺失' : formatAmount(member.todayAmount)),
        el(
          'td',
          '',
          member.sealed === null
            ? el('span', 'room-missing', '缺失')
            : member.sealed
              ? `封板${member.ladderLevel === null ? '' : ` · ${member.ladderLevel} 连板`}`
              : '未封板',
        ),
      ]),
    ),
  );
  return el('div', 'table-wrap', el('table', 'table room-constituent-table', [head, body]));
};

const toggleButton = (theme, expanded) => {
  const button = el('button', 'room-library-toggle', `${theme.name} · ${theme.memberCount} 只`);
  button.type = 'button';
  button.setAttribute('aria-expanded', String(expanded));
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    window.location.hash = themeLibraryHash(expanded ? null : theme.themeId);
  });
  return button;
};

const notesBlock = (rotation) => {
  const lines = [...(rotation.notes ?? [])].filter(
    (line) => typeof line === 'string' && line.length > 0,
  );
  if (lines.length === 0) return null;
  return el('details', 'room-detail-notes', [
    el('summary', '', `口径与缺失说明（${lines.length} 条）`),
    el(
      'ul',
      'room-warnings',
      lines.map((line) => el('li', '', line)),
    ),
  ]);
};

const emptyBlock = (rotation) => {
  const text = themeLibraryEmptyText(rotation);
  return el('div', 'card room-empty', [el('h2', '', '题材尚未就绪'), el('p', '', text)]);
};

export const renderThemeSectorsPane = (rotation, params = themeLibraryParamsFromHash()) => {
  if (rotation === null || rotation === undefined || rotation.state === 'empty') {
    return emptyBlock(rotation);
  }
  const expanded = params.theme ?? null;
  const head = el('thead', '', [
    el('tr', '', [
      el('th', '', '题材'),
      el('th', 'num', '日涨幅'),
      el('th', 'num', '5 分钟'),
      el('th', 'num', '15 分钟'),
      el('th', '', '日内走势'),
    ]),
  ]);
  const body = el('tbody', '');
  for (const theme of rotation.themes) {
    const isExpanded = theme.themeId === expanded;
    body.append(
      el('tr', isExpanded ? 'expanded' : '', [
        el('td', '', toggleButton(theme, isExpanded)),
        metricCell(theme.day),
        metricCell(theme.window5),
        metricCell(theme.window15),
        el('td', '', trendSvg(theme.trend)),
      ]),
    );
    if (isExpanded) {
      const cell = el('td');
      cell.colSpan = 5;
      cell.append(memberTable(theme, rotation.anchor));
      body.append(el('tr', 'room-library-detail-row', [cell]));
    }
  }
  return el('div', 'room-sectors', [
    el('div', 'card room-card', [
      el('div', 'card-header', [
        el('div', '', [
          el('h2', '', '题材盘中表现'),
          el('div', 'card-meta', `数据时点 ${formatClock(rotation.anchor?.sampledAt)}`),
        ]),
      ]),
      el('div', 'table-wrap', el('table', 'table room-sector-table', [head, body])),
      notesBlock(rotation),
    ]),
  ]);
};

export const fetchThemeRotation = async (params = themeLibraryParamsFromHash()) => {
  const result = await callApi(`/api/market/room/themes${themeLibraryQuery(params)}`, {
    timeoutMs: 15_000,
  });
  return result.ok ? (result.data?.rotation ?? null) : null;
};

export const resetThemeLibraryUiState = () => {
  closeModal();
};
