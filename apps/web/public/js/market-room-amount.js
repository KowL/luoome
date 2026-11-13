/* apps/web/public/js/market-room-amount.js —— 作战室「成交分布」视图（ticket #40）。
 *
 * 设计要点：
 * - 只读：数据来自 GET /api/market/room/amount-distribution，刷新不触发采集；
 * - 同一张榜给出窗口成交占比、上一窗口占比与百分点环比；环比带正负号与红涨绿跌配色；
 * - 集中度只展示后端选定的 CR3，口径定义随响应下发，前端不另写一套说法；
 * - 缺失一律写「缺失」并给出原因：分母无效、窗口缺样本、跨午休、停牌与漏采都不补零；
 * - 概念成分可重叠，页面明写占比不可加总。
 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import {
  replayAtFromHash,
  replayEmptyNotice,
  replayHashSuffix,
  replayQuerySuffix,
} from './market-room-replay.js';
import { formatAmount } from './market-shared.js';
import { el } from './ui.js';

const AMOUNT_KINDS = ['industry', 'concept'];
const AMOUNT_KIND_LABELS = { industry: '行业', concept: '概念' };
const AMOUNT_WINDOWS = ['w5', 'w15'];
const AMOUNT_WINDOW_LABELS = { w5: '5 分钟', w15: '15 分钟' };

const AMOUNT_EMPTY_TEXTS = {
  no_batch: '尚无已发布的盘中批次',
  pre_open: '盘前尚无当日批次，不展示盘前数据',
  non_trading_day: '非交易日，不展示当日盘面数据',
  no_today_batch: '今日尚无已发布批次',
  no_sector_catalog: '行业 / 概念目录尚未同步',
  no_members: '目录里没有带 active 成分的板块',
};

const DIMENSION_STATUS_LABELS = { complete: '完整', partial: '部分可用', unavailable: '缺失' };

const pickParam = (params, key, allowed, fallback) => {
  const value = params.get(key);
  return value !== null && allowed.includes(value) ? value : fallback;
};

/** 成交分布深链接参数（#market-room?tab=turnover&kind=concept&window=w5&at=...）。 */
const amountParamsFromHash = (hash = window.location.hash) => {
  const params = new URLSearchParams(String(hash ?? '').split('?')[1] ?? '');
  return {
    kind: pickParam(params, 'kind', AMOUNT_KINDS, 'industry'),
    window: pickParam(params, 'window', AMOUNT_WINDOWS, 'w15'),
    at: replayAtFromHash(hash),
  };
};

/** 请求路径（纯函数）：口径与回放时点显式带在 URL 上，便于与服务端日志对照。 */
const amountQuery = (params) =>
  `?kind=${encodeURIComponent(params.kind)}&window=${encodeURIComponent(params.window)}${replayQuerySuffix(params.at)}`;

const amountHash = (params) =>
  `market-room?tab=turnover&kind=${params.kind}&window=${params.window}${replayHashSuffix(params.at)}`;

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

const dimensionStatusLabel = (status) => DIMENSION_STATUS_LABELS[status] ?? '缺失';

/** 占比文案；缺失返回 null，由渲染层写「缺失」「--」。 */
const amountShareText = (metric) => {
  if (metric?.value === null || metric?.value === undefined) return null;
  return `${metric.value.toFixed(2)}%`;
};

/** 环比文案：百分点，正数带 + 号；缺失返回 null。 */
const amountDeltaText = (delta) => {
  if (delta?.value === null || delta?.value === undefined) return null;
  const sign = delta.value > 0 ? '+' : '';
  return `${sign}${delta.value.toFixed(2)}pp`;
};

/** 环比配色：成交占比上升为红（text-pos），下降为绿（text-neg）。 */
const amountDeltaTone = (delta) => {
  if (delta?.value === null || delta?.value === undefined) return 'muted';
  if (delta.value > 0) return 'text-pos';
  if (delta.value < 0) return 'text-neg';
  return 'muted';
};

