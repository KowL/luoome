/* apps/web/public/js/market-room-rotation.js —— 作战室总览「题材轮动」。
 *
 * 设计要点（docs/prd/market-room-theme-rotation.md）：
 * - 画面中间一条水平零线：上排从左侧起按当前口径涨幅降序，下排按跌幅绝对值降序；
 *   持平和缺数不占列，只在卡片头部计数并收纳名单；
 * - 卡片中性底色、等宽列，题材名与涨跌幅固定在卡片顶部，个股按当前方向从强到弱排列；
 *   净高只由题材自身幅度决定（h = clamp(h_min, h_min + k·max(0, |v| − v₀), h_max)），
 *   标尺常量按口径写死，跨时点、跨题材不变；
 * - 时间轴是共享回放时点：批次清单取当日全部已发布批次，滑块天然跳过午休与缺批，
 *   拖动只改 hash 的 at（replaceState），由上层合并约 150ms 后重取，旧响应不得覆盖新选择；
 * - 拖动期间不重建滑块节点、不做高度过渡，松手后恢复 180ms 过渡；
 * - 点题材名展开全部成分明细（复用 memberTable / themeLibraryHash 深链接），
 *   点个股打开现有股票弹层，弹层继承当前回放时点。
 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import { replayAtFromHash } from './market-room-replay.js';
import {
  memberTable,
  openStockModal,
  themeLibraryEmptyText,
  themeLibraryHash,
  themeLibraryQuery,
} from './market-room-themes.js';
import { formatClock, formatPct } from './market-shared.js';
import { openModal } from './modal.js';
import { el } from './ui.js';

/** 两个可切换口径：日涨幅 / 近 15 分钟。 */
const METRICS = ['day', 'w15'];
const METRIC_LABELS = { day: '日涨幅', w15: '近 15 分钟' };
const MAX_LEADERS = 5;
const NARROW_QUERY = '(max-width: 720px)';

/**
 * 涨跌标尺常量（与设计一致，写死在前端）：v₀ 以内不加高，k 为每 pp 的像素，
 * h_min 容纳题材名 + 涨跌幅 + 五行股票，h_max 约 1.6 倍 h_min；窄屏另有一套。
 */
export const ROTATION_SCALES = {
  day: {
    zero: 1.0,
    perPp: 24,
    min: { desktop: 176, narrow: 158 },
    max: { desktop: 288, narrow: 240 },
  },
  w15: {
    zero: 0.3,
    perPp: 110,
    min: { desktop: 176, narrow: 158 },
    max: { desktop: 288, narrow: 240 },
  },
};

/** 题材在当前口径下的指标行（day / window15）。 */
export const rotationMetricOf = (theme, metric) =>
  metric === 'day' ? theme?.day : theme?.window15;

/** 题材卡前五只：上涨按涨幅降序、下跌按跌幅绝对值降序，缺数已跳过。 */
export const rotationLeadersOf = (theme, metric) =>
  (metric === 'day' ? theme?.leaders?.day : theme?.leaders?.window) ?? [];

/** 卡片净高：只由题材自身幅度决定，与个股数量、其他题材极值无关。 */
export const rotationCardHeight = (metric, value, narrow = false) => {
  const scale = ROTATION_SCALES[metric] ?? ROTATION_SCALES.day;
  const hMin = narrow ? scale.min.narrow : scale.min.desktop;
  const hMax = narrow ? scale.max.narrow : scale.max.desktop;
  if (typeof value !== 'number' || !Number.isFinite(value)) return hMin;
  const extra = scale.perPp * Math.max(0, Math.abs(value) - scale.zero);
  return Math.round(Math.min(hMax, hMin + extra) * 10) / 10;
};

const isNarrowViewport = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia(NARROW_QUERY).matches;

const themeTieBreak = (left, right) =>
  (left.theme.order ?? 0) - (right.theme.order ?? 0) ||
  String(left.theme.themeId).localeCompare(String(right.theme.themeId));

