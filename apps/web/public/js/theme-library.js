/* apps/web/public/js/theme-library.js —— 设置页「系统题材库」管理。
 *
 * - 题材来自 /api/theme-library：原始扶摇概念只作为来源映射保留，不在此重建；
 * - 导入显式触发，重复导入只补缺失题材，不覆盖人工改名 / 归档 / 顺序 / 成分增删；
 * - 增删成分写生效区间，页面只展示当前与历史区间，不提供覆盖历史的编辑；
 * - 所有写操作要求 LUOOME_EXPOSE_WRITE=true，服务端仍做同源 Origin 校验。
 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import { alertDialog, confirmDialog, promptDialog } from './modal.js';
import { $, el, mount } from './ui.js';

const themeStateLabel = (state) => (state === 'archived' ? '已归档' : '启用');

export const sortThemeItems = (items) =>
  [...(items ?? [])].sort((left, right) => {
    const stateDelta =
      Number(left.theme.state === 'archived') - Number(right.theme.state === 'archived');
    return (
      stateDelta ||
      left.theme.sortOrder - right.theme.sortOrder ||
      left.theme.name.localeCompare(right.theme.name, 'zh-Hans-CN')
    );
  });

export const themeMemberSummary = (item) =>
  `${item.activeMemberCount} 只生效 · ${item.memberCount} 段历史 · ${item.sourceCount} 个来源概念`;

export const themeImportNotice = (data) => {
  if (data?.canManage !== true)
    return '题材库只读：需要以 LUOOME_EXPOSE_WRITE=true 启动 Web 才能导入或维护';
  if (data?.initialized === true) return '已导入；重复导入只补缺失题材，不改动人工维护结果';
  return '从本地已同步扶摇概念目录与 active 成分导入首版种子';
};

/* ---------- 自动维护 ---------- */

const AUTO_STATUS_TEXT = {
  running: '执行中',
  succeeded: '成功',
  failed: '失败',
  skipped: '跳过',
};

const AUTO_SKIP_TEXT = {
  not_enabled: '未启用',
  before_close: '未收盘',
  non_trading_day: '非交易日',
  future_date: '未来日期',
  pool_unavailable: '涨停池不可用',
  empty_pool: '涨停池为空',
  no_reason: '无涨停原因',
  incomplete_pool: '数据不完整',
};

const AUTO_PENDING_TEXT = {
  no_reason: '无原因',
  unmatched: '无归属',
  generic_label: '泛标签',
  sentence: '长句',
  too_long: '过长',
  no_concept: '无概念印证',
  single_stock: '仅一只印证',
  archived_theme: '题材已归档',
};

const shortTime = (value) =>
  value == null
    ? ''
    : new Date(value).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });

/** 一行摘要：开关 / 最近执行 / 新增数量 / 待核对。 */
export const themeAutoSummary = (auto) => {
  if (auto === null || auto === undefined) return '自动维护状态未知';
  if (auto.enabled !== true) return '盘后自动维护未启用';
  const last = auto.lastRun;
  if (last === null || last === undefined) return '盘后自动维护已启用，尚未执行';
  const parts = [`最近 ${last.tradingDay} ${AUTO_STATUS_TEXT[last.status] ?? last.status}`];
  if (last.finishedAt != null) parts.push(shortTime(last.finishedAt));
  parts.push(`新增 ${last.createdThemes} 题材 / ${last.createdMembers} 成分`);
  if (last.pendingCount > 0) parts.push(`待核对 ${last.pendingCount}`);
  if (last.skipReason != null) parts.push(AUTO_SKIP_TEXT[last.skipReason] ?? last.skipReason);
  return parts.join(' · ');
};

/** 异常行：只在上一次执行失败 / 跳过且带原因时返回文字。 */
export const themeAutoIssue = (auto) => {
  const last = auto?.lastRun;
  if (last === null || last === undefined) return null;
  if (last.status === 'succeeded' || last.status === 'running') return null;
  const reason = last.errorMessage ?? AUTO_SKIP_TEXT[last.skipReason] ?? last.status;
  return `第 ${last.attempt} 次执行${last.status === 'failed' ? '失败' : '跳过'}：${reason}`;
};