/** 集中度文案：CR3 数值 + 参与前 3 名的板块名；口径不可用时返回 null。 */
const amountConcentrationText = (concentration) => {
  if (concentration?.value === null || concentration?.value === undefined) return null;
  const names = (concentration.top ?? []).map((entry) => entry.name).join(' · ');
  return names === ''
    ? `${concentration.value.toFixed(2)}%`
    : `${concentration.value.toFixed(2)}%（${names}）`;
};

/** 集中度缺失原因；可用时返回 null。 */
const amountConcentrationReason = (concentration) => {
  if (concentration === null || concentration === undefined) return '集中度缺失';
  if (concentration.value !== null && concentration.value !== undefined) return null;
  return concentration.reason ?? '集中度缺失';
};

/** 样本口径：有效成分（分母）/ 成分 / 缺失 / 停牌退市，全部写出来。 */
const amountSampleText = (metric) => {
  if (metric === null || metric === undefined) return null;
  return `有效 ${metric.sampleCount} / 成分 ${metric.memberCount} · 缺失 ${metric.missingCount} · 停牌退市 ${metric.nonTradableCount}`;
};

/** 分子 / 分母：窗口成交额增量对照全市场去重增量。 */
const amountNumeratorText = (row, distribution) => {
  const numerator = row?.share?.numeratorAmount;
  const denominator = distribution?.turnover?.current?.marketAmountDelta;
  if (numerator === null || numerator === undefined) return null;
  if (denominator === null || denominator === undefined) return null;
  return `${formatAmount(numerator)} / ${formatAmount(denominator)}`;
};

/** 窗口两端与跨度；不可比时写明原因，不显示 0。 */
const amountWindowText = (ref) => {
  if (ref === undefined || ref === null) return '窗口缺失';
  if (ref.status === 'unavailable') return `缺失：${ref.reason ?? '窗口不可比'}`;
  const start = fmtClock(ref.startSampledAt);
  const end = fmtClock(new Date(new Date(ref.startSampledAt).getTime() + (ref.spanMs ?? 0)));
  const suffix = ref.status === 'partial' ? '（批次不完整）' : '';
  return `${start} → ${end} · ${Math.round((ref.spanMs ?? 0) / 60_000)} 分钟${suffix}`;
};

/** 表格单元格文案（纯函数）：缺失一律 null，由渲染层写「缺失」。 */
const amountRowCells = (row) => ({
  rank: row.rank === null || row.rank === undefined ? '—' : String(row.rank),
  share: amountShareText(row.share),
  previous: amountShareText(row.previousShare),
  delta: amountDeltaText(row.deltaPp),
  deltaTone: amountDeltaTone(row.deltaPp),
  sample: amountSampleText(row.share),
});

/** 页头口径：分类 / 交易日 / 数据时点 / 窗口 / 环比单位。 */
const amountMetaText = (distribution) => {
  if (distribution === undefined || distribution === null) {
    return '成交分布 · 刷新失败，保留上次成功结果';
  }
  if (distribution.state === 'empty') return `成交分布 · ${amountEmptyText(distribution)}`;
  const kind = AMOUNT_KIND_LABELS[distribution.kind] ?? distribution.kind;
  const windowLabel = AMOUNT_WINDOW_LABELS[distribution.window] ?? distribution.window;
  const sampledAt = distribution.anchor === null ? '--' : fmtClock(distribution.anchor.sampledAt);
  return `${kind} · 交易日 ${distribution.tradingDate} · 数据时点 ${sampledAt} · ${windowLabel}窗口 · 环比单位 pp`;
};

/** 空态文案；ready 返回 null。 */
const amountEmptyText = (distribution) => {
  if (distribution?.state !== 'empty') return null;
  const base = AMOUNT_EMPTY_TEXTS[distribution.emptyReason] ?? '暂无成交分布数据';
  const anchor = distribution.anchor;
  return anchor === null || anchor === undefined
    ? base
    : `${base} · 最近批次 ${anchor.tradingDate} ${fmtClock(anchor.sampledAt)}`;
};

