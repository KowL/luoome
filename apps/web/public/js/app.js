/* apps/web/public/js/app.js —— v0.4 入口 + v0.5 W3 多账户切换。 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi, getAccountId, getToken, setAccountId, setToken, TOKEN_KEY } from './api.js';
import {
  analyzeAllHoldings,
  bindSettingsActions,
  renderAdviceList,
  renderDashboard,
  renderHoldings,
  renderQuotes,
  renderReview,
  renderSettings,
  renderSettingsAccount,
  renderTacticsList,
  runTacticScan,
} from './pages.js';
import { $ } from './ui.js';

/* ============ 状态行 ============ */

const statusEl = () => $('#status');

const setStatus = (message, isError = false) => {
  const node = statusEl();
  if (node === null) return;
  node.textContent = message;
  node.hidden = false;
  node.className = isError ? 'status error' : 'status';
};

/* ============ 顶栏时钟 ============ */

const startClock = () => {
  const tick = () => {
    const node = $('#topbar-clock');
    if (node !== null) {
      node.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    }
  };
  tick();
  setInterval(tick, 1000);
};

/* ============ 路由分发 ============ */

const ROUTES = ['dashboard', 'holdings', 'quotes', 'tactics', 'advice', 'review', 'settings'];

const showRoute = async (name) => {
  const safe = ROUTES.includes(name) ? name : 'dashboard';
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
    if (safe === 'dashboard') await renderDashboard(setStatus);
    else if (safe === 'holdings') await renderHoldings(setStatus);
    else if (safe === 'quotes') await renderQuotes(setStatus);
    else if (safe === 'tactics') {
      await renderTacticsList(setStatus);
    } else if (safe === 'advice') {
      await renderAdviceList(setStatus);
    } else if (safe === 'review') {
      await renderReview(setStatus);
    } else if (safe === 'settings') {
      renderSettings(setStatus);
      await renderSettingsAccount();
    }
  } catch (error) {
    setStatus(`路由错误：${error instanceof Error ? error.message : String(error)}`, true);
  }
};

const currentHash = () => {
  const h = window.location.hash.replace(/^#/, '');
  return h.length > 0 ? h : 'dashboard';
};

const onHashChange = () => {
  void showRoute(currentHash());
};

window.addEventListener('hashchange', onHashChange);

/* ============ 多账户切换（v0.5 W3） ============ */

/** 拉取全部账户。返回 { ok, accounts }。 */
const getAccounts = async () => {
  const result = await callApi('/api/accounts');
  if (!result.ok || !('data' in result)) return { ok: false, accounts: [] };
  const data = result.data;
  const accounts =
    data && typeof data === 'object' && 'accounts' in data
      ? /** @type {Array<{id: string, name: string}>} */ (/** @type {unknown} */ (data)).accounts
      : [];
  return { ok: true, accounts };
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
    return;
  }
  const stored = getAccountId();
  const hasStored = result.accounts.some((a) => a.id === stored);
  const initialId = hasStored ? stored : (result.accounts[0]?.id ?? '');
  select.innerHTML = result.accounts
    .map(
      (a) => `<option value="${a.id}"${a.id === initialId ? ' selected' : ''}>${a.name}</option>`,
    )
    .join('');
  if (initialId.length > 0 && !hasStored) {
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
  const refreshBtn = $('#btn-holdings-refresh');
  if (refreshBtn !== null)
    refreshBtn.addEventListener('click', () => void renderHoldings(setStatus));
  const analyzeBtn = $('#btn-holdings-analyze');
  if (analyzeBtn !== null)
    analyzeBtn.addEventListener('click', () => void analyzeAllHoldings(setStatus));

  const quotesRefreshBtn = $('#btn-quotes-refresh');
  if (quotesRefreshBtn !== null)
    quotesRefreshBtn.addEventListener('click', () => void renderQuotes(setStatus));

  const tlistBtn = $('#btn-tactic-list');
  if (tlistBtn !== null)
    tlistBtn.addEventListener('click', () => void renderTacticsList(setStatus));
  const tscanBtn = $('#btn-tactic-scan');
  if (tscanBtn !== null) tscanBtn.addEventListener('click', () => void runTacticScan(setStatus));

  const adviceFilter = $('#advice-filter');
  if (adviceFilter !== null)
    adviceFilter.addEventListener('change', () => void renderAdviceList(setStatus));

  bindSettingsActions();
  bindAccountSelect();
};

/* ============ 自动刷新（仅仪表盘 5s 周期） ============ */

const startDashboardAutoRefresh = () => {
  setInterval(() => {
    if (currentHash() === 'dashboard') void renderDashboard(setStatus);
  }, 5000);
};

/* ============ 启动 ============ */

window.__luoome = {
  callApi,
  getToken,
  setToken,
  TOKEN_KEY,
  getAccountId,
  setAccountId,
  getAccounts,
  selectAccount,
};

bindGlobalActions();
startClock();
void initAccountSelect();
void showRoute(currentHash());
startDashboardAutoRefresh();
