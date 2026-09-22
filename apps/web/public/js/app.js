/* apps/web/public/js/app.js —— v0.4 入口 + v0.5 W3 多账户切换。 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { initAISettings, renderAISettings } from './ai-settings.js';
import { callApi, getAccountId, setAccountId } from './api.js';
import { initChat, refreshChat } from './chat.js';
import { invalidateDashboardMarket, renderDashboardMarketBlocks } from './dashboard-market.js';
import { initDataTransfer, renderDataTransfer } from './data-transfer.js';
import { renderDragonTiger, teardownDragonTiger } from './dragon-tiger.js';
import { initFeishuSettings, renderFeishuSettings } from './feishu-settings.js';
import { initHoldingsActions, openAddHoldingModal } from './holdings-actions.js';
import { renderIndicesPage, teardownIndices } from './indices.js';
import { renderLimitUpLadder } from './limit-up-ladder.js';
import { navigateToStock, renderMarket, teardownMarket } from './market.js';
import { initMarketSettings, renderMarketSettings } from './market-settings.js';
import { sessionLabel } from './market-shared.js';
import { initMarketSync, renderMarketSyncStatus } from './market-sync.js';
import { initModal } from './modal.js';
import {
  analyzeAllHoldings,
  bindSettingsActions,
  cancelAnalyzeAllHoldings,
  invalidateDashboard,
  renderAdviceList,
  renderDashboard,
  renderDataHealth,
  renderHoldings,
  renderReports,
  renderResearch,
  renderReview,
  renderSettings,
  renderSettingsAccount,
  renderWorkflowRuns,
  resetAdviceDeleteMode,
  runWatchOnce,
  toggleAdviceDeleteMode,
} from './pages.js';
import { createStockSearchBox } from './search-box.js';
import { renderSectors } from './sectors.js';
import {
  initTargetActions,
  renderAlerts,
  renderStrategies,
  renderWatchlists,
} from './target-pages.js';
import { bindTopbarTheme, initTheme } from './theme.js';
import { $ } from './ui.js';

/* ============ 状态行 ============ */

const statusEl = () => $('#status');

/** 成功类状态条 4 秒后自动隐去（自动刷新每 15s 弹一次会一直挡着内容）；错误类保留到下一次状态更新。 */
const STATUS_VISIBLE_MS = 4000;
let statusTimer = null;

const setStatus = (message, isError = false) => {
  const node = statusEl();
  if (node === null) return;
  node.textContent = message;
  node.hidden = false;
  node.className = isError ? 'status error' : 'status';
  if (statusTimer !== null) clearTimeout(statusTimer);
  statusTimer =
    isError || STATUS_VISIBLE_MS <= 0
      ? null
      : setTimeout(() => {
          node.hidden = true;
        }, STATUS_VISIBLE_MS);
};

/** 顶栏高度随断点变化（≤640 变两行）：实测后写回 --topbar-h，供 sticky 偏移（侧栏、报告台账等）复用。 */
const syncTopbarHeight = () => {
  const bar = document.querySelector('.topbar');
  if (bar === null) return;
  const height = Math.round(bar.getBoundingClientRect().height);
  if (height > 0) document.documentElement.style.setProperty('--topbar-h', `${height}px`);
};

const observeTopbarHeight = () => {
  const bar = document.querySelector('.topbar');
  if (bar === null) return;
  syncTopbarHeight();
  if (typeof ResizeObserver === 'undefined') {
    window.addEventListener('resize', syncTopbarHeight);
    return;
  }
  new ResizeObserver(syncTopbarHeight).observe(bar);
};

/* ============ 顶栏时钟 + 交易时段 ============ */

/** 交易时段：来自服务端 get_market_data_status 的 marketSession，不在前端重算交易日历。 */
let marketSession = null;

