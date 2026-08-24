// apps/web/public/js/sectors.js —— 行业板块热力图页面渲染器。
//
// 设计要点：
// - 与涨停梯队（limit-up-ladder.js）同级，纯只读实时快照展示
// - 热力图渲染抽在 sector-heatmap.js（看盘页迷你热力共用），按 |涨跌幅| 降序平铺，
//   红涨绿跌、颜色深浅随涨跌幅绝对值加深（配色复用全局 --pos / --neg 口径）
// - 热力图固定取涨跌幅两侧极值；下方板块列表支持本地排序与方向筛选
// - 数据全由 fetch_sector_quotes tool 提供，UI 不臆造字段

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import { renderSectorHeatmap, selectSectorExtremes } from './sector-heatmap.js';
import { $, el, mount } from './ui.js';

const formatPct = (n) => `${n > 0 ? '+' : ''}${(n * 100).toFixed(2)}%`;
const DIRECTION_LABELS = { all: '全部', up: '上涨', down: '下跌', flat: '平盘' };

/** 成交额（元）→ 亿，保留 1 位小数。 */
const formatAmount = (n) => `${(n / 100_000_000).toFixed(1)}亿`;

const pctCell = (value) => {
  const cls = value > 0 ? 'num pos' : value < 0 ? 'num neg' : 'num';
  return el('td', cls, formatPct(value));
};

const renderRow = (item) =>
  el('tr', '', [
    el('td', 'code', item.code),
    el('td', '', item.name),
    el('td', 'num', item.price.toFixed(2)),
    pctCell(item.changePct),
    el('td', 'num', formatAmount(item.amount)),
    el('td', 'num pos', item.upCount !== undefined ? String(item.upCount) : '--'),
    el('td', 'num neg', item.downCount !== undefined ? String(item.downCount) : '--'),
    el('td', '', item.leadingStockName ?? '--'),
    item.leadingStockChangePct !== undefined
      ? pctCell(item.leadingStockChangePct)
      : el('td', 'num', '--'),
  ]);

const renderTable = (items) => {
  const header = el('thead', '', [
    el('tr', '', [
      el('th', '', '代码'),
      el('th', '', '名称'),
      el('th', 'num', '最新'),
      el('th', 'num', '涨跌幅'),
      el('th', 'num', '成交额'),
      el('th', 'num', '上涨'),
      el('th', 'num', '下跌'),
      el('th', '', '领涨股'),
      el('th', 'num', '领涨涨幅'),
    ]),
  ]);
  return el('div', 'table-wrap', [
    el('table', 'table', [header, el('tbody', '', items.map(renderRow))]),
  ]);
};

const dateInShanghai = () => {
  const d = new Date();
  const shanghaiMs = d.getTime() + 8 * 60 * 60 * 1000;
  const shanghai = new Date(shanghaiMs);
  return `${shanghai.getUTCFullYear()}-${String(shanghai.getUTCMonth() + 1).padStart(2, '0')}-${String(
    shanghai.getUTCDate(),
  ).padStart(2, '0')}`;
};

const dateFromUrl = () => {
  const date = new URLSearchParams(window.location.search).get('date');
  return /^\d{4}-\d{2}-\d{2}$/.test(date ?? '') ? date : dateInShanghai();
};

const dateToUrl = (date) => {
  const url = new URL(window.location.href);
  url.searchParams.set('date', date);
  window.history.replaceState({}, '', url.toString());
};

const sortFromUrl = () => {
  const params = new URLSearchParams(window.location.search);
  const sort = params.get('sort');
  return sort === 'amount' ? 'amount' : 'changePct';
};

const directionFromUrl = () => {
  const direction = new URLSearchParams(window.location.search).get('direction');
  return direction === 'up' || direction === 'down' || direction === 'flat' ? direction : 'all';
};

const sortToUrl = (sort) => {
  const url = new URL(window.location.href);
  url.searchParams.set('sort', sort);
  window.history.replaceState({}, '', url.toString());
};

const directionToUrl = (direction) => {
  const url = new URL(window.location.href);
  url.searchParams.set('direction', direction);
  window.history.replaceState({}, '', url.toString());
};

const sortItems = (items, sort) =>
  [...items].sort((a, b) => {
    const diff = sort === 'amount' ? b.amount - a.amount : b.changePct - a.changePct;
    return diff !== 0 ? diff : a.name.localeCompare(b.name, 'zh-CN');
  });

const filterItems = (items, direction) =>
  direction === 'up'
    ? items.filter((item) => item.changePct > 0)
    : direction === 'down'
      ? items.filter((item) => item.changePct < 0)
      : direction === 'flat'
        ? items.filter((item) => item.changePct === 0)
        : items;