/** 口径说明：全局口径 + 分母 / 窗口 / 集中度原因 + 行内缺失原因（去重后展示）。 */
const amountScopeNotes = (distribution) => {
  if (distribution === null || distribution === undefined) return [];
  const notes = [
    ...(distribution.notes ?? []),
    distribution.turnover?.current?.reason,
    distribution.turnover?.previous?.reason,
    distribution.windows?.current?.reason,
    distribution.windows?.previous?.reason,
    amountConcentrationReason(distribution.concentration),
  ];
  for (const row of distribution.rows ?? []) {
    notes.push(...(row.share?.warnings ?? []));
    notes.push(...(row.previousShare?.warnings ?? []));
    notes.push(...(row.deltaPp?.warnings ?? []));
  }
  const clean = notes.filter((note) => typeof note === 'string' && note.length > 0);
  return [...new Set(clean)];
};

/* ---- DOM 渲染 ---- */

const amountStatusBadge = (status) =>
  el('span', `room-status room-status-${status}`, dimensionStatusLabel(status));

const amountSwitch = (label, values, labels, active, onPick) => {
  const buttons = values.map((value) => {
    const button = el('button', 'btn btn-outline btn-sm', labels[value]);
    button.type = 'button';
    button.classList.toggle('active', active === value);
    button.setAttribute('aria-pressed', String(active === value));
    button.addEventListener('click', () => {
      if (active === value) return;
      onPick(value);
    });
    return button;
  });
  const group = el('div', 'room-kind-switch', buttons);
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', label);
  return group;
};

const amountFact = (label, value) =>
  el('div', 'room-fact', [el('span', 'label', label), el('span', 'value', value ?? '缺失')]);

const missingCell = (title) => {
  const cell = el('td', 'num room-missing', '缺失');
  cell.title = title;
  return cell;
};

const amountRow = (row, distribution) => {
  const cells = amountRowCells(row);
  const shareCell =
    cells.share === null
      ? missingCell(row.share?.warnings?.[0] ?? '窗口成交占比缺失')
      : el('td', 'num', [el('span', '', cells.share), el('span', 'cell-sub muted', cells.sample)]);
  const previousCell =
    cells.previous === null
      ? missingCell(row.previousShare?.warnings?.[0] ?? '上一窗口占比缺失')
      : el('td', 'num', cells.previous);
  const deltaCell =
    cells.delta === null
      ? missingCell(row.deltaPp?.reason ?? '环比缺失')
      : el('td', `num ${cells.deltaTone}`, cells.delta);
  return el('tr', 'room-sector-row', [
    el('td', 'num muted', cells.rank),
    el('td', '', [
      el('span', 'room-sector-name', row.name),
      el(
        'span',
        'cell-sub muted',
        `${AMOUNT_KIND_LABELS[row.kind] ?? row.kind} · ${row.vendorCode}`,
      ),
    ]),
    shareCell,
    previousCell,
    deltaCell,
    el('td', 'num muted', amountNumeratorText(row, distribution) ?? '缺失'),
  ]);
};

const amountTable = (distribution) => {
  const windowLabel = AMOUNT_WINDOW_LABELS[distribution.window] ?? distribution.window;
  const head = el('thead', '', [
    el('tr', '', [
      el('th', '', '名次'),
      el('th', '', '板块'),
      el('th', 'num', `成交占比（${windowLabel}）`),
      el('th', 'num', '上一窗口'),
      el('th', 'num', '环比（pp）'),
      el('th', 'num', '增量 / 全市场'),
    ]),
  ]);
  const body = el(
    'tbody',
    '',
    distribution.rows.map((row) => amountRow(row, distribution)),
  );
  return el('div', 'table-wrap', el('table', 'table room-sector-table', [head, body]));
};

const amountWindowStrip = (distribution) =>
  el('div', 'room-window-strip', [
    el('span', 'label', '窗口'),
    el('span', 'value mono', `当前 ${amountWindowText(distribution.windows.current)}`),
    el('span', 'value mono', `上一窗口 ${amountWindowText(distribution.windows.previous)}`),
  ]);