/**
 * 拆排：上排只收涨幅 > 0、下排只收跌幅 < 0，各自从第一列起排；持平和缺数不占列。
 * 同值按维护顺序、稳定 ID 定序。
 */
export const rotationBoards = (rotation, metric) => {
  const up = [];
  const down = [];
  const flat = [];
  const missing = [];
  for (const theme of rotation?.themes ?? []) {
    const row = rotationMetricOf(theme, metric);
    const value = row?.value;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      missing.push({ theme, metric: row });
      continue;
    }
    if (value > 0) up.push({ theme, value });
    else if (value < 0) down.push({ theme, value });
    else flat.push({ theme, value });
  }
  up.sort((left, right) => right.value - left.value || themeTieBreak(left, right));
  down.sort((left, right) => left.value - right.value || themeTieBreak(left, right));
  return { up, down, flat, missing };
};

/** 当前渲染时点在时间轴批次上的下标；找不到时退回不晚于该时点的最后一批。 */
export const rotationBatchIndex = (batches, anchor) => {
  const list = batches ?? [];
  if (list.length === 0) return 0;
  const sampledAt = anchor?.sampledAt === undefined ? null : new Date(anchor.sampledAt).getTime();
  if (sampledAt === null || Number.isNaN(sampledAt)) return list.length - 1;
  const exact = list.findIndex((batch) => new Date(batch.sampledAt).getTime() === sampledAt);
  if (exact !== -1) return exact;
  let index = 0;
  list.forEach((batch, position) => {
    if (new Date(batch.sampledAt).getTime() <= sampledAt) index = position;
  });
  return index;
};

/** 总览题材区的视图参数：metric 只作用于轮动图，theme 沿用现有的成分展开深链接。 */
export const rotationParamsFromHash = (hash = window.location.hash) => {
  const params = new URLSearchParams(String(hash ?? '').split('?')[1] ?? '');
  const metric = params.get('metric');
  const theme = params.get('theme');
  return {
    metric: METRICS.includes(metric) ? metric : 'w15',
    theme: theme === null || theme.trim() === '' ? null : theme.trim(),
    at: replayAtFromHash(hash),
  };
};

/** 轮动图请求：固定要 15 分钟口径（卡内两档都用），展开时按需带上成分明细。 */
export const rotationQuery = (params) =>
  themeLibraryQuery({ window: 'w15', theme: params.theme, at: params.at });

export const fetchRotation = async (params) => {
  const result = await callApi(`/api/market/room/themes${rotationQuery(params)}`, {
    timeoutMs: 15_000,
  });
  return result.ok ? (result.data?.rotation ?? null) : null;
};

