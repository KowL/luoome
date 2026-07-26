// apps/web/public/js/limit-up-ladder.js —— 涨停梯队页面渲染器。
//
// 设计要点（docs/ddd/limit-up-ladder-detailed-design.md §7.1）：
// - 与 /market/overview 同级，纯只读快照展示
// - 日期切换走 URL query string ?date=
// - corrected=true 现价加 * 角标 + title 提示 rawClose
// - vs 昨日 diff 段在底部，复用 limit_up_ladder_compare 端点
// - 数据全由工具调用提供，UI 不臆造字段

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import { $, el, mount } from './ui.js';

const dateInShanghai = () => {
  const d = new Date();
  const shanghaiMs = d.getTime() + 8 * 60 * 60 * 1000;
  const sh = new Date(shanghaiMs);
  const y = sh.getUTCFullYear();
  const m = String(sh.getUTCMonth() + 1).padStart(2, '0');
  const day = String(sh.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const dateFromUrl = () => {
  const params = new URLSearchParams(window.location.search);
  return params.get('date') ?? dateInShanghai();
};

const dateToUrl = (date) => {
  const url = new URL(window.location.href);
  url.searchParams.set('date', date);
  window.history.replaceState({}, '', url.toString());
};

const formatPct = (n) => `${(n * 100).toFixed(2)}%`;

const formatEntry = (entry) => {
  const priceStr = entry.corrected === true
    ? `${entry.price.toFixed(2)}*`
    : entry.price.toFixed(2);
  const priceTitle = entry.corrected === true
    ? `已修正：rawClose=${entry.rawClose}，按 8.58% 回推`
    : '';
  const priceCell = el('span', entry.corrected === true ? 'corrected-mark' : '', priceStr);
  if (priceTitle.length > 0) priceCell.title = priceTitle;
  return el('tr', '', [
    el('td', 'code', entry.code),
    el('td', '', entry.name ?? '--'),
    el('td', 'num', priceCell),
    el('td', 'num pct', formatPct(entry.changePct)),
    el('td', '', entry.firstTime ?? '--'),
    el('td', '', entry.finalTime ?? '--'),
    el('td', '', entry.industry ?? '--'),
    el('td', '', entry.reason ?? '--'),
  ]);
};

const renderLevelTable = (level) => {
  const header = el('thead', '', [
    el('tr', '', [
      el('th', '', '代码'),
      el('th', '', '名称'),
      el('th', '', '现价'),
      el('th', '', '涨跌幅'),
      el('th', '', '首次'),
      el('th', '', '最后'),
      el('th', '', '行业'),
      el('th', '', '原因'),
    ]),
  ]);
  const body = el('tbody', '', level.stocks.map(formatEntry));
  return el('div', `level level-${level.level}`, [
    el('h3', '', `${level.name}（${level.count} 只）`),
    el('table', 'ladder-table', [header, body]),
  ]);
};

const renderEmpty = (warnings, setStatus) => {
  const messages = [];
  if (warnings.includes('non-trading-day')) messages.push('该日为非 A 股交易日');
  else if (warnings.includes('empty-ladder')) messages.push('今日数据暂未更新（盘前 / 数据延迟）');
  else if (warnings.length > 0) messages.push(`状态：${warnings.join('；')}`);
  else messages.push('（无可展示 entries）');
  setStatus(messages.join('；'), warnings.length > 0 && !warnings.includes('non-trading-day'));
  return el('div', 'ladder-empty', messages.join('；'));
};

const renderSummary = (ladder) => {
  const total = ladder.total ?? 0;
  const maxLevel = ladder.maxLevel ?? 0;
  const flags = ladder.warnings ?? [];
  const warningText = flags.length > 0 ? ` · warnings: ${flags.join(' / ')}` : '';
  return el('div', 'ladder-summary', [
    el('div', 'stat', [el('span', 'stat-label', '总计'), el('span', 'stat-value', `${total} 只`)]),
    el('div', 'stat', [el('span', 'stat-label', '最高'), el('span', 'stat-value', `${maxLevel} 连板`)]),
    el('div', 'stat', [el('span', 'stat-label', '来源'), el('span', 'stat-value', ladder.source ?? '--')]),
    el('div', 'stat', [
      el('span', 'stat-label', 'warnings'),
      el('span', `stat-value ${flags.length > 0 ? 'has-warning' : ''}`, flags.length > 0 ? flags.join(' / ') : '无'),
    ]),
  ]);
};

const renderDiff = (diff) => {
  const cells = (label, value, cls = '') =>
    el('div', 'stat', [el('span', 'stat-label', label), el('span', `stat-value ${cls}`, String(value))]);
  return el('div', 'ladder-diff', [
    el('h3', '', 'vs 昨日'),
    cells('totalDelta', diff.totalDelta, diff.totalDelta > 0 ? 'pos' : diff.totalDelta < 0 ? 'neg' : ''),
    cells('maxLevelDelta', diff.maxLevelDelta, diff.maxLevelDelta > 0 ? 'pos' : diff.maxLevelDelta < 0 ? 'neg' : ''),
    cells('top retained', diff.topLevelRetained.length),
    cells('top added', diff.topLevelAdded.length, diff.topLevelAdded.length > 0 ? 'pos' : ''),
    cells('top removed', diff.topLevelRemoved.length, diff.topLevelRemoved.length > 0 ? 'neg' : ''),
  ]);
};

const fetchLadderAndCompare = async (date) => {
  const ladderR = await callApi(`/api/market/limit-up?date=${encodeURIComponent(date)}`);
  if (ladderR.status === 502) {
    return { ok: false, kind: 'upstream-unavailable' };
  }
  if (!ladderR.ok) {
    return { ok: false, kind: ladderR.error?.kind ?? 'internal' };
  }
  // 找前一日（Asia/Shanghai 自然日 -1）
  const prev = (() => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  })();
  const cmpR = await callApi(
    `/api/market/limit-up/compare?date=${encodeURIComponent(date)}&prevDate=${encodeURIComponent(prev)}`,
  );
  return { ok: true, ladder: ladderR.data, compare: cmpR.ok ? cmpR.data : null };
};

const renderDatePicker = (current, setStatus) => {
  const input = el('input', 'date-input', current);
  input.type = 'date';
  input.value = current;
  input.addEventListener('change', () => {
    const v = input.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      setStatus('日期格式必须为 YYYY-MM-DD', true);
      return;
    }
    dateToUrl(v);
    void renderLimitUpLadder(setStatus);
  });
  return input;
};