/** 待核对行：日期 + 方向 + 理由，供人逐条判断（不自动建库）。 */
export const themeAutoPendingRows = (items) =>
  (items ?? []).map((item) => ({
    key: `${item.kind}|${item.stockId ?? ''}|${item.label ?? ''}`,
    kind: AUTO_PENDING_TEXT[item.kind] ?? item.kind,
    text: [item.tradingDate, item.label ?? item.stockName ?? item.stockId ?? '—', item.reason]
      .filter((value) => value != null && value !== '')
      .join(' · '),
    note: item.note,
  }));

let themePanelBound = false;
let themeDetailCache = new Map();

const postUpdate = (payload) =>
  callApi('/api/theme-library/update', {
    method: 'POST',
    body: JSON.stringify(payload),
    timeoutMs: 30_000,
  });

const runUpdate = async (payload, setStatus) => {
  const result = await postUpdate(payload);
  if (!result.ok) {
    await alertDialog('题材库操作失败', result.error?.message ?? result.error?.kind ?? '未知错误');
    return false;
  }
  await renderThemeLibrary(setStatus);
  return true;
};

const errorText = (result) =>
  result.error?.message ?? result.error?.cause ?? result.error?.kind ?? '未知错误';

const importThemes = async (setStatus) => {
  const confirmed = await confirmDialog({
    title: '导入系统题材库首版种子',
    message:
      '将读取本地已同步的扶摇概念目录与 active 成分，按标准题材分类去重合并。不会覆盖已有题材的维护结果。',
    confirmLabel: '导入',
  });
  if (!confirmed) return;
  const result = await callApi('/api/theme-library/import', {
    method: 'POST',
    body: JSON.stringify({}),
    timeoutMs: 120_000,
  });
  if (!result.ok) {
    await alertDialog('导入失败', errorText(result));
    return;
  }
  const summary = result.data?.import;
  setStatus?.(
    summary === undefined
      ? '题材库已更新'
      : `题材库导入：新增 ${summary.createdThemes} 个题材、${summary.createdMembers} 条成分`,
  );
  await renderThemeLibrary(setStatus);
};

const createTheme = async (input, setStatus) => {
  const name = input.value.trim();
  if (name.length === 0) return;
  input.disabled = true;
  try {
    const ok = await runUpdate({ action: 'create', name }, setStatus);
    if (ok) input.value = '';
  } finally {
    input.disabled = false;
  }
};

const renameTheme = async (theme, setStatus) => {
  const values = await promptDialog({
    title: '重命名题材',
    note: '只改显示名，不改稳定 id、来源映射与成分。',
    fields: [{ key: 'name', label: '题材名', value: theme.name }],
    confirmLabel: '保存',
  });
  if (values === null) return;
  const name = String(values.name ?? '').trim();
  if (name.length === 0 || name === theme.name) return;
  await runUpdate({ action: 'rename', themeId: theme.id, name }, setStatus);
};

const archiveTheme = async (theme, setStatus) => {
  const confirmed = await confirmDialog({
    title: '归档题材',
    message: `归档后「${theme.name}」不再出现在作战室与题材榜，历史成分区间与来源映射保留。`,
    confirmLabel: '归档',
    danger: true,
  });
  if (!confirmed) return;
  await runUpdate({ action: 'archive', themeId: theme.id }, setStatus);
};

const moveTheme = async (items, theme, delta, setStatus) => {
  const ordered = sortThemeItems(items).map((item) => item.theme.id);
  const index = ordered.indexOf(theme.id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= ordered.length) return;
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  await runUpdate({ action: 'reorder', themeIds: ordered }, setStatus);
};

const loadDetail = async (themeId) => {
  if (themeDetailCache.has(themeId)) return themeDetailCache.get(themeId);
  const result = await callApi(`/api/theme-library?themeId=${encodeURIComponent(themeId)}`, {
    timeoutMs: 15_000,
  });
  const detail = result.ok ? (result.data?.detail ?? null) : null;
  themeDetailCache.set(themeId, detail);
  return detail;
};