const renderMarketSession = () => {
  const chip = $('#topbar-session');
  if (chip === null) return;
  if (marketSession === null) {
    chip.hidden = true;
    return;
  }
  chip.textContent = sessionLabel(marketSession);
  chip.classList.toggle('is-quiet', marketSession !== 'trading');
  chip.hidden = false;
};

const refreshMarketSession = async () => {
  const result = await callApi('/api/market-data-status', { timeoutMs: 10000 });
  // 失败保留上一枚徽标：时段指示不值得报错打扰
  if (!result.ok) return;
  marketSession = result.data?.marketSession ?? null;
  renderMarketSession();
};

const startClock = () => {
  const tick = () => {
    const now = new Date();
    const [hour = '--', minute = '--', second = '--'] = now
      .toLocaleTimeString('zh-CN', { hour12: false })
      .split(':');
    const time = $('#topbar-time');
    const sec = $('#topbar-sec');
    if (time !== null) time.textContent = `${hour}:${minute}`;
    if (sec !== null) sec.textContent = `:${second}`;
    const clock = $('#topbar-clock');
    if (clock !== null) {
      const session = marketSession === null ? '' : ` · ${sessionLabel(marketSession)}`;
      const label = `${now.toLocaleString('zh-CN', { hour12: false })}（Asia/Shanghai）${session}`;
      if (clock.title !== label) clock.title = label;
    }
  };
  tick();
  setInterval(tick, 1000);
};

const startMarketSession = () => {
  void refreshMarketSession();
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    void refreshMarketSession();
  }, 60_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshMarketSession();
  });
};

/** 快捷键提示：Mac 用 ⌘K，其余平台用 Ctrl K。 */
const searchShortcutHint = () =>
  /Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? '⌘K' : 'Ctrl K';

/** 弹层打开时不抢快捷键（弹窗优先响应自己的键盘事件）。 */
const overlayOpen = () =>
  $('#modal-overlay')?.hidden === false ||
  $('#theme-drawer')?.classList.contains('is-open') === true;

/** `/` 聚焦搜索（输入控件里不抢），⌘K / Ctrl K 任何位置都聚焦。 */
const bindSearchShortcut = (focusSearch) => {
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const typing =
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable);
    const withModifier = event.metaKey || event.ctrlKey;
    const isSlash = event.key === '/' && !withModifier && !event.altKey;
    const isCmdK = withModifier && !event.altKey && event.key.toLowerCase() === 'k';
    if (!isSlash && !isCmdK) return;
    if (isSlash && typing) return;
    if (overlayOpen()) return;
    event.preventDefault();
    focusSearch();
  });
};

const bindTopbarStockSearch = () => {
  const wrap = $('#topbar-stock-search');
  if (wrap === null || wrap.childElementCount > 0) return;
  const box = createStockSearchBox(wrap, {
    placeholder: '搜索代码 / 名称',
    shortcutHint: searchShortcutHint(),
    onSelect: (stock) => navigateToStock(stock, { resetContext: true }),
  });
  bindSearchShortcut(() => box?.focus());
};

/* ============ 路由分发 ============ */

const ROUTES = [
  'dashboard',
  'indices',
  'market',
  'holdings',
  'strategies',
  'watchlists',
  'alerts',
  'research',
  'advice',
  'reports',
  'review',
  'limit-up',
  'dragon-tiger',
  'sectors',
  'chat',
  'settings',
];

/** 上一帧显示的路由：只在换页时回到顶部，同页重绘（自动刷新、账户切换）不动滚动位置。 */
let shownRoute = null;

