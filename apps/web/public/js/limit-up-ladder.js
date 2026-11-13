// apps/web/public/js/limit-up-ladder.js —— 涨停梯队页面（涨停池 / 涨停统计 / 连板矩阵）。
//
// 设计与取数口径参考同花顺「涨停池与连板天梯」与「涨停情绪市场脉冲」两个实践示例：
// - 三个维度时间范围不同：涨停池与统计按所选交易日取数，连板矩阵是接口固定的近 30 个交易日，
//   页面上分别标注，不把矩阵窗口当成「所选日」的数据；
// - 缺数据一律显示「--」或说明块，不用 0 冒充；盘前 / 非交易日的空池属于正常结果；
// - 涨停原因只做 `limit_up_reason` 原文聚合，不映射成行业，也不改写文案；
// - KPI 与原因分布由 core 在一次取数里算好（limit_up_market tool），前端只负责排版。

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import { stockCodeLink } from './stock-link.js';
import { $, compareValues, el, fmtPct, fmtTime, mount, resultErrorText } from './ui.js';

const WARNING_TEXT = {
  'empty-pool': '所选交易日没有涨停池数据（非交易日 / 盘前 / 数据未更新）',
  'pool-unavailable': '涨停池不可用（上游失败）',
  'empty-statistics': '涨停统计暂无有效值',
  'statistics-unavailable': '涨停统计不可用（上游失败）',
  'ladder-unavailable': '连板矩阵不可用（上游失败）',
};

const BAND_LABEL = {
  seven_plus: '7 板及以上',
  six: '6 板',
  five: '5 板',
  four: '4 板',
  three: '3 板',
  two: '2 板',
  one: '首板',
};

const BAND_OF_COUNT = {
  1: 'one',
  2: 'two',
  3: 'three',
  4: 'four',
  5: 'five',
  6: 'six',
  7: 'seven_plus',
};

/** 矩阵行：天梯接口只覆盖 2 板及以上，按板位从高到低。 */
const LADDER_BANDS = ['seven_plus', 'six', 'five', 'four', 'three', 'two'];
/** 涨停池分组：含首板，按板位从高到低。 */
const POOL_BANDS = ['seven_plus', 'six', 'five', 'four', 'three', 'two', 'one'];
/** 上游「页面板数档位」与池分组的映射；five_plus 是 5 板及以上合并档。 */
const PAGE_BOARD_OF_BAND = {
  one: 'one',
  two: 'two',
  three: 'three',
  four: 'four',
  five: 'five_plus',
  six: 'five_plus',
  seven_plus: 'five_plus',
};

const POOL_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'two_plus', label: '2 板及以上' },
  { key: 'three_plus', label: '3 板及以上' },
  { key: 'one', label: '首板' },
];

const POOL_TABLE_LIMIT = 40;
const BAND_CHIP_LIMIT = 6;

// ---------- 日期与格式化 ----------