const memberRow = (view, theme, setStatus) => {
  const member = view.member;
  const active = member.effectiveTo === null;
  const remove = el('button', 'btn btn-ghost btn-sm', '移除');
  remove.type = 'button';
  remove.disabled = !active || theme.state !== 'active';
  remove.addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: '移除成分',
      message: `结束 ${view.name ?? view.code} 在「${theme.name}」的当前生效区间？历史区间保留。`,
      confirmLabel: '移除',
      danger: true,
    });
    if (!confirmed) return;
    await runUpdate(
      { action: 'remove-member', themeId: theme.id, stockId: member.stockId },
      setStatus,
    );
  });
  return el('tr', '', [
    el('td', '', [
      el('span', '', view.name ?? view.code),
      el('span', 'muted mono', ` ${view.code}`),
    ]),
    el('td', 'muted', member.origin === 'seed' ? '导入' : '人工'),
    el(
      'td',
      'mono muted',
      new Date(member.effectiveFrom).toLocaleString('zh-CN', { hour12: false }),
    ),
    el(
      'td',
      'mono muted',
      active ? '生效中' : new Date(member.effectiveTo).toLocaleString('zh-CN', { hour12: false }),
    ),
    el('td', '', remove),
  ]);
};

const memberEditor = (theme, detail, setStatus) => {
  const active = (detail?.members ?? []).filter((view) => view.member.effectiveTo === null);
  const history = (detail?.members ?? []).filter((view) => view.member.effectiveTo !== null);
  const input = el('input');
  input.placeholder = '股票代码，例如 600519.SH';
  input.setAttribute('aria-label', `${theme.name} 新增关联股票`);
  input.autocomplete = 'off';
  const add = el('button', 'btn btn-outline btn-sm', '添加');
  add.type = 'button';
  add.disabled = theme.state !== 'active';
  add.addEventListener('click', async () => {
    const stockIds = input.value
      .split(/[\s,，]+/)
      .map((value) => value.trim().toUpperCase())
      .filter((value) => value.length > 0);
    if (stockIds.length === 0) return;
    add.disabled = true;
    try {
      const ok = await runUpdate({ action: 'add-members', themeId: theme.id, stockIds }, setStatus);
      if (ok) input.value = '';
    } finally {
      add.disabled = false;
    }
  });
  const table = (rows, label) =>
    el('div', 'theme-member-block', [
      el('p', 'muted', `${label}（${rows.length}）`),
      rows.length === 0
        ? el('p', 'placeholder', '—')
        : el('div', 'table-wrap', [
            el('table', 'table', [
              el('thead', '', [
                el('tr', '', [
                  el('th', '', '股票'),
                  el('th', '', '来源'),
                  el('th', '', '生效起点'),
                  el('th', '', '生效终点'),
                  el('th', '', ''),
                ]),
              ]),
              el(
                'tbody',
                '',
                rows.map((view) => memberRow(view, theme, setStatus)),
              ),
            ]),
          ]),
    ]);
  return el('div', 'theme-member-editor', [
    el(
      'p',
      'muted',
      (detail?.sources ?? []).map((source) => `${source.name}(${source.vendorCode})`).join(' · ') ||
        '无来源映射',
    ),
    el('div', 'theme-member-add', [input, add]),
    table(active, '当前成分'),
    history.length === 0
      ? null
      : el('details', 'theme-member-history', [
          el('summary', '', `历史区间（${history.length}）`),
          table(history, '已结束区间'),
        ]),
  ]);
};