const showRoute = async (name) => {
  const safe = ROUTES.includes(name) ? name : 'dashboard';
  // 换页回到页面顶部：各页高度不同，沿用上一页的滚动位置会停在半截卡片或 K 线图上
  if (shownRoute !== safe) window.scrollTo({ top: 0, left: 0 });
  shownRoute = safe;
  invalidateDashboard();
  invalidateDashboardMarket();
  // 离开行情页时停止 60s 自动刷新并销毁图表（设计 §11.4）。
  if (safe !== 'market') teardownMarket();
  // 离开指数页时停止 10s 分时刷新定时器。
  if (safe !== 'indices') teardownIndices();
  // 离开建议页时退出删除选择模式并清空选择集（防状态残留）。
  if (safe !== 'advice') resetAdviceDeleteMode();
  // 离开龙虎榜页时停止 60s 自动刷新定时器。
  if (safe !== 'dragon-tiger') teardownDragonTiger();
  document.querySelectorAll('.route').forEach((node) => {
    node.hidden = node.dataset.route !== safe;
    node.classList.toggle('active', node.dataset.route === safe);
  });
  document.querySelectorAll('.nav-item').forEach((node) => {
    const active = node.dataset.route === safe;
    node.classList.toggle('active', active);
    if (active) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  });
  try {
    if (safe === 'dashboard') {
      await Promise.all([
        renderDashboard(setStatus),
        renderDashboardMarketBlocks(),
        renderDataHealth(setStatus),
      ]);
    } else if (safe === 'market') await renderMarket(setStatus);
    else if (safe === 'indices') await renderIndicesPage(setStatus);
    else if (safe === 'holdings') await renderHoldings(setStatus);
    else if (safe === 'strategies') await renderStrategies(setStatus);
    else if (safe === 'watchlists') await renderWatchlists(setStatus);
    else if (safe === 'alerts') await renderAlerts(setStatus);
    else if (safe === 'research') {
      await renderResearch(setStatus);
    } else if (safe === 'advice') {
      await renderAdviceList(setStatus);
    } else if (safe === 'reports') {
      await renderReports(setStatus);
    } else if (safe === 'review') {
      await renderReview(setStatus);
    } else if (safe === 'limit-up') {
      await renderLimitUpLadder(setStatus);
    } else if (safe === 'dragon-tiger') {
      await renderDragonTiger(setStatus);
    } else if (safe === 'sectors') {
      await renderSectors(setStatus);
    } else if (safe === 'chat') {
      initChat();
      await refreshChat();
    } else if (safe === 'settings') {
      renderSettings(setStatus);
      await renderSettingsTab(setStatus, settingsTab());
    }
  } catch (error) {
    setStatus(`路由错误：${error instanceof Error ? error.message : String(error)}`, true);
  }
};