const renderRefreshButton = (setStatus) => {
  const btn = el('button', 'btn', '刷新');
  btn.addEventListener('click', () => void renderLimitUpLadder(setStatus));
  return btn;
};

export const renderLimitUpLadder = async (setStatus) => {
  const root = $('#route-limit-up');
  if (root === null) return;
  const date = dateFromUrl();
  mount(root, [el('p', 'muted', '加载中…')]);
  const r = await fetchLadderAndCompare(date);
  if (!r.ok) {
    const detail = r.kind === 'upstream-unavailable'
      ? '请确认 ADSHARE_URL 已配置（或在 .env 中设置），并允许 luoome web 访问 adshare 服务。'
      : '';
    mount(root, [
      el('h2', '', '涨停梯队'),
      el('p', 'error', `加载失败：${r.kind}（${detail}）`.trim()),
    ]);
    setStatus(`加载连板天梯失败：${r.kind}`, true);
    return;
  }
  const { ladder, compare } = r;
  const controls = el('div', 'ladder-controls', [
    el('label', '', '日期：'),
    renderDatePicker(date, setStatus),
    renderRefreshButton(setStatus),
  ]);
  const header = el('h2', '', `涨停梯队 · ${ladder.date}`);
  const summary = renderSummary(ladder);
  const body = ladder.levels.length === 0
    ? renderEmpty(ladder.warnings ?? [], setStatus)
    : el('div', 'ladder-levels', ladder.levels.map(renderLevelTable));
  const compareSection = compare !== null
    ? renderDiff(compare.diff)
    : el('p', 'muted', '（vs 昨日 diff 不可用，仅展示当日快照）');
  mount(root, [controls, header, summary, body, compareSection]);
  setStatus(`涨停梯队 ${ladder.date} 加载完成（${ladder.total} 只 / ${ladder.maxLevel} 连板）`);
};