/** 轮动图的深链接：只改 metric，保留 tab / theme / at 等其它参数。 */
export const rotationHash = (params, hash = window.location.hash) => {
  const raw = String(hash ?? '').replace(/^#/, '');
  const [route, rawQuery = ''] = raw.split('?');
  const query = new URLSearchParams(rawQuery);
  query.set('metric', params.metric);
  return `${route.length === 0 ? 'market-room' : route}?${query.toString()}`;
};

const toneClass = (value) =>
  typeof value === 'number' && value > 0
    ? 'pos'
    : typeof value === 'number' && value < 0
      ? 'neg'
      : 'zero';

const pctText = (value) => formatPct(value, true, '缺失');

/** 状态量：一次只渲染一张轮动图，拖动回调与当前口径共用同一份。 */
const uiState = {
  metric: 'w15',
  narrow: false,
  expanded: null,
  replaying: false,
  batches: [],
  anchor: null,
  onSeek: null,
};

const setScrubbing = (node, scrubbing) => {
  node?.classList.toggle('room-rotation-scrubbing', scrubbing);
};

/** 只用 key 对齐的增量渲染：节点留在原位，高度与数值才有过渡可谈。 */
const reconcileKeyed = (container, items, keyOf, createNode, updateNode) => {
  const existing = new Map();
  for (const child of [...container.children]) existing.set(child.dataset.key, child);
  const next = [];
  for (const item of items) {
    const key = keyOf(item);
    let node = existing.get(key);
    if (node === undefined) {
      node = createNode(item);
      node.dataset.key = key;
    } else {
      existing.delete(key);
    }
    updateNode(node, item);
    next.push(node);
  }
  for (const node of existing.values()) node.remove();
  let reference = container.firstElementChild;
  for (const node of next) {
    if (node === reference) {
      reference = reference.nextElementSibling;
      continue;
    }
    container.insertBefore(node, reference);
  }
};

const sealedBadge = (leader) => {
  if (leader?.sealed !== true) return null;
  const level = leader.ladderLevel;
  return el(
    'span',
    'room-rotation-sealed',
    typeof level === 'number' && level > 1 ? `${level}板` : '封',
  );
};

const stockRow = () => {
  const row = el('li', 'room-rotation-stock-row');
  const button = el('button', 'room-rotation-stock');
  button.type = 'button';
  button.append(el('span', 'room-rotation-stock-name'), el('span', 'room-rotation-stock-pct mono'));
  button.addEventListener('click', () => {
    void openThemeStock(row.dataset.stockId, row.dataset.themeId, row.__leader ?? null);
  });
  row.append(button);
  return row;
};

const updateStockRow = (row, entry) => {
  const leader = entry.leader;
  row.dataset.stockId = leader.stockId;
  row.dataset.themeId = entry.theme.themeId;
  row.__leader = leader;
  const button = row.firstElementChild;
  const name = button.querySelector('.room-rotation-stock-name');
  name.textContent = leader.name ?? leader.stockId.split('.')[0];
  const badge = button.querySelector('.room-rotation-sealed');
  const nextBadge = sealedBadge(leader);
  if (badge === null && nextBadge !== null) name.after(nextBadge);
  else if (badge !== null) {
    if (nextBadge === null) badge.remove();
    else badge.replaceWith(nextBadge);
  }
  const pct = button.querySelector('.room-rotation-stock-pct');
  pct.textContent = pctText(leader.value);
  pct.className = `room-rotation-stock-pct mono ${toneClass(leader.value)}`.trim();
  button.title = `${leader.name ?? leader.stockId} ${pctText(leader.value)}`;
};

const createCard = () => {
  const node = el('li', 'room-rotation-card');
  const nameButton = el('button', 'room-rotation-card-name');
  nameButton.type = 'button';
  nameButton.append(el('span', 'room-rotation-name'));
  nameButton.addEventListener('click', () => {
    const themeId = node.dataset.themeId;
    if (themeId === undefined) return;
    window.location.hash = themeLibraryHash(uiState.expanded === themeId ? null : themeId);
  });
  node.append(
    el('div', 'room-rotation-card-head', [nameButton, el('div', 'room-rotation-card-value mono')]),
    el('ol', 'room-rotation-stocks'),
  );
  return node;
};

const updateCard = (node, entry) => {
  node.dataset.themeId = entry.theme.themeId;
  node.className = `room-rotation-card room-rotation-card-${entry.direction}`;
  node.__value = entry.value;
  node.title = `${entry.theme.name} ${pctText(entry.value)} · ${entry.theme.memberCount} 只成分`;
  const nameButton = node.querySelector('.room-rotation-card-name');
  nameButton.querySelector('.room-rotation-name').textContent = entry.theme.name;
  nameButton.setAttribute('aria-expanded', String(uiState.expanded === entry.theme.themeId));
  const valueNode = node.querySelector('.room-rotation-card-value');
  valueNode.textContent = pctText(entry.value);
  valueNode.className = `room-rotation-card-value mono ${toneClass(entry.value)}`.trim();
  node.style.height = `${rotationCardHeight(uiState.metric, entry.value, uiState.narrow)}px`;
  const leaders = rotationLeadersOf(entry.theme, uiState.metric).slice(0, MAX_LEADERS);
  reconcileKeyed(
    node.querySelector('.room-rotation-stocks'),
    leaders.map((leader) => ({ leader, theme: entry.theme })),
    (item) => item.leader.stockId,
    stockRow,
    updateStockRow,
  );
};

/**
 * 个股弹层继承当前回放时点：按需取该题材的完整成分明细，再用既有弹层渲染
 * （弹层自己读 1 分钟序列）。取数失败时明确提示，不用缺数冒充 0。
 */
const openThemeStock = async (stockId, themeId, leader) => {
  if (typeof stockId !== 'string' || typeof themeId !== 'string') return;
  const detail = await fetchRotation({
    metric: uiState.metric,
    theme: themeId,
    at: uiState.replaying && uiState.anchor !== null ? new Date(uiState.anchor) : null,
  });
  const theme = detail?.themes?.find((entry) => entry.themeId === themeId);
  const member = theme?.members?.find((entry) => entry.stockId === stockId);
  if (theme !== undefined && member !== undefined) {
    await openStockModal(member, theme, detail.anchor ?? null);
    return;
  }
  const body = el('div', 'room-stock-modal', [
    el('p', 'room-caption', `${leader?.name ?? stockId} · ${pctText(leader?.value ?? null)}`),
    el('p', 'room-caption', '读取该题材成分明细失败，未能打开完整个股事实。'),
  ]);
  openModal(leader?.name ?? stockId, body);
};

const batchText = (batch) =>
  batch === null || batch === undefined ? '--' : formatClock(batch.sampledAt);

const batchValueText = (batch, replaying) =>
  `${batchText(batch)} 批次${replaying ? '，回放中' : ''}`;

const boardNode = (direction, label) => {
  const list = el('ol', `room-rotation-board room-rotation-board-${direction}`);
  list.dataset.direction = direction;
  list.setAttribute('aria-label', label);
  return list;
};

const paintBoard = (list, entries, direction) => {
  const keyed = entries.map((entry) => ({ ...entry, direction }));
  reconcileKeyed(list, keyed, (entry) => entry.theme.themeId, createCard, updateCard);
};

const paintFigure = (figure, boards) => {
  const up = figure.querySelector('.room-rotation-board-up');
  const down = figure.querySelector('.room-rotation-board-down');
  const label = METRIC_LABELS[uiState.metric];
  if (up !== null) {
    up.setAttribute('aria-label', `涨幅榜（${label}）`);
    paintBoard(up, boards.up, 'up');
  }
  if (down !== null) {
    down.setAttribute('aria-label', `跌幅榜（${label}）`);
    paintBoard(down, boards.down, 'down');
  }
};

const metricSwitch = (params) => {
  const buttons = METRICS.map((metric) => {
    const button = el('button', 'btn btn-outline btn-sm', METRIC_LABELS[metric]);
    button.type = 'button';
    button.dataset.metric = metric;
    button.classList.toggle('active', params.metric === metric);
    button.setAttribute('aria-pressed', String(params.metric === metric));
    button.addEventListener('click', () => {
      if (uiState.metric === metric) return;
      window.location.hash = rotationHash({ ...params, metric });
    });
    return button;
  });
  const group = el('div', 'room-kind-switch room-rotation-kind', buttons);
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', '题材轮动口径');
  return group;
};

const countsBlock = (boards) => {
  const details = el('details', 'room-detail-notes room-rotation-counts');
  details.append(el('summary', '', `持平 ${boards.flat.length} · 缺数 ${boards.missing.length}`));
  const items = [
    ...boards.flat.map((entry) =>
      el('li', '', `持平 · ${entry.theme.name} ${pctText(entry.value)}`),
    ),
    ...boards.missing.map(({ theme, metric }) =>
      el('li', '', `缺数 · ${theme.name}（${metric?.warnings?.[0] ?? '该口径没有可用样本'}）`),
    ),
  ];
  details.append(
    el(
      'ul',
      'room-warnings',
      items.length === 0 ? [el('li', '', '当前口径没有持平或缺失的题材')] : items,
    ),
  );
  return details;
};

const notesBlock = (rotation) => {
  const lines = [...(rotation?.notes ?? [])].filter(
    (line) => typeof line === 'string' && line.length > 0,
  );
  if (lines.length === 0) return null;
  return el('details', 'room-detail-notes room-rotation-notes', [
    el('summary', '', `口径与缺失说明（${lines.length} 条）`),
    el(
      'ul',
      'room-warnings',
      lines.map((line) => el('li', '', line)),
    ),
  ]);
};

const axisBlock = (rotation) => {
  const batches = rotation.batches ?? [];
  const axis = el('div', 'room-rotation-axis');
  if (batches.length === 0) return axis;
  const index = rotationBatchIndex(batches, rotation.anchor);
  const range = el('input', 'room-rotation-range');
  range.type = 'range';
  range.min = '0';
  range.max = String(Math.max(0, batches.length - 1));
  range.step = '1';
  range.value = String(index);
  range.setAttribute('aria-label', '行情批次时间轴');
  const valueText = () =>
    batchValueText(batches[rotationBatchIndex(batches, rotation.anchor)], uiState.replaying);
  range.setAttribute('aria-valuetext', valueText());
  const left = el('span', 'room-rotation-axis-bound', batchText(batches[0]));
  left.setAttribute('aria-hidden', 'true');
  const right = el('span', 'room-rotation-axis-bound', batchText(batches.at(-1)));
  right.setAttribute('aria-hidden', 'true');
  const now = el(
    'span',
    'room-rotation-axis-now mono',
    batchValueText(batches[index], uiState.replaying),
  );
  axis.append(left, range, right, now);
  range.addEventListener('input', () => {
    const batch = uiState.batches[Number(range.value)];
    if (batch === undefined) return;
    setScrubbing(range.closest('.room-rotation'), true);
    now.textContent = batchValueText(batch, true);
    range.setAttribute('aria-valuetext', batchValueText(batch, true));
    uiState.onSeek?.(new Date(batch.sampledAt));
  });
  // 只有真实指针操作期间才不回写滑块位置；键盘与焦点不应阻止数据对齐。
  range.addEventListener('pointerdown', () => {
    range.__pointerScrubbing = true;
  });
  for (const type of ['change', 'pointerup', 'pointercancel', 'keyup', 'blur']) {
    range.addEventListener(type, () => {
      range.__pointerScrubbing = false;
      setScrubbing(range.closest('.room-rotation'), false);
    });
  }
  return axis;
};

/** 时间轴就地更新：滑块节点与焦点保留，值只在用户没在拖时回写。 */
const updateAxis = (axis, rotation) => {
  const batches = rotation.batches ?? [];
  const range = axis.querySelector('.room-rotation-range');
  const index = rotationBatchIndex(batches, rotation.anchor);
  const bounds = axis.querySelectorAll('.room-rotation-axis-bound');
  if (bounds.length === 2) {
    bounds[0].textContent = batchText(batches[0]);
    bounds[1].textContent = batchText(batches.at(-1));
  }
  if (range === null) return;
  range.max = String(Math.max(0, batches.length - 1));
  if (range.__pointerScrubbing !== true) range.value = String(index);
  const selected = batches[Number(range.value)] ?? batches[index];
  range.setAttribute('aria-valuetext', batchValueText(selected, uiState.replaying));
  const now = axis.querySelector('.room-rotation-axis-now');
  if (now !== null) now.textContent = batchValueText(selected, uiState.replaying);
};

const detailBlock = (rotation) => {
  const expanded = uiState.expanded;
  if (expanded === null) return null;
  const theme = rotation.themes.find((entry) => entry.themeId === expanded);
  if (theme === undefined) return null;
  if (theme.members.length === 0) {
    return el('p', 'room-caption room-rotation-detail', '该题材在当前时点没有可用成分明细');
  }
  return el('div', 'room-rotation-detail', memberTable(theme, rotation.anchor ?? null));
};

const rotationMetaText = (rotation) => {
  if (rotation === null || rotation === undefined) return '读取系统题材行情失败，稍后会自动重试';
  const anchor = rotation.anchor ?? null;
  if (anchor === null) return themeLibraryEmptyText(rotation) ?? '暂无题材行情';
  return `${rotation.tradingDate ?? '--'} · ${batchText(anchor)} 批次`;
};

const emptySection = (rotation) => {
  const section = el('section', 'card room-empty room-rotation-empty');
  section.dataset.state = rotation?.state ?? 'missing';
  section.append(
    el('h2', '', '题材尚未就绪'),
    el('p', '', themeLibraryEmptyText(rotation) ?? '暂无题材行情'),
  );
  return section;
};

const syncUiState = (rotation, params) => {
  uiState.metric = params.metric;
  uiState.expanded = params.theme;
  uiState.narrow = isNarrowViewport();
  uiState.replaying = params.at !== null;
  uiState.batches = rotation?.batches ?? [];
  uiState.anchor = rotation?.anchor?.sampledAt ?? null;
};

/** 图区可滚动提示：只有真正溢出、且不在那一端时才亮边缘遮罩。 */
const syncScrollEdges = (figure) => {
  const scroll = figure?.querySelector('.room-rotation-scroll');
  if (scroll === null || scroll === undefined) return;
  const rest = scroll.scrollWidth - scroll.clientWidth - scroll.scrollLeft;
  figure.classList.toggle('can-scroll-left', scroll.scrollLeft > 4);
  figure.classList.toggle('can-scroll-right', rest > 4);
};

const figureBlock = () => {
  const scroll = el('div', 'room-rotation-scroll');
  scroll.append(
    el('div', 'room-rotation-canvas', [
      boardNode('up', `涨幅榜（${METRIC_LABELS[uiState.metric]}）`),
      el('div', 'room-rotation-zero'),
      boardNode('down', `跌幅榜（${METRIC_LABELS[uiState.metric]}）`),
    ]),
  );
  scroll.addEventListener('scroll', () => syncScrollEdges(scroll.parentElement), {
    passive: true,
  });
  return el('div', 'room-rotation-figure', scroll);
};

const emptyBodyBlock = (rotation) => {
  const note = el(
    'p',
    'room-caption room-rotation-empty-note',
    themeLibraryEmptyText(rotation) ?? '该时点没有可展示的题材行情',
  );
  if ((rotation.batches ?? []).length > 0) {
    note.append(
      el(
        'span',
        'room-rotation-empty-hint',
        '时间轴仍可用：可继续拖动到其它批次，或用页面顶部的「回到最新」。',
      ),
    );
  }
  return note;
};

/** 图区容器的两种形态：可轮动的双排图，或该时点没有题材行情时的说明。 */
const bodyBlock = (rotation) =>
  rotation.state === 'ready' ? figureBlock() : emptyBodyBlock(rotation);

const headerBlock = (rotation, params) => {
  const boards = rotationBoards(rotation, uiState.metric);
  const controls = el('div', 'room-rotation-header', [metricSwitch(params)]);
  if (rotation.state === 'ready') controls.append(countsBlock(boards));
  return el('div', 'card-header', [
    el('div', null, [el('h2', '', '题材轮动'), el('div', 'card-meta', rotationMetaText(rotation))]),
    controls,
  ]);
};

/**
 * 总览题材区渲染：一张整宽卡片（header + 时间轴 + 图区 + 展开明细 + 口径说明）。
 * 该时点没有生效成分时仍保留时间轴与口径切换，用户可以继续拖动或返回最新。
 * `deps.onSeek(at)` 由作战室上层注入：改 hash 的 at 并合并重取。
 */
export const renderOverviewThemePane = (rotation, params = rotationParamsFromHash(), deps = {}) => {
  syncUiState(rotation, params);
  uiState.onSeek = deps.onSeek ?? null;
  if (rotation === null || rotation === undefined) return emptySection(rotation);
  if (rotation.state !== 'ready' && (rotation.batches ?? []).length === 0) {
    return emptySection(rotation);
  }
  const section = el('section', 'card room-rotation');
  section.id = 'room-library';
  section.dataset.state = rotation.state;
  section.append(headerBlock(rotation, params), axisBlock(rotation));
  const body = el('div', 'room-rotation-body', bodyBlock(rotation));
  body.dataset.state = rotation.state;
  section.append(body);
  if (rotation.state === 'ready') {
    paintFigure(
      body.querySelector('.room-rotation-figure'),
      rotationBoards(rotation, uiState.metric),
    );
    const detail = detailBlock(rotation);
    if (detail !== null) section.append(detail);
  }
  const notes = notesBlock(rotation);
  if (notes !== null) section.append(notes);
  bindResize();
  return section;
};

/** 就地更新：保留时间轴滑块节点（焦点 / 拖动连续），只换图内容与计数。 */
export const updateOverviewThemePane = (root, rotation, params = rotationParamsFromHash()) => {
  if (root === null || root === undefined || root.dataset.state === 'missing') return false;
  if (rotation === null || rotation === undefined) return false;
  if (rotation.state !== 'ready' && (rotation.batches ?? []).length === 0) return false;
  syncUiState(rotation, params);
  root.dataset.state = rotation.state;
  const boards = rotationBoards(rotation, uiState.metric);
  const header = root.querySelector('.card-header');
  const meta = header?.querySelector('.card-meta');
  if (meta !== null && meta !== undefined) meta.textContent = rotationMetaText(rotation);
  const controls = header?.querySelector('.room-rotation-header');
  if (controls !== null && controls !== undefined) {
    for (const button of controls.querySelectorAll('.room-rotation-kind button')) {
      const active = button.dataset.metric === uiState.metric;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    const counts = controls.querySelector('.room-rotation-counts');
    if (rotation.state !== 'ready') counts?.remove();
    else if (counts === null) controls.append(countsBlock(boards));
    else counts.replaceWith(countsBlock(boards));
  }
  const axis = root.querySelector('.room-rotation-axis');
  if (axis !== null) updateAxis(axis, rotation);
  const body = root.querySelector('.room-rotation-body');
  if (body !== null && body.dataset.state !== rotation.state) {
    body.dataset.state = rotation.state;
    body.replaceChildren(bodyBlock(rotation));
    if (rotation.state === 'ready') paintFigure(body.firstElementChild, boards);
  } else if (rotation.state === 'ready') {
    const figure = body?.querySelector('.room-rotation-figure');
    if (figure !== null && figure !== undefined) {
      paintFigure(figure, boards);
      syncScrollEdges(figure);
    }
  }
  const detail = root.querySelector('.room-rotation-detail');
  const nextDetail = rotation.state === 'ready' ? detailBlock(rotation) : null;
  if (nextDetail === null) detail?.remove();
  else if (detail === null) body?.after(nextDetail);
  else detail.replaceWith(nextDetail);
  return true;
};

let resizeBound = false;
const bindResize = () => {
  if (resizeBound || typeof window === 'undefined') return;
  resizeBound = true;
  window.addEventListener('resize', () => {
    const narrow = isNarrowViewport();
    if (narrow === uiState.narrow) return;
    uiState.narrow = narrow;
    for (const card of document.querySelectorAll('.room-rotation-card')) {
      const value = card.__value;
      if (typeof value !== 'number') continue;
      card.style.height = `${rotationCardHeight(uiState.metric, value, narrow)}px`;
    }
    syncOverviewRotationEdges();
  });
};

/** 挂载后补一次边缘遮罩状态（挂载前量不到 scrollWidth）。 */
export const syncOverviewRotationEdges = (scope = document) => {
  for (const figure of scope.querySelectorAll('.room-rotation-figure')) syncScrollEdges(figure);
};

/** 离开作战室：清掉滑块回调与在途状态，避免回调写到已卸载的节点。 */
export const resetRotationUiState = () => {
  uiState.onSeek = null;
  uiState.batches = [];
  uiState.anchor = null;
};

export { METRIC_LABELS, METRICS };
