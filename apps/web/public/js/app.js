/* apps/web/public/js/app.js —— v0.4 入口：状态行 + 时钟 + 路由分发。 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi, getToken, setToken, TOKEN_KEY } from './api.js';
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

/* 暴露 token 工具到 window（供 pages/settings 调用）。 */
window.__luoome = { callApi, getToken, setToken, TOKEN_KEY };

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
  // 切换可见性
  document.querySelectorAll('.route').forEach((node) => {
    node.hidden = node.dataset.route !== safe;
    node.classList.toggle('active', node.dataset.route === safe);
  });
  // 侧栏高亮
  document.querySelectorAll('.nav-item').forEach((node) => {
    const active = node.dataset.route === safe;
    node.classList.toggle('active', active);
    if (active) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  });
  // 路由加载
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

/* ============ 一次性绑定：跨路由的按钮 ============ */

const bindGlobalActions = () => {
  // 持仓页
  const refreshBtn = $('#btn-holdings-refresh');
  if (refreshBtn !== null)
    refreshBtn.addEventListener('click', () => void renderHoldings(setStatus));
  const analyzeBtn = $('#btn-holdings-analyze');
  if (analyzeBtn !== null)
    analyzeBtn.addEventListener('click', () => void analyzeAllHoldings(setStatus));

  // 行情页
  const quotesRefreshBtn = $('#btn-quotes-refresh');
  if (quotesRefreshBtn !== null)
    quotesRefreshBtn.addEventListener('click', () => void renderQuotes(setStatus));

  // 战法页
  const tlistBtn = $('#btn-tactic-list');
  if (tlistBtn !== null)
    tlistBtn.addEventListener('click', () => void renderTacticsList(setStatus));
  const tscanBtn = $('#btn-tactic-scan');
  if (tscanBtn !== null) tscanBtn.addEventListener('click', () => void runTacticScan(setStatus));

  // 建议页：decision filter
  const adviceFilter = $('#advice-filter');
  if (adviceFilter !== null)
    adviceFilter.addEventListener('change', () => void renderAdviceList(setStatus));

  // 设置页
  bindSettingsActions();
};

/* ============ 自动刷新（仅仪表盘 5s 周期，路由切换即时刷新） ============ */

const startDashboardAutoRefresh = () => {
  setInterval(() => {
    if (currentHash() === 'dashboard') void renderDashboard(setStatus);
  }, 5000);
};

/* ============ 启动 ============ */

bindGlobalActions();
startClock();
void showRoute(currentHash());
startDashboardAutoRefresh();