const currentHash = () => {
  // 深链接形如 #market?stockId=002594.SZ&range=3m：? 前是 routeName（设计 §11.1）。
  const h = window.location.hash.replace(/^#/, '').split('?')[0] ?? '';
  if (h === 'watch' || h === 'groups') return 'alerts';
  if (h === 'tactics') return 'strategies';
  if (h.length > 0) return h;
  const path = window.location.pathname.replace(/^\/|\/$/g, '');
  if (path === 'watch' || path === 'groups') return 'alerts';
  if (path === 'tactics') return 'strategies';
  return ROUTES.includes(path) ? path : 'dashboard';
};

/* ============ 设置页二级菜单（#settings?tab=ai|market|notify|data|system） ============ */

const SETTINGS_TABS = ['ai', 'market', 'notify', 'data', 'system'];

const settingsTab = (hash = window.location.hash) => {
  const tab = new URLSearchParams(hash.split('?')[1] ?? '').get('tab') ?? 'ai';
  return SETTINGS_TABS.includes(tab) ? tab : 'ai';
};

/** 只渲染当前 tab 的分区内容；pane 显隐与 subnav 高亮同步。 */
const renderSettingsTab = async (setStatus, tab) => {
  document.querySelectorAll('[data-settings-pane]').forEach((node) => {
    node.hidden = node.dataset.settingsPane !== tab;
  });
  document.querySelectorAll('.settings-subnav-item').forEach((node) => {
    const active = node.dataset.settingsTab === tab;
    node.classList.toggle('active', active);
    if (active) node.setAttribute('aria-current', 'true');
    else node.removeAttribute('aria-current');
  });
  if (tab === 'ai') {
    initAISettings(setStatus);
    await renderAISettings(setStatus);
  } else if (tab === 'market') {
    initMarketSettings(setStatus);
    await renderMarketSettings(setStatus);
    initMarketSync();
    await renderMarketSyncStatus();
  } else if (tab === 'notify') {
    initFeishuSettings(setStatus);
    await renderFeishuSettings(setStatus);
  } else if (tab === 'data') {
    initDataTransfer();
    await renderDataTransfer();
  } else if (tab === 'system') {
    await renderSettingsAccount();
    await renderWorkflowRuns(setStatus);
  }
};

const onHashChange = () => {
  void showRoute(currentHash());
};

window.addEventListener('hashchange', onHashChange);

/* ============ 多账户切换（v0.5 W3） ============ */

/** 拉取全部账户。返回 { ok, accounts }。 */
const getAccounts = async () => {
  const [result, current] = await Promise.all([callApi('/api/accounts'), callApi('/api/holdings')]);
  if (!result.ok || !('data' in result)) return { ok: false, accounts: [] };
  const data = result.data;
  const accounts =
    data && typeof data === 'object' && 'accounts' in data
      ? /** @type {Array<{id: string, name: string}>} */ (/** @type {unknown} */ (data)).accounts
      : [];
  return {
    ok: true,
    accounts,
    currentAccountId: current.ok ? current.data.accountId : '',
  };
};

/** 切换当前账户：POST 后端 → 成功后写 localStorage。 */
const selectAccount = async (accountId) => {
  if (accountId.length === 0) return { ok: false };
  const result = await callApi('/api/account/select', {
    method: 'POST',
    body: JSON.stringify({ accountId }),
  });
  if (!result.ok) {
    const cause =
      result.error && typeof result.error === 'object' && 'cause' in result.error
        ? String(/** @type {{cause: unknown}} */ (result.error).cause)
        : '切换失败';
    setStatus(`切换账户失败：${cause}`, true);
    return { ok: false };
  }
  setAccountId(accountId);
  setStatus('账户已切换');
  return { ok: true };
};

/** 启动期初始化：拉账户 → 填充 <select> → 必要时把 stored id 同步到后端。 */
const initAccountSelect = async () => {
  const select = $('#account-select');
  if (select === null) return;
  const result = await getAccounts();
  if (!result.ok || result.accounts.length === 0) {
    select.innerHTML = '<option value="">(无账户)</option>';
    if (result.ok) {
      setStatus('当前是空数据库，请在设置页创建真实账户。');
      if (currentHash() !== 'settings') window.location.hash = '#settings';
    }
    return;
  }
  const stored = getAccountId();
  const hasStored = result.accounts.some((a) => a.id === stored);
  const hasCurrent = result.accounts.some((a) => a.id === result.currentAccountId);
  const initialId = hasStored
    ? stored
    : hasCurrent
      ? result.currentAccountId
      : (result.accounts[0]?.id ?? '');
  select.innerHTML = result.accounts
    .map(
      (a) => `<option value="${a.id}"${a.id === initialId ? ' selected' : ''}>${a.name}</option>`,
    )
    .join('');
  if (initialId.length > 0 && !hasStored && initialId !== result.currentAccountId) {
    await selectAccount(initialId);
  } else if (stored.length > 0 && stored !== initialId) {
    await selectAccount(initialId);
  }
};

/** 绑定 change 事件：POST 后端，刷新当前路由。 */
const bindAccountSelect = () => {
  const select = $('#account-select');
  if (select === null) return;
  select.addEventListener('change', async (event) => {
    const target = /** @type {HTMLSelectElement} */ (event.target);
    const nextId = target.value;
    const previous = getAccountId();
    target.disabled = true;
    const r = await selectAccount(nextId);
    target.disabled = false;
    if (!r.ok) {
      target.value = previous;
      return;
    }
    void showRoute(currentHash());
  });
};

/* ============ 一次性绑定：跨路由的按钮 ============ */

const bindGlobalActions = () => {
  initModal();
  initHoldingsActions({ refresh: () => renderHoldings(setStatus), setStatus });
  initTargetActions({ setStatus, refresh: showRoute });

  const addBtn = $('#btn-holding-add');
  if (addBtn !== null) addBtn.addEventListener('click', () => openAddHoldingModal());

  const analyzeBtn = $('#btn-holdings-analyze');
  if (analyzeBtn !== null)
    analyzeBtn.addEventListener('click', () => void analyzeAllHoldings(setStatus));
  const analyzeCancelBtn = $('#btn-holdings-analyze-cancel');
  if (analyzeCancelBtn !== null)
    analyzeCancelBtn.addEventListener('click', () => cancelAnalyzeAllHoldings());

  $('#btn-dashboard-refresh')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await Promise.all([
        renderDashboard(setStatus),
        renderDashboardMarketBlocks(),
        renderDataHealth(setStatus),
      ]);
    } finally {
      button.disabled = false;
    }
  });
  $('#btn-dashboard-watch-run')?.addEventListener('click', () => void runWatchOnce(setStatus));

  const adviceFilter = $('#advice-filter');
  if (adviceFilter !== null)
    adviceFilter.addEventListener('change', () => {
      // 筛选切换退出删除选择模式（选择集跨筛选保留会造成误删）
      resetAdviceDeleteMode();
      void renderAdviceList(setStatus);
    });

  const adviceDeleteModeBtn = $('#btn-advice-delete-mode');
  if (adviceDeleteModeBtn !== null)
    adviceDeleteModeBtn.addEventListener('click', () => void toggleAdviceDeleteMode(setStatus));

  bindSettingsActions();
  bindAccountSelect();
};