const dateInShanghai = () => {
  const sh = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const y = sh.getUTCFullYear();
  const m = String(sh.getUTCMonth() + 1).padStart(2, '0');
  const day = String(sh.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const dateFromUrl = () => {
  const raw = new URLSearchParams(window.location.search).get('date');
  return raw !== null && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : dateInShanghai();
};

const dateToUrl = (date) => {
  const url = new URL(window.location.href);
  url.searchParams.set('date', date);
  window.history.replaceState({}, '', url.toString());
};

/** `2026-11-12` → `11-12`。 */
export const shortDate = (date) => date.slice(5);

export const weekdayOf = (date) => {
  const parsed = new Date(`${date}T00:00:00Z`);
  // getUTCDay(): 0 = 周日
  return Number.isNaN(parsed.getTime()) ? '' : '日一二三四五六'[parsed.getUTCDay()];
};

export const fmtMoney = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '--';
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)} 亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)} 万`;
  return String(Math.round(value));
};

const signedInt = (value) => (value > 0 ? `+${value}` : String(value));

const button = (label, className, onClick) => {
  const node = el('button', className, label);
  node.type = 'button';
  if (onClick !== undefined) node.addEventListener('click', onClick);
  return node;
};

// ---------- 板位与矩阵数据 ----------

export const bandOfPoolEntry = (entry) =>
  entry.continueDayCnt >= 7 ? 'seven_plus' : (BAND_OF_COUNT[entry.continueDayCnt] ?? 'one');

export const groupPoolByBand = (entries) => {
  const groups = new Map(POOL_BANDS.map((band) => [band, []]));
  for (const entry of entries) groups.get(bandOfPoolEntry(entry))?.push(entry);
  for (const list of groups.values()) list.sort((a, b) => b.sealMoney - a.sealMoney);
  return groups;
};

export const bandCountsOfDay = (day) => {
  const counts = { two: 0, three: 0, four: 0, five: 0, six: 0, seven_plus: 0 };
  for (const band of day.bands ?? []) counts[band.band] = band.stocks.length;
  return counts;
};

export const boardSumOfDay = (day) => {
  let sum = 0;
  for (const band of day.bands ?? []) sum += band.stocks.length;
  return sum;
};

/** 窗口内最近一个有连板数据的交易日；盘前当日的空档不算「最近交易日」。 */
export const latestLadderDateWithData = (ladder) => {
  if (ladder === null || ladder.days.length === 0) return null;
  return ladder.days.find((day) => boardSumOfDay(day) > 0)?.date ?? null;
};

export const maxBoardOfDay = (day) => {
  let max = 0;
  for (const band of day.bands ?? []) {
    for (const stock of band.stocks ?? []) max = Math.max(max, stock.boardNum ?? 0);
  }
  return max;
};

// ---------- 头部 / 元信息 ----------

const renderHero = (date, onSelectDate) => {
  const input = el('input', 'date-input', date);
  input.type = 'date';
  input.value = date;
  input.setAttribute('aria-label', '交易日');
  const commit = (force) => {
    const value = input.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
    onSelectDate(value, force);
  };
  input.addEventListener('change', () => commit(false));

  return el('header', 'lum-hero', [
    el('div', 'lum-hero-main', [
      el('span', 'eyebrow', 'Limit-up market'),
      el('h2', 'lum-title', '涨停梯队'),
      el(
        'p',
        'lum-subtitle',
        '涨停池、涨停统计与近 30 个交易日连板矩阵；三者时间范围不同，逐块标注。',
      ),
    ]),
    el('div', 'ladder-controls', [
      el('label', '', '交易日'),
      input,
      button('刷新', 'btn', () => commit(true)),
    ]),
  ]);
};

const renderMeta = (view, requestedDate, onSelectDate) => {
  const { snapshot } = view;
  const chips = [
    el('span', 'lum-chip', `源 · ${snapshot.source}`),
    el(
      'span',
      'lum-chip',
      snapshot.dataAsOf === null ? '数据时间 · --' : `数据时间 · ${fmtTime(snapshot.dataAsOf)}`,
    ),
    el('span', 'lum-chip', `请求交易日 · ${requestedDate}`),
  ];
  const latest = latestLadderDateWithData(snapshot.ladder);
  if (latest !== null && latest !== requestedDate) {
    chips.push(
      button(`矩阵最近有数据交易日 ${latest} · 切换`, 'lum-chip lum-chip-action', () =>
        onSelectDate(latest, false),
      ),
    );
  }
  return el('div', 'lum-chips', chips);
};

const renderWarnings = (warnings) => {
  if (warnings.length === 0) return null;
  return el(
    'div',
    'lum-chips',
    warnings.map((warning) => el('span', 'lum-chip warn', WARNING_TEXT[warning] ?? warning)),
  );
};

// ---------- KPI ----------

const statCard = (label, value, hint, tone) =>
  el('div', 'stat lum-kpi', [
    el('div', 'label', label),
    el('div', tone === undefined ? 'value' : `value ${tone}`, value),
    el('div', 'hint', hint),
  ]);

const renderKpis = (view) => {
  const { snapshot, metrics } = view;
  const stats = snapshot.statistics;
  const empty = snapshot.warnings.includes('empty-pool');
  const show = (raw) => (snapshot.pool === null || empty ? '--' : raw);

  return el('div', 'stat-grid lum-kpis', [
    statCard('涨停家数', show(String(metrics.poolCount)), '涨停池逐股计数', 'pos'),
    statCard('连板家数', show(String(metrics.consecutiveCount)), '连板数 ≥ 2（不含首板）', 'pos'),
    statCard('最高连板', show(`${metrics.maxBoard} 板`), '涨停池最大连板', 'pos'),
    statCard(
      '封板率',
      stats === null ? '--' : (fmtPct(metrics.sealRate) ?? '--'),
      stats === null
        ? '涨停统计不可用'
        : `开板 ${metrics.openCount ?? '--'} 家 / 基数 ${stats.touchedLimitUpStockCount} 家`,
    ),
    statCard(
      '封单留存',
      show(fmtPct(metrics.sealRetentionRate) ?? '--'),
      '当前封单额 ÷ 峰值封单额',
    ),
    statCard('封单总额', show(fmtMoney(metrics.sealAmount)), '当前封单额合计'),
  ]);
};

const renderSubStats = (view) => {
  const { metrics, snapshot } = view;
  if (snapshot.pool === null || snapshot.warnings.includes('empty-pool')) return null;
  const item = (label, value, hint) => {
    const node = el('span', 'lum-substat', [
      el('span', 'lum-substat-label', label),
      el('span', 'lum-substat-value', value),
    ]);
    if (hint !== undefined) node.title = hint;
    return node;
  };
  return el('div', 'lum-substats', [
    item(
      '早封率（≤10:00）',
      fmtPct(metrics.earlySealRate) ?? '--',
      '涨停池里首次封板时间不晚于 10:00 的只数占比',
    ),
    item('峰值封单合计', fmtMoney(metrics.maxSealAmount), '逐股 max_seal_money 之和'),
  ]);
};

// ---------- 连板矩阵 ----------

export const matrixCellStyle = (count, max) => {
  if (count <= 0) return {};
  const ratio = max > 0 ? count / max : 0;
  const alpha = Math.min(0.14 + ratio * 0.72, 0.86);
  return {
    background: `rgba(224, 72, 79, ${alpha.toFixed(2)})`,
    color: alpha > 0.46 ? '#fff' : 'var(--ink)',
  };
};

const renderMatrix = (view, onSelectDate) => {
  const ladder = view.snapshot.ladder;
  if (ladder === null || ladder.days.length === 0) {
    return el('p', 'lum-placeholder', '连板矩阵不可用：上游未返回近 30 个交易日数据。');
  }
  // 接口按「新 → 旧」返回；矩阵按「旧 → 新」从左到右画，最新交易日落在最右侧
  const days = [...ladder.days].reverse();
  const counts = new Map(days.map((day) => [day.date, bandCountsOfDay(day)]));
  const rowMax = new Map(
    LADDER_BANDS.map((band) => [
      band,
      Math.max(0, ...days.map((day) => counts.get(day.date)[band])),
    ]),
  );

  const readout = el('div', 'lum-readout', '将光标移到矩阵格查看当日梯队结构；点击列切换交易日。');
  const showDay = (date) => {
    const day = days.find((item) => item.date === date);
    if (day === undefined) return;
    const parts = LADDER_BANDS.map((band) => `${BAND_LABEL[band]} ${counts.get(date)[band]}`).join(
      ' · ',
    );
    readout.textContent = `${date}（周${weekdayOf(date)}）· 连板 ${boardSumOfDay(day)} 只 · ${parts}`;
  };

  const selected = view.snapshot.date;
  const headCells = days.map((day) => {
    const noData = boardSumOfDay(day) === 0;
    const th = el(
      'th',
      `lum-matrix-date${day.date === selected ? ' is-selected' : ''}${noData ? ' is-no-data' : ''}`,
      [
        el('span', 'lum-matrix-date-label', shortDate(day.date)),
        el('span', 'lum-matrix-date-weekday', weekdayOf(day.date)),
      ],
    );
    const trigger = button('', 'lum-matrix-date-btn', () => onSelectDate(day.date, false));
    trigger.setAttribute('aria-label', `切换到 ${day.date}（周${weekdayOf(day.date)}）`);
    trigger.addEventListener('mouseenter', () => showDay(day.date));
    trigger.addEventListener('focus', () => showDay(day.date));
    th.append(trigger);
    return th;
  });

  const rows = LADDER_BANDS.map((band) => {
    const max = rowMax.get(band) ?? 0;
    const cells = days.map((day) => {
      const count = counts.get(day.date)[band];
      const cell = button(
        String(count),
        `lum-matrix-cell${count === 0 ? ' is-empty' : ''}${day.date === selected ? ' is-selected' : ''}`,
        () => onSelectDate(day.date, false),
      );
      cell.setAttribute('aria-label', `${day.date} ${BAND_LABEL[band]} ${count} 只`);
      Object.assign(cell.style, matrixCellStyle(count, max));
      cell.addEventListener('mouseenter', () => showDay(day.date));
      cell.addEventListener('focus', () => showDay(day.date));
      return el('td', '', [cell]);
    });
    return el('tr', '', [el('th', 'lum-matrix-band', BAND_LABEL[band]), ...cells]);
  });

  const table = el('table', 'lum-matrix', [
    el('thead', '', [el('tr', '', [el('th', 'lum-matrix-corner', '板位'), ...headCells])]),
    el('tbody', '', rows),
  ]);

  return el('div', 'lum-matrix-block', [el('div', 'lum-matrix-wrap', [table]), readout]);
};

const renderMatrixDelta = (view) => {
  const ladder = view.snapshot.ladder;
  if (ladder === null) return null;
  const days = [...ladder.days].reverse();
  const index = days.findIndex((day) => day.date === view.snapshot.date);
  if (index <= 0) return null;
  const curr = days[index];
  const prev = days[index - 1];
  // 当日或前一日没有任何连板行时，"0 比 0" 是缺数据而不是情绪变化，不显示差值
  if (boardSumOfDay(curr) === 0 || boardSumOfDay(prev) === 0) return null;
  const samplesDelta = boardSumOfDay(curr) - boardSumOfDay(prev);
  const topDelta = maxBoardOfDay(curr) - maxBoardOfDay(prev);
  return el('div', 'lum-delta', [
    el('span', 'lum-delta-title', `较 ${prev.date}（矩阵口径）`),
    el(
      'span',
      `lum-delta-item ${samplesDelta >= 0 ? 'pos' : 'neg'}`,
      `连板样本 ${signedInt(samplesDelta)}`,
    ),
    el(
      'span',
      `lum-delta-item ${topDelta >= 0 ? 'pos' : 'neg'}`,
      `最高板 ${signedInt(topDelta)} 板`,
    ),
  ]);
};

// ---------- 所选交易日连板天梯 ----------

const renderBandChip = (entry) => {
  const meta = [
    `封 ${fmtMoney(entry.sealMoney)}`,
    entry.limitUpTime === null ? null : entry.limitUpTime,
  ]
    .filter((part) => part !== null)
    .join(' · ');
  const chip = el('div', 'lum-stock-chip', [
    stockCodeLink(entry.code, entry.name, 'lum-stock-link'),
    el('div', 'lum-stock-meta', meta),
    entry.openTimes !== null && entry.openTimes > 0
      ? el('div', 'lum-stock-meta warn', `开板 ${entry.openTimes} 次`)
      : null,
  ]);
  if (entry.reason !== null) chip.title = `涨停原因：${entry.reason}`;
  return chip;
};

export const promotionRateOf = (band, statistics) => {
  const level = PAGE_BOARD_OF_BAND[band];
  const page = statistics?.pageBoards?.find((item) => item.level === level);
  return page?.promotionRate ?? null;
};

const renderBands = (view, onJumpToBand) => {
  const pool = view.snapshot.pool;
  if (pool === null) return el('p', 'lum-placeholder', '涨停池不可用，无法按板位分组。');
  if (pool.entries.length === 0) {
    return el('p', 'lum-placeholder', '所选交易日没有涨停池数据，板位分组为空。');
  }
  const groups = groupPoolByBand(pool.entries);
  const cards = POOL_BANDS.filter((band) => (groups.get(band)?.length ?? 0) > 0).map((band) => {
    const entries = groups.get(band) ?? [];
    const rate = promotionRateOf(band, view.snapshot.statistics);
    const head = [
      el('span', 'lum-band-label', BAND_LABEL[band]),
      el('span', 'lum-band-count', `${entries.length} 只`),
    ];
    if (rate !== null) {
      const merged = band === 'five' || band === 'six' || band === 'seven_plus';
      head.push(
        el('span', 'lum-band-rate', `晋级 ${fmtPct(rate)}${merged ? '（5 板以上档）' : ''}`),
      );
    }
    const visible = entries.slice(0, BAND_CHIP_LIMIT).map(renderBandChip);
    const body = [el('div', 'lum-band-chips', visible)];
    if (entries.length > visible.length) {
      body.push(
        button(`其余 ${entries.length - visible.length} 只 →`, 'lum-band-more', () =>
          onJumpToBand(band),
        ),
      );
    }
    return el('div', 'lum-band', [el('div', 'lum-band-head', head), ...body]);
  });
  return el('div', 'lum-bands', cards);
};

// ---------- 涨停原因分布 ----------

// 与 core `LIMIT_UP_REASON_OTHER` 同值：浏览器侧不共享 core 模块，靠取值一致对齐
const REASON_OTHER = '其他原因';

const renderReasons = (view) => {
  const reasons = view.reasons ?? [];
  const entries = view.snapshot.pool?.entries ?? [];
  if (view.snapshot.pool === null || reasons.length === 0) {
    return el('p', 'lum-placeholder', '没有可聚合的涨停原因。');
  }
  const distinct = new Set(entries.map((entry) => entry.reason ?? '')).size;
  const max = Math.max(...reasons.map((item) => item.count));
  const meta = el('p', 'lum-reasons-meta', `${entries.length} 条涨停 · ${distinct} 种原因表述`);
  const rows = reasons.map((item) => {
    const isOther = item.reason === REASON_OTHER;
    const fill = el('span', 'lum-reason-fill');
    fill.style.width = `${Math.max(6, (item.count / max) * 100).toFixed(1)}%`;
    const label = el('div', `lum-reason-label${isOther ? ' is-other' : ''}`, item.reason);
    label.title = isOther
      ? `其余 ${item.count} 条涨停的原因未进入前 8 位，合并展示`
      : `涨停原因原文：${item.reason}`;
    return el('div', 'lum-reason', [
      label,
      el('div', 'lum-reason-bar', [fill]),
      el('div', 'lum-reason-count', `${item.count} 家`),
    ]);
  });
  return el('div', 'lum-reasons', [meta, ...rows]);
};

// ---------- 涨停池明细 ----------

export const filterMatches = (entry, filter) => {
  if (filter === 'all') return true;
  if (filter === 'one') return entry.continueDayCnt === 1;
  if (filter === 'two_plus') return entry.continueDayCnt >= 2;
  return entry.continueDayCnt >= 3;
};

const poolSortValue = (entry, key) => {
  if (key === 'time') return entry.limitUpTime;
  if (key === 'seal') return entry.sealMoney;
  return entry.continueDayCnt;
};

/** 缺值（未披露封板时间等）无论升降序都排在最后。 */
export const sortPoolEntries = (entries, sort) => {
  const factor = sort.order === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    const left = poolSortValue(a, sort.key);
    const right = poolSortValue(b, sort.key);
    const leftMissing = left === null || left === undefined;
    const rightMissing = right === null || right === undefined;
    if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
    if (leftMissing && rightMissing) return b.sealMoney - a.sealMoney;
    const primary = compareValues(left, right) * factor;
    return primary !== 0 ? primary : b.sealMoney - a.sealMoney;
  });
};

const sortableTh = (label, key, state, repaint) => {
  const active = state.sort.key === key;
  const arrow = active ? (state.sort.order === 'asc' ? ' ↑' : ' ↓') : '';
  const th = el('th', `sortable num${active ? ' active' : ''}`, `${label}${arrow}`);
  th.addEventListener('click', () => {
    state.sort =
      state.sort.key === key
        ? { key, order: state.sort.order === 'asc' ? 'desc' : 'asc' }
        : { key, order: 'desc' };
    repaint();
  });
  return th;
};

const poolRow = (entry) =>
  el('tr', '', [
    el('td', 'code', stockCodeLink(entry.code, entry.code)),
    el('td', '', [
      el('span', '', entry.name),
      entry.isSt ? el('span', 'lum-tag', 'ST') : null,
      entry.isNew ? el('span', 'lum-tag', '新') : null,
    ]),
    el('td', 'num', entry.continueDayText),
    el('td', 'num', entry.limitUpTime ?? '--'),
    el('td', 'num', entry.openTimes === null ? '--' : String(entry.openTimes)),
    el('td', 'num', entry.price === null ? '--' : entry.price.toFixed(2)),
    el(
      'td',
      entry.changePct !== null && entry.changePct > 0 ? 'num pos' : 'num',
      fmtPct(entry.changePct),
    ),
    el('td', 'num', fmtMoney(entry.sealMoney)),
    (() => {
      const cell = el('td', 'lum-reason-cell', entry.reason ?? '—');
      if (entry.reason !== null) cell.title = `涨停原因原文：${entry.reason}`;
      return cell;
    })(),
  ]);

const buildPoolCard = (view, state, repaint) => {
  const pool = view.snapshot.pool;
  const head = el('div', 'card-header', [
    el('h2', '', '涨停池明细'),
    el(
      'div',
      'card-meta',
      `${pool === null ? '--' : `${pool.entries.length} 只`} · 原因取接口原文`,
    ),
  ]);
  if (pool === null) {
    return [head, el('p', 'lum-placeholder', '涨停池不可用：上游未返回当日涨停池。')];
  }
  if (pool.entries.length === 0) {
    return [head, el('p', 'lum-placeholder', '当日没有涨停池条目。')];
  }

  const toolbar = el(
    'div',
    'lum-table-toolbar',
    POOL_FILTERS.map((filter) => {
      const chip = button(
        filter.label,
        `lum-filter${state.filter === filter.key ? ' active' : ''}`,
        () => {
          state.filter = filter.key;
          state.expanded = false;
          repaint();
        },
      );
      chip.setAttribute('aria-pressed', state.filter === filter.key ? 'true' : 'false');
      return chip;
    }),
  );

  const rows = sortPoolEntries(
    pool.entries.filter((entry) => filterMatches(entry, state.filter)),
    state.sort,
  );
  const visible = state.expanded ? rows : rows.slice(0, POOL_TABLE_LIMIT);

  const nodes = [head, toolbar];
  if (rows.length === 0) {
    nodes.push(el('p', 'lum-placeholder', '当前筛选没有匹配的涨停股票。'));
    return nodes;
  }

  nodes.push(
    el('div', 'table-wrap lum-table-wrap', [
      el('table', 'table lum-table', [
        el('thead', '', [
          el('tr', '', [
            el('th', '', '代码'),
            el('th', '', '名称'),
            sortableTh('连板', 'level', state, repaint),
            sortableTh('封板时间', 'time', state, repaint),
            el('th', 'num', '开板'),
            el('th', 'num', '最新价'),
            el('th', 'num', '涨跌幅'),
            sortableTh('封单额', 'seal', state, repaint),
            el('th', '', '涨停原因'),
          ]),
        ]),
        el('tbody', '', visible.map(poolRow)),
      ]),
    ]),
  );
  if (rows.length > POOL_TABLE_LIMIT) {
    nodes.push(
      el('div', 'lum-table-more', [
        button(
          state.expanded ? `收起（仅显示前 ${POOL_TABLE_LIMIT} 条）` : `显示全部 ${rows.length} 条`,
          'btn btn-outline btn-sm',
          () => {
            state.expanded = !state.expanded;
            repaint();
          },
        ),
      ]),
    );
  }
  return nodes;
};

// ---------- 空态 / 页脚 ----------

const renderEmptyNotice = (view, onSelectDate) => {
  const snapshot = view.snapshot;
  if (snapshot.pool === null) {
    return el('section', 'card lum-panel', [
      el('div', 'card-header', [el('h2', '', '涨停池不可用')]),
      el('p', 'lum-placeholder', '上游涨停池端点失败；统计与矩阵若可用仍会在下方展示。'),
    ]);
  }
  if (snapshot.pool.entries.length > 0) return null;
  const latest = latestLadderDateWithData(snapshot.ladder);
  const canJump = latest !== null && latest !== snapshot.date;
  return el('section', 'card lum-panel lum-notice', [
    el('h2', 'lum-notice-title', `${snapshot.date} 暂无涨停池数据`),
    el(
      'p',
      'lum-notice-text',
      '非交易日、盘前或上游尚未更新时属于正常结果；下方连板矩阵仍按接口固定的最近 30 个交易日展示。',
    ),
    canJump ? button(`查看最近交易日 ${latest}`, 'btn', () => onSelectDate(latest, false)) : null,
  ]);
};

const renderFooter = (view) => {
  const source = view.snapshot.source;
  return el('footer', 'lum-foot', [
    el(
      'p',
      '',
      `数据源：${source} · 涨停池 limit-up-pool · 涨停统计 limit-up-statistics · 连板矩阵 limit-up-ladder`,
    ),
    el(
      'p',
      '',
      '口径：涨停家数 / 连板 / 封单取自涨停池；封板率与档位晋级率取自涨停统计（基数为触板家数）；矩阵为接口固定的近 30 个交易日窗口，与所选交易日无关',
    ),
    el(
      'p',
      '',
      '涨停原因按 limit_up_reason 原文聚合，未映射为行业；本页为数据观察，不构成投资建议',
    ),
  ]);
};

// ---------- 页面入口 ----------

const fetchMarket = async (date) => {
  const result = await callApi(`/api/market/limit-up/market?date=${encodeURIComponent(date)}`);
  if (!result.ok) return { ok: false, message: resultErrorText(result, '涨停市场数据加载失败') };
  if (result.data?.snapshot === undefined) return { ok: false, message: '响应缺少 snapshot 字段' };
  return { ok: true, view: result.data };
};

const renderHeroOnly = () =>
  el('header', 'lum-hero', [
    el('div', 'lum-hero-main', [
      el('span', 'eyebrow', 'Limit-up market'),
      el('h2', 'lum-title', '涨停梯队'),
    ]),
  ]);

export const renderLimitUpLadder = async (setStatus) => {
  const root = $('#route-limit-up');
  if (root === null) return;
  const requestedDate = dateFromUrl();

  const selectDate = (date, force) => {
    if (date === requestedDate && force !== true) return;
    dateToUrl(date);
    void renderLimitUpLadder(setStatus);
  };

  mount(root, el('p', 'lum-loading', `加载 ${requestedDate} 涨停市场数据…`));
  const result = await fetchMarket(requestedDate);
  if (!result.ok) {
    mount(root, [
      renderHeroOnly(),
      el('section', 'card lum-panel', [
        el('h2', '', '加载失败'),
        el('p', 'error', result.message),
        el('p', 'muted', '若提示 FUYAO_API_KEY 未配置，请在项目 .env 中配置后重启 luoome web。'),
      ]),
    ]);
    setStatus(`涨停梯队加载失败：${result.message}`, true);
    return;
  }

  const view = result.view;
  const { snapshot } = view;
  const poolState = { filter: 'all', sort: { key: 'level', order: 'desc' }, expanded: false };
  const poolCard = el('section', 'card lum-panel');
  const repaintPool = () => mount(poolCard, buildPoolCard(view, poolState, repaintPool));

  const jumpToBand = (band) => {
    poolState.filter = band === 'one' ? 'one' : band === 'two' ? 'two_plus' : 'three_plus';
    poolState.expanded = true;
    repaintPool();
    poolCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  repaintPool();

  mount(root, [
    renderHero(requestedDate, selectDate),
    renderMeta(view, requestedDate, selectDate),
    renderWarnings(snapshot.warnings),
    renderKpis(view),
    renderSubStats(view),
    renderEmptyNotice(view, selectDate),
    el('section', 'card lum-panel', [
      el('div', 'card-header', [
        el('h2', '', '连板结构矩阵'),
        el('div', 'card-meta', `近 ${snapshot.ladder?.length ?? '--'} 个交易日 · 点击列切换交易日`),
      ]),
      renderMatrix(view, selectDate),
      renderMatrixDelta(view),
    ]),
    el('div', 'lum-split', [
      el('section', 'card lum-panel', [
        el('div', 'card-header', [
          el('h2', '', `${snapshot.date} · 连板天梯`),
          el('div', 'card-meta', '按涨停池连板数分组 · 封单额为当前值'),
        ]),
        renderBands(view, jumpToBand),
      ]),
      el('section', 'card lum-panel', [
        el('div', 'card-header', [
          el('h2', '', '涨停原因分布'),
          el('div', 'card-meta', 'limit_up_reason 原文聚合 · 未映射行业'),
        ]),
        renderReasons(view),
      ]),
    ]),
    poolCard,
    renderFooter(view),
  ]);

  const latest = snapshot.ladder?.dateList?.[0] ?? null;
  let summary;
  if (snapshot.pool === null) summary = `${snapshot.date} 涨停池不可用`;
  else if (snapshot.pool.entries.length === 0) {
    summary =
      latest !== null && latest !== snapshot.date
        ? `${snapshot.date} 暂无涨停池数据（最近交易日 ${latest}）`
        : `${snapshot.date} 暂无涨停池数据`;
  } else {
    summary = `${snapshot.date} 涨停 ${view.metrics.poolCount} 只 / 最高 ${view.metrics.maxBoard} 板`;
  }
  setStatus(`涨停梯队 ${summary}`);
};