const themeRow = (item, items, options) => {
  const theme = item.theme;
  const details = el('details', 'theme-library-row');
  const summary = el('summary', '', [
    el('span', 'theme-library-name', theme.name),
    el('span', 'muted', themeMemberSummary(item)),
    theme.state === 'archived'
      ? el('span', 'badge badge-hold', themeStateLabel(theme.state))
      : null,
  ]);
  details.append(summary);
  const up = el('button', 'btn btn-ghost btn-sm', '↑');
  up.type = 'button';
  up.disabled = !options.canManage;
  up.setAttribute('aria-label', `上移 ${theme.name}`);
  up.addEventListener('click', (event) => {
    event.preventDefault();
    void moveTheme(items, theme, -1, options.setStatus);
  });
  const down = el('button', 'btn btn-ghost btn-sm', '↓');
  down.type = 'button';
  down.disabled = !options.canManage;
  down.setAttribute('aria-label', `下移 ${theme.name}`);
  down.addEventListener('click', (event) => {
    event.preventDefault();
    void moveTheme(items, theme, 1, options.setStatus);
  });
  const rename = el('button', 'btn btn-outline btn-sm', '改名');
  rename.type = 'button';
  rename.disabled = !options.canManage;
  rename.addEventListener('click', (event) => {
    event.preventDefault();
    void renameTheme(theme, options.setStatus);
  });
  const archive = el('button', 'btn btn-outline btn-sm', '归档');
  archive.type = 'button';
  archive.disabled = !options.canManage || theme.state === 'archived';
  archive.addEventListener('click', (event) => {
    event.preventDefault();
    void archiveTheme(theme, options.setStatus);
  });
  details.append(
    el('div', 'theme-library-actions', [
      up,
      down,
      rename,
      archive,
      el('span', 'muted', `顺序 ${theme.sortOrder + 1}`),
    ]),
    el('div', 'theme-library-detail', el('p', 'placeholder', '展开后读取成分…')),
  );
  details.addEventListener('toggle', async () => {
    if (!details.open) return;
    const slot = details.querySelector('.theme-library-detail');
    if (slot === null || slot.dataset.loaded === '1') return;
    slot.dataset.loaded = '1';
    const detail = await loadDetail(theme.id);
    if (!details.open) {
      slot.dataset.loaded = '0';
      return;
    }
    mount(slot, memberEditor(theme, detail, options.setStatus));
  });
  return details;
};

const runAutoMaintenance = async (payload, setStatus) => {
  const result = await callApi('/api/theme-library/auto/run', {
    method: 'POST',
    body: JSON.stringify(payload),
    timeoutMs: 120_000,
  });
  if (!result.ok) {
    await alertDialog('自动维护未完成', errorText(result));
    await renderThemeLibrary(setStatus);
    return;
  }
  const run = result.data;
  const detail =
    run.status === 'succeeded'
      ? `${run.tradingDay} 新增 ${run.createdThemes} 题材 / ${run.createdMembers} 成分，待核对 ${run.pendingCount}`
      : `${run.tradingDay} ${AUTO_STATUS_TEXT[run.status] ?? run.status}${run.skipReason === null ? '' : `（${AUTO_SKIP_TEXT[run.skipReason] ?? run.skipReason}）`}`;
  setStatus?.(`题材库自动维护：${detail}`);
  await renderThemeLibrary(setStatus);
};

const setAutoEnabled = async (enabled, setStatus) => {
  const result = await callApi('/api/theme-library/auto/settings', {
    method: 'POST',
    body: JSON.stringify({ enabled }),
    timeoutMs: 15_000,
  });
  if (!result.ok) {
    await alertDialog('自动维护开关保存失败', errorText(result));
    return;
  }
  await renderThemeLibrary(setStatus);
};