const renderDateControls = (date, setStatus) => {
  const input = el('input', 'date-input', date);
  input.type = 'date';
  input.value = date;
  input.max = dateInShanghai();
  input.addEventListener('change', () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.value)) {
      setStatus('日期格式必须为 YYYY-MM-DD', true);
      return;
    }
    dateToUrl(input.value);
    void renderSectors(setStatus);
  });
  const btn = el('button', 'btn', '刷新');
  btn.addEventListener('click', () => void renderSectors(setStatus));
  return el('div', 'ladder-controls sector-date-controls', [el('label', '', '日期'), input, btn]);
};

const renderListControls = (sort, direction, repaint) => {
  const select = el('select', 'date-input', [
    el('option', '', '按涨跌幅'),
    el('option', '', '按成交额'),
  ]);
  select.children[0].value = 'changePct';
  select.children[1].value = 'amount';
  select.value = sort;
  select.addEventListener('change', () => {
    sortToUrl(select.value);
    repaint();
  });
  const directionSelect = el('select', 'date-input', [
    el('option', '', DIRECTION_LABELS.all),
    el('option', '', DIRECTION_LABELS.up),
    el('option', '', DIRECTION_LABELS.down),
    el('option', '', DIRECTION_LABELS.flat),
  ]);
  directionSelect.children[0].value = 'all';
  directionSelect.children[1].value = 'up';
  directionSelect.children[2].value = 'down';
  directionSelect.children[3].value = 'flat';
  directionSelect.value = direction;
  directionSelect.addEventListener('change', () => {
    directionToUrl(directionSelect.value);
    repaint();
  });
  return el('div', 'ladder-controls', [
    el('label', '', '排序列表'),
    select,
    el('label', '', '方向'),
    directionSelect,
  ]);
};

const renderListSection = (items) => {
  const section = el('section', 'sector-list');
  const repaint = () => {
    const currentSort = sortFromUrl();
    const currentDirection = directionFromUrl();
    const visibleItems = sortItems(filterItems(items, currentDirection), currentSort);
    mount(section, [
      el('div', 'sector-list-heading', [
        el('h3', '', `板块列表 · ${visibleItems.length}`),
        renderListControls(currentSort, currentDirection, repaint),
      ]),
      visibleItems.length === 0
        ? el('div', 'ladder-empty', '（当前方向无板块数据）')
        : renderTable(visibleItems),
    ]);
  };
  repaint();
  return section;
};

export const renderSectors = async (setStatus) => {
  const root = $('#route-sectors');
  if (root === null) return;
  const date = dateFromUrl();
  mount(root, [el('p', 'muted', '加载中…')]);
  const dateControls = renderDateControls(date, setStatus);
  if (date !== dateInShanghai()) {
    mount(root, [
      el('h2', '', `板块热力 · ${date}`),
      dateControls,
      el('div', 'ladder-empty sector-unavailable', [
        el('strong', '', '当前数据源仅支持实时板块快照'),
        el('span', '', '历史日期暂不可用，请切换到今天查看最新板块数据。'),
      ]),
    ]);
    setStatus('当前板块数据源仅支持实时快照，历史日期暂不可用。');
    return;
  }
  // 热力图需要完整的涨跌幅两侧样本；列表排序在已加载数据上本地完成。
  const r = await callApi('/api/market/sectors?sort=changePct&all=true');
  if (!r.ok) {
    // callApi 不回传 HTTP status；server 把上游失败包成 error.kind='adapter_error'
    const kind =
      r.error?.kind === 'adapter_error' ? 'upstream-unavailable' : (r.error?.kind ?? 'internal');
    const detail =
      kind === 'upstream-unavailable' ? '请检查 luoome web 到东方财富行情服务的网络连通性。' : '';
    mount(root, [
      el('h2', '', `板块热力 · ${date}`),
      dateControls,
      el('p', 'error', `加载失败：${kind}（${detail}）`.trim()),
    ]);
    setStatus(`加载板块行情失败：${kind}`, true);
    return;
  }
  const list = r.data;
  const items = list.items ?? [];
  const counts = {
    up: items.filter((item) => item.changePct > 0).length,
    down: items.filter((item) => item.changePct < 0).length,
    flat: items.filter((item) => item.changePct === 0).length,
  };
  const header = el('div', 'sector-heading', [
    el('h2', '', `板块热力 · ${date}`),
    el('div', 'sector-summary', [
      el('span', '', `已加载 ${items.length}`),
      el('span', 'pos', `涨 ${counts.up}`),
      el('span', 'neg', `跌 ${counts.down}`),
      el('span', 'flat', `平 ${counts.flat}`),
    ]),
  ]);
  const heatmapItems = selectSectorExtremes(items, 15);
  const heatmap =
    heatmapItems.length === 0
      ? el('div', 'ladder-empty', '（无板块数据）')
      : renderSectorHeatmap(heatmapItems);
  mount(root, [header, dateControls, heatmap, renderListSection(items)]);
  setStatus(`板块热力加载完成（涨 ${counts.up} / 跌 ${counts.down} / 平 ${counts.flat}）`);
};
