// apps/web/public/js/dragon-tiger.js —— 龙虎榜页面渲染器（#dragon-tiger 路由）。
//
// 设计要点（参考 finance-workbench DragonTiger.tsx）：
// - 与涨停梯队（limit-up-ladder.js）/ 板块热力（sectors.js）同级，纯只读快照展示
// - 日期通过 URL query 传给 manager；日期选择器支持历史日，显式非交易日 → 空榜单 + warnings=['non-trading-day']
// - 涨跌幅 / 换手率是小数（0.10 = 10%，core schema 口径）；金额单位为元，展示用万 / 亿
// - 行点击出详情弹窗（复用 modal.js openModal）
// - 60s 定时刷新（页面隐藏时跳过）；离开路由由 app.js 调 teardownDragonTiger 清理
// - 数据全由 dragon_tiger_list tool 提供，UI 不臆造字段

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import { formatAmount } from './market-shared.js';
import { openModal } from './modal.js';
import { $, el, mount } from './ui.js';

const REFRESH_MS = 60_000;

let refreshTimer = null;
let statusFn = null;
let currentFilter = 'all';
let latestList = null;

/* ---- 纯函数（dragon-tiger.test.js 直接单测） ---- */

/** 涨跌幅小数 → 带符号百分比（0.0321 → '+3.21%'）。 */
const formatPct = (n) => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '--';
  return `${n > 0 ? '+' : ''}${(n * 100).toFixed(2)}%`;
};