const amountConcentrationCard = (distribution) => {
  const concentration = distribution.concentration;
  const text = amountConcentrationText(concentration);
  return el('div', 'card room-card', [
    el('div', 'card-header', [
      el('div', null, [
        el('h2', '', '成交集中度'),
        el('div', 'card-meta', `口径 ${concentration.basis} · 占比不可加总，只作集中度指示值`),
      ]),
      amountStatusBadge(concentration.status),
    ]),
    text === null
      ? el('p', 'placeholder', amountConcentrationReason(concentration))
      : el('div', 'room-facts', [
          amountFact(`${concentration.basis} 前 3 名占比合计`, text),
          amountFact('有可用占比的板块', `${concentration.sectorCount} 个`),
        ]),
    el('p', 'room-caption', concentration.definition),
  ]);
};

const amountScopeCard = (distribution) => {
  const notes = amountScopeNotes(distribution);
  return el('div', 'card room-card', [
    el('div', 'card-header', [
      el('div', null, [
        el('h2', '', '口径说明'),
        el('div', 'card-meta', '概念重叠 · 漏采 · 停牌 · 分母无效'),
      ]),
      amountStatusBadge(distribution.turnover.current.status),
    ]),
    distribution.turnover.current.reason === null
      ? el(
          'p',
          'room-caption',
          `全市场分母 ${formatAmount(distribution.turnover.current.marketAmountDelta ?? 0)}（去重 ${distribution.turnover.current.marketSampleCount} / ${distribution.turnover.current.marketTotalCount} 只）；上一窗口分母 ${
            distribution.turnover.previous.reason === null
              ? formatAmount(distribution.turnover.previous.marketAmountDelta ?? 0)
              : '缺失'
          }`,
        )
      : el('p', 'placeholder', distribution.turnover.current.reason),
    el(
      'ul',
      'room-warnings',
      notes.map((note) => el('li', '', note)),
    ),
  ]);
};

const renderAmountPane = (distribution, params = amountParamsFromHash()) => {
  if (distribution === null || distribution === undefined) {
    return el('div', 'card room-empty', [
      el('h2', '', '成交分布暂不可用'),
      el('p', '', '读取成交分布失败，稍后会自动重试。'),
    ]);
  }
  const empty = amountEmptyText(distribution);
  if (empty !== null) {
    const replayNotice =
      distribution?.emptyReason === 'no_batch' ? replayEmptyNotice(params.at) : null;
    return el('div', 'card room-empty', [
      el('h2', '', replayNotice === null ? '成交分布尚未就绪' : '该时点不可回放'),
      el('p', '', replayNotice ?? empty),
      el(
        'p',
        'room-caption',
        '页面只读已发布批次；非交易日、盘前与早于最早可信样本的时点都不展示盘面数据。',
      ),
    ]);
  }
  const sampledAt = distribution.anchor === null ? '--' : fmtClock(distribution.anchor.sampledAt);
  return el('div', 'room-sectors', [
    el('div', 'card room-card', [
      el('div', 'card-header', [
        el('div', null, [
          el('h2', '', '窗口成交占比'),
          el('div', 'card-meta', `数据时点 ${sampledAt} · 点按钮切换窗口 / 分类`),
        ]),
        amountSwitch('板块分类', AMOUNT_KINDS, AMOUNT_KIND_LABELS, params.kind, (kind) => {
          window.location.hash = amountHash({ ...params, kind });
        }),
      ]),
      amountSwitch('窗口长度', AMOUNT_WINDOWS, AMOUNT_WINDOW_LABELS, params.window, (next) => {
        window.location.hash = amountHash({ ...params, window: next });
      }),
      amountWindowStrip(distribution),
      amountTable(distribution),
      el(
        'p',
        'room-caption',
        `共 ${distribution.coverage.rowCount} 个板块（目录 ${distribution.coverage.sectorCount} 个，${distribution.coverage.omittedSectorCount} 个无 active 成分未列出）`,
      ),
    ]),
    amountConcentrationCard(distribution),
    amountScopeCard(distribution),
  ]);
};

export {
  amountConcentrationReason,
  amountConcentrationText,
  amountDeltaText,
  amountDeltaTone,
  amountEmptyText,
  amountHash,
  amountMetaText,
  amountNumeratorText,
  amountParamsFromHash,
  amountQuery,
  amountRowCells,
  amountSampleText,
  amountScopeNotes,
  amountShareText,
  amountWindowText,
  renderAmountPane,
};