/* ============ 看盘分区刷新 ============ */

const startDashboardAutoRefresh = () => {
  let paused = false;
  const visible = () =>
    !paused && document.visibilityState === 'visible' && currentHash() === 'dashboard';
  $('#btn-dashboard-auto-refresh').addEventListener('click', (event) => {
    paused = !paused;
    event.currentTarget.textContent = paused ? '恢复自动更新' : '暂停自动更新';
    event.currentTarget.setAttribute('aria-pressed', String(paused));
    $('#dashboard-paused').hidden = !paused;
    if (paused) {
      invalidateDashboard();
    } else if (visible()) {
      void renderDashboard(setStatus);
      void renderDashboardMarketBlocks();
    }
  });
  setInterval(() => {
    if (visible()) void renderDashboard(setStatus);
  }, 15000);
  setInterval(() => {
    if (!visible()) return;
    void renderDashboardMarketBlocks();
    if (!$('#dashboard-data-health').contains(document.activeElement))
      void renderDataHealth(setStatus);
  }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (!visible()) return;
    void renderDashboard(setStatus);
    void renderDashboardMarketBlocks();
  });
};

/** 持仓页盘中行情轮询；页面隐藏或弹窗打开时暂停，避免后台空跑和打断编辑。 */
const startQuoteAutoRefresh = () => {
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if ($('#modal-overlay')?.hidden === false) return;
    if (currentHash() === 'holdings') void renderHoldings(setStatus);
  }, 10_000);
};

/* ============ 启动 ============ */

window.__luoome = {
  callApi,
  getAccountId,
  setAccountId,
  getAccounts,
  selectAccount,
};

initTheme();
bindTopbarTheme();
bindTopbarStockSearch();
bindGlobalActions();
startClock();
startMarketSession();
observeTopbarHeight();
startDashboardAutoRefresh();
startQuoteAutoRefresh();
void initAccountSelect();
void showRoute(currentHash());