const autoPanel = (data, canManage, setStatus) => {
  const auto = data.auto ?? null;
  const enabled = auto?.enabled === true;
  const toggle = el('input');
  toggle.type = 'checkbox';
  toggle.checked = enabled;
  toggle.disabled = !canManage;
  toggle.setAttribute('aria-label', '盘后自动维护');
  toggle.addEventListener('change', () => void setAutoEnabled(toggle.checked, setStatus));
  const runButton = el('button', 'btn btn-outline btn-sm', '立即执行');
  runButton.type = 'button';
  runButton.addEventListener('click', () => void runAutoMaintenance({}, setStatus));
  const dateInput = el('input');
  dateInput.type = 'date';
  dateInput.setAttribute('aria-label', '补跑日期');
  const backfillButton = el('button', 'btn btn-outline btn-sm', '补跑');
  backfillButton.type = 'button';
  backfillButton.addEventListener('click', () => {
    const tradingDate = dateInput.value.trim();
    if (tradingDate.length === 0) return;
    void runAutoMaintenance({ tradingDate }, setStatus);
  });
  const issue = themeAutoIssue(auto);
  const pendingRows = themeAutoPendingRows(auto?.pending);
  const pending = el('div', 'theme-auto-pending');
  if (pendingRows.length > 0) {
    pending.append(
      el('details', '', [
        el('summary', '', `待核对（${pendingRows.length}）`),
        el(
          'ul',
          'theme-auto-pending-list',
          pendingRows
            .slice(0, 40)
            .map((row) =>
              el('li', '', [
                el('span', 'badge badge-hold', row.kind),
                el('span', '', ` ${row.text}`),
                el('span', 'muted', ` ${row.note}`),
              ]),
            ),
        ),
      ]),
    );
  }
  return el('div', 'theme-auto', [
    el('div', 'theme-auto-head', [
      el('label', 'theme-auto-switch', [toggle, el('span', '', '盘后自动维护')]),
      el('span', 'muted', themeAutoSummary(auto)),
    ]),
    issue === null ? null : el('p', 'theme-auto-issue', issue),
    el('div', 'theme-auto-actions', [runButton, dateInput, backfillButton]),
    pending,
  ]);
};

const renderThemeList = (box, data, setStatus) => {
  const items = sortThemeItems(data.themes);
  const canManage = data.canManage === true;
  const input = el('input');
  input.placeholder = '新题材名称';
  input.setAttribute('aria-label', '新题材名称');
  input.maxLength = 40;
  input.disabled = !canManage;
  const create = el('button', 'btn btn-primary btn-sm', '新建题材');
  create.type = 'button';
  create.disabled = !canManage;
  create.addEventListener('click', () => void createTheme(input, setStatus));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void createTheme(input, setStatus);
    }
  });
  const importButton = el(
    'button',
    'btn btn-outline btn-sm',
    data.initialized ? '补齐缺失题材' : '导入首版种子',
  );
  importButton.type = 'button';
  importButton.disabled = !canManage;
  importButton.addEventListener('click', () => void importThemes(setStatus));
  const lastImport = data.lastImport;
  const importLine =
    lastImport === null || lastImport === undefined
      ? themeImportNotice(data)
      : `${themeImportNotice(data)} · 上次 ${new Date(lastImport.appliedAt).toLocaleString('zh-CN', { hour12: false })} · 新增 ${lastImport.createdThemes} 题材 / ${lastImport.createdMembers} 成分`;
  const list = el('div', 'theme-library-list');
  if (items.length === 0) {
    list.append(el('p', 'placeholder', '题材库为空'));
  } else {
    list.append(...items.map((item) => themeRow(item, data.themes, { canManage, setStatus })));
  }
  mount(box, [
    el('div', 'card', [
      autoPanel(data, canManage, setStatus),
      el('div', 'card-header', [
        el('div', '', [el('h2', '', '系统题材库'), el('div', 'card-meta', importLine)]),
        el('div', 'theme-library-import', [importButton]),
      ]),
      el('div', 'theme-library-create', [input, create]),
      list,
    ]),
  ]);
};

export const renderThemeLibrary = async (setStatus) => {
  const box = $('#theme-library');
  if (box === null) return;
  themeDetailCache = new Map();
  const result = await callApi('/api/theme-library?state=all', { timeoutMs: 15_000 });
  if (!result.ok) {
    mount(box, el('p', 'placeholder', `题材库读取失败：${errorText(result)}`));
    return;
  }
  renderThemeList(box, result.data, setStatus);
};

export const initThemeLibrary = (setStatus) => {
  if (themePanelBound) return;
  themePanelBound = true;
  void renderThemeLibrary(setStatus);
};