/** 带符号金额（元 → 万 / 亿）；非数字 → '--'。 */
const formatSignedAmount = (n) => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '--';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}${formatAmount(Math.abs(n))}`;
};

/** 全部 / 上涨 / 下跌 筛选（按 changePct 符号；0 既不算涨也不算跌）。 */
const filterEntries = (entries, filter) => {
  const list = Array.isArray(entries) ? entries : [];
  if (filter === 'up') return list.filter((e) => e.changePct > 0);
  if (filter === 'down') return list.filter((e) => e.changePct < 0);
  return list;
};

/**
 * 按股票合并上榜明细。
 * 东方财富按「股票 × 上榜原因」返回数据；同一股票的股票级金额可能在多个原因行重复，
 * 因此聚合行只保留首条股票快照，避免净买入 / 成交额被重复计算，原始明细全部留存。
 */
const groupEntriesByStock = (entries) => {
  const groups = new Map();
  const list = Array.isArray(entries) ? entries : [];
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue;
    const key = String(entry.code ?? '').trim();
    if (key.length === 0) continue;
    const current = groups.get(key);
    if (current === undefined) {
      groups.set(key, {
        ...entry,
        details: [entry],
        reasonCount: 1,
      });
      continue;
    }
    current.details.push(entry);
    current.reasonCount += 1;
  }
  return [...groups.values()];
};

/** 汇总：上涨 / 下跌家数与净买入合计（元）。 */
const summarizeEntries = (entries) => {
  const list = Array.isArray(entries) ? entries : [];
  return {
    up: list.filter((e) => e.changePct > 0).length,
    down: list.filter((e) => e.changePct < 0).length,
    netSum: list.reduce((sum, e) => sum + (typeof e.netAmount === 'number' ? e.netAmount : 0), 0),
  };
};

/** warnings → 可读文案；无警告返回 ''。 */
const warningText = (warnings) => {
  const list = Array.isArray(warnings) ? warnings : [];
  if (list.includes('non-trading-day')) return '该日为非 A 股交易日，无龙虎榜数据';
  if (list.includes('empty-list')) return '当日无上榜数据或数据暂未更新';
  if (list.length > 0) return `状态：${list.join('；')}`;
  return '';
};

/* ---- 页面渲染 ---- */

const fmtAsOf = (value) => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '--';
  return d.toLocaleTimeString('zh-CN', { hour12: false });
};

const stat = (label, value, cls = '') =>
  el('div', 'stat', [el('div', 'label', label), el('div', `value ${cls}`.trim(), String(value))]);

const signedCls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

const formatPrice = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(2) : '--');

const renderSeatList = (label, seats) => {
  const list = Array.isArray(seats) ? seats : [];
  const content =
    list.length === 0
      ? el('p', 'muted dragon-seat-empty', '暂无席位数据')
      : el('div', 'table-wrap dragon-seat-table-wrap', [
          el('table', 'table dragon-seat-table', [
            el('thead', '', [el('tr', '', [el('th', '', '席位'), el('th', 'num', '金额')])]),
            el(
              'tbody',
              '',
              list.map((seat) =>
                el('tr', '', [el('td', '', seat.name), el('td', 'num', formatAmount(seat.amount))]),
              ),
            ),
          ]),
        ]);
  return el('section', 'dragon-seat-section', [el('div', 'label', label), content]);
};

const renderSummary = (entries, detailCount) => {
  const s = summarizeEntries(entries);
  return el('div', 'stat-grid dragon-summary', [
    stat('股票数', entries.length),
    stat('上榜明细', detailCount),
    stat('上涨', s.up, 'pos'),
    stat('下跌', s.down, 'neg'),
    stat('净买入合计', formatSignedAmount(s.netSum), signedCls(s.netSum)),
  ]);
};

const renderFilterTabs = () => {
  const tabs = [
    ['all', '全部'],
    ['up', '上涨'],
    ['down', '下跌'],
  ];
  return el(
    'div',
    'dragon-filters',
    tabs.map(([key, label]) => {
      const btn = el(
        'button',
        `btn btn-outline btn-sm${currentFilter === key ? ' active' : ''}`,
        label,
      );
      btn.type = 'button';
      btn.addEventListener('click', () => {
        if (currentFilter === key) return;
        currentFilter = key;
        renderBody();
      });
      return btn;
    }),
  );
};

const openDetail = (entry) => {
  const body = el('div', '', [
    el('div', 'stat-grid dragon-detail-grid', [
      stat('收盘价', formatPrice(entry.close)),
      stat('涨跌幅', formatPct(entry.changePct), signedCls(entry.changePct)),
      stat('换手率', formatPct(entry.turnoverRate)),
      stat('成交额', formatAmount(entry.amount)),
      stat('龙虎榜净额', formatSignedAmount(entry.netAmount), signedCls(entry.netAmount)),
      stat('买入额', formatAmount(entry.buyAmount), 'pos'),
      stat('卖出额', formatAmount(entry.sellAmount), 'neg'),
      stat('上榜日期', entry.tradeDate),
    ]),
    el('div', 'dragon-reason', [
      el('div', 'label', `上榜明细 · ${entry.reasonCount} 条`),
      ...entry.details.map((detail, index) =>
        el('article', 'dragon-detail-item', [
          el('div', 'dragon-detail-item-head', [
            el('strong', '', detail.reason),
            el('span', 'muted', `明细 ${index + 1}`),
          ]),
          el('div', 'dragon-detail-item-grid', [
            stat('龙虎榜净额', formatSignedAmount(detail.netAmount), signedCls(detail.netAmount)),
            stat('买入额', formatAmount(detail.buyAmount), 'pos'),
            stat('卖出额', formatAmount(detail.sellAmount), 'neg'),
          ]),
          el('div', 'dragon-seat-grid', [
            renderSeatList('买入席位', detail.buySeats),
            renderSeatList('卖出席位', detail.sellSeats),
          ]),
        ]),
      ),
    ]),
  ]);
  openModal(`${entry.name}（${entry.code}）`, body);
};

const renderRow = (entry) => {
  const tr = el('tr', '', [
    el('td', 'code', entry.code),
    el('td', '', entry.name),
    el('td', 'num', formatPrice(entry.close)),
    el('td', `num ${signedCls(entry.changePct)}`.trim(), formatPct(entry.changePct)),
    el('td', 'num', formatPct(entry.turnoverRate)),
    el('td', 'num', `${entry.reasonCount} 次`),
    el('td', `num ${signedCls(entry.netAmount)}`.trim(), formatSignedAmount(entry.netAmount)),
    el('td', 'num', formatAmount(entry.buyAmount)),
    el('td', 'num', formatAmount(entry.sellAmount)),
    el('td', 'num', formatAmount(entry.amount)),
  ]);
  tr.tabIndex = 0;
  tr.title = '点击查看上榜明细';
  const showDetail = () => openDetail(entry);
  tr.addEventListener('click', showDetail);
  tr.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      showDetail();
    }
  });
  return tr;
};

const renderTable = (entries) => {
  const header = el('thead', '', [
    el('tr', '', [
      el('th', '', '代码'),
      el('th', '', '名称'),
      el('th', 'num', '收盘价'),
      el('th', 'num', '涨跌幅'),
      el('th', 'num', '换手率'),
      el('th', 'num', '上榜次数'),
      el('th', 'num', '龙虎榜净额'),
      el('th', 'num', '买入额'),
      el('th', 'num', '卖出额'),
      el('th', 'num', '成交额'),
    ]),
  ]);
  return el('div', 'table-wrap', [
    el('table', 'table', [header, el('tbody', '', entries.map(renderRow))]),
  ]);
};

/** 用最新数据重渲汇总与表格（筛选切换 / 定时刷新共用；无数据时占位）。 */
const renderBody = () => {
  const root = $('#route-dragon-tiger');
  if (root === null || latestList === null) return;
  const summaryNode = $('.dragon-summary', root);
  const bodyNode = $('.dragon-body', root);
  const rawEntries = latestList.entries ?? [];
  const entries = groupEntriesByStock(rawEntries);
  // stat-grid 整体替换：直接新建节点换掉旧 summary
  if (summaryNode !== null) {
    summaryNode.replaceWith(renderSummary(entries, rawEntries.length));
  }
  const filtered = filterEntries(entries, currentFilter);
  const content =
    entries.length === 0
      ? el('div', 'ladder-empty', warningText(latestList.warnings) || '（无可展示 entries）')
      : filtered.length === 0
        ? el('div', 'ladder-empty', '（当前筛选下无条目）')
        : renderTable(filtered);
  if (bodyNode !== null) mount(bodyNode, content);
  // 同步筛选 tab 高亮
  root.querySelectorAll('.dragon-filters .btn').forEach((btn, i) => {
    btn.classList.toggle('active', ['all', 'up', 'down'][i] === currentFilter);
  });
};

const refresh = async () => {
  if (statusFn === null) return;
  await renderDragonTiger(statusFn);
};

const dateInShanghai = () => {
  const d = new Date();
  const shanghai = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return `${shanghai.getUTCFullYear()}-${String(shanghai.getUTCMonth() + 1).padStart(2, '0')}-${String(shanghai.getUTCDate()).padStart(2, '0')}`;
};

const dateFromUrl = () => {
  const hashParams = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  const searchParams = new URLSearchParams(window.location.search);
  const candidate = hashParams.get('date') ?? searchParams.get('date');
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate ?? '') ? candidate : dateInShanghai();
};

const dateToUrl = (date) => {
  const url = new URL(window.location.href);
  const hashRaw = url.hash.replace(/^#/, '');
  const queryIndex = hashRaw.indexOf('?');
  if (queryIndex === -1) {
    url.searchParams.set('date', date);
  } else {
    const route = hashRaw.slice(0, queryIndex);
    const params = new URLSearchParams(hashRaw.slice(queryIndex + 1));
    params.set('date', date);
    url.hash = `${route}?${params.toString()}`;
  }
  window.history.replaceState({}, '', url.toString());
};

const renderDatePicker = (current, setStatus) => {
  const input = el('input', 'date-input', current);
  input.type = 'date';
  input.value = current;
  input.setAttribute('aria-label', '选择龙虎榜日期');
  input.addEventListener('change', () => {
    const value = input.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      setStatus('日期格式必须为 YYYY-MM-DD', true);
      return;
    }
    dateToUrl(value);
    void renderDragonTiger(setStatus);
  });
  return input;
};

const renderDragonTiger = async (setStatus) => {
  const root = $('#route-dragon-tiger');
  if (root === null) return;
  statusFn = setStatus;
  const date = dateFromUrl();
  if (latestList === null) mount(root, [el('p', 'muted', '加载中…')]);
  const r = await callApi(`/api/dragon-tiger?date=${encodeURIComponent(date)}`);
  if (!r.ok) {
    // callApi 不回传 HTTP status；server 把上游失败包成 error.kind='adapter_error'
    const kind =
      r.error?.kind === 'adapter_error' ? 'upstream-unavailable' : (r.error?.kind ?? 'internal');
    const detail =
      kind === 'upstream-unavailable' ? '请检查 luoome web 到东方财富行情服务的网络连通性。' : '';
    latestList = null;
    mount(root, [
      el('h2', '', '龙虎榜'),
      el('p', 'error', `加载失败：${kind}（${detail}）`.trim()),
    ]);
    setStatus(`加载龙虎榜失败：${kind}`, true);
    return;
  }
  latestList = r.data;
  const list = latestList;
  const warning = warningText(list.warnings);
  const refreshBtn = el('button', 'btn', '刷新');
  refreshBtn.addEventListener('click', () => void refresh());
  const rawEntries = list.entries ?? [];
  const entries = groupEntriesByStock(rawEntries);
  mount(root, [
    el('h2', '', `龙虎榜 · ${list.date}`),
    el('div', 'ladder-controls dragon-controls', [
      el('label', '', '日期'),
      renderDatePicker(list.date, setStatus),
      renderFilterTabs(),
      refreshBtn,
    ]),
    el(
      'p',
      'muted dragon-meta',
      `来源 ${list.source ?? '--'} · 数据获取于 ${fmtAsOf(list.asOf)} · ${entries.length} 只股票 / ${rawEntries.length} 条明细 · 60s 自动刷新`,
    ),
    ...(warning.length > 0 ? [el('p', 'dragon-warning', warning)] : []),
    renderSummary(entries, rawEntries.length),
    el('div', 'dragon-body', []),
  ]);
  renderBody();
  setStatus(
    `龙虎榜 ${list.date} 加载完成（${entries.length} 只股票 / ${rawEntries.length} 条明细）`,
  );
  if (refreshTimer !== null) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    void refresh();
  }, REFRESH_MS);
};

const teardownDragonTiger = () => {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  statusFn = null;
};

export {
  filterEntries,
  formatPct,
  formatSignedAmount,
  groupEntriesByStock,
  renderDragonTiger,
  summarizeEntries,
  teardownDragonTiger,
  warningText,
};
