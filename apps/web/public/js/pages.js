/* apps/web/public/js/pages.js —— 7 个路由页面的渲染逻辑。 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi, getAccountId } from './api.js';
import {
  openCloseConfirm,
  openConfirmModal,
  openEditModal,
  openTradeModal,
} from './holdings-actions.js';
import { DASHBOARD_INDEX_CODES, INDEX_DEFS } from './index-defs.js';
import { renderIndexCards } from './index-strip.js';
import { buildMarketLink, parseRouteHash } from './market.js';
import { DATASET_LABELS } from './market-sync.js';
import { alertDialog, confirmDialog, promptDialog } from './modal.js';
import { stockIdentityLink } from './stock-link.js';
import {
  $,
  adviceCard,
  compareValues,
  createPagination,
  decisionBadge,
  el,
  fmtDateTime,
  fmtNum,
  fmtPct,
  fmtSigned,
  mount,
  sortableHeader,
  statBlock,
} from './ui.js';

/* 跨自动刷新保留的列表排序状态（dashboard 5s、holdings 10s 会重绘，不持久则排序瞬间失效） */
let boardSortState = { key: null, order: 'desc' };
let holdingsSortState = { key: null, order: 'desc' };
let researchRemoteSyncController = null;

/* ============ dashboard ============ */

const navigateTo = (href) => {
  window.location.hash = `#${href.replace(/^#/, '')}`;
};

const routeStockId = (hash = window.location.hash) => {
  const value = parseRouteHash(hash).params.get('stockId')?.trim().toUpperCase();
  return value === undefined || value.length === 0 ? null : value;
};

/** 报告 list block 的 advice 深链接（#advice?id=…）：定位到具体建议条目。 */
const routeAdviceId = (hash = window.location.hash) => {
  const value = parseRouteHash(hash).params.get('id')?.trim();
  return value === undefined || value.length === 0 ? null : value;
};

const filterAdvices = (advices, decision, stockId) =>
  advices.filter(
    (advice) =>
      (decision === 'all' || advice.decision === decision) &&
      (stockId === null || advice.subjectId === stockId),
  );

/** Trade 的显式归因包含 Advice、研究假设版本或 StrategyVersion 任一 provenance。 */
const decisionLoopAttributionRate = (trades) => {
  if (trades.total === 0) return null;
  return (trades.total - trades.unattributed) / trades.total;
};

const calibrationRateText = (rate, withOutcome) => (withOutcome === 0 ? '--' : fmtPct(rate));

const calibrationPnlText = (pnl, withOutcome) => (withOutcome === 0 ? '--' : fmtSigned(pnl));

const formatMetricDistribution = (counts, label) => {
  const entries = Object.entries(counts ?? {});
  if (entries.length === 0) return `—`;
  return entries.map(([k, v]) => `${label?.[k] ?? k}×${v}`).join(' · ');
};

/** 股票代码 / 名称 → 行情页锚点。textContent 赋值，不拼 HTML。 */
const stockMarketLink = (stockId, text) => {
  const a = el('a', 'stock-link', text);
  a.setAttribute('href', buildMarketLink(stockId));
  return a;
};

/* ---- 看板纯函数（pages.test.js 直接单测） ---- */

/**
 * 看板排序：持仓行置顶（保持服务端返回顺序），其余按 |changePct| 降序，
 * 无涨跌幅（null）排最后。
 */
const sortBoardItems = (items) => {
  const holdings = items.filter((item) => item.holding !== null && item.holding !== undefined);
  const rest = items.filter((item) => item.holding === null || item.holding === undefined);
  rest.sort((a, b) => {
    if (a.changePct === null && b.changePct === null) return 0;
    if (a.changePct === null) return 1;
    if (b.changePct === null) return -1;
    return Math.abs(b.changePct) - Math.abs(a.changePct);
  });
  return [...holdings, ...rest];
};

/** 看板涨跌平统计；无行情 / 无基准（changePct 为 null）计入平。 */
const boardStats = (items) => ({
  up: items.filter((item) => typeof item.changePct === 'number' && item.changePct > 0).length,
  down: items.filter((item) => typeof item.changePct === 'number' && item.changePct < 0).length,
  flat: items.filter((item) => item.changePct === null || item.changePct === 0).length,
});

/** 盯盘最近一轮评估摘要；字段名与 WatchRunSchema（evaluatedPools 等）对齐。 */
const watchRunSummaryText = (latest) =>
  latest === null
    ? '跑一轮后显示评估指标'
    : `评估 ${latest.evaluatedPools} 个方案 / ${latest.evaluatedStocks} 只股票 · ` +
      `触发 ${latest.triggered} · 通知 ${latest.notified}`;

/* ---- 看板 / 指数条 / 今日预警渲染 ---- */

const fmtTime = (d) => {
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleTimeString('zh-CN', { hour12: false });
};

const ALERT_PRIORITY_LABEL = { urgent: '急', important: '重要', normal: '普通' };
const ALERT_PRIORITY_BADGE = {
  urgent: 'badge-urgent',
  important: 'badge-important',
  normal: 'badge-normal',
};
const ALERT_PRIORITY_ORDER = { urgent: 0, important: 1, normal: 2 };
const ALERT_DIRECTION_BADGE = {
  buy: { cls: 'badge-buy', label: '买入' },
  sell: { cls: 'badge-sell', label: '卖出' },
  watch: { cls: 'badge-watch', label: '关注' },
};

/** 看盘页核心指数 4 卡（渲染器在 index-strip.js，与指数页共用）；数据空时卡片仍渲染为 '--'。 */
const renderIndices = (indicesData) => {
  const defs = DASHBOARD_INDEX_CODES.map(
    (code) => INDEX_DEFS.find((d) => d.code === code) ?? { code, name: code },
  );
  renderIndexCards('dashboard-indices', defs, indicesData, {
    onSelect: (code) => navigateTo(`indices?code=${encodeURIComponent(code)}`),
  });
};

const boardAlertCell = (todayTrigger) => {
  if (todayTrigger === null || todayTrigger === undefined) return el('span', 'muted', '—');
  return el('span', 'board-alert', [
    el('span', 'mono', `${todayTrigger.count} 次`),
    el(
      'span',
      `badge ${ALERT_PRIORITY_BADGE[todayTrigger.maxPriority] ?? ''}`,
      ALERT_PRIORITY_LABEL[todayTrigger.maxPriority] ?? todayTrigger.maxPriority,
    ),
  ]);
};

const boardRow = (item) => {
  const chgCls =
    item.changePct === null ? '' : item.changePct > 0 ? 'pos' : item.changePct < 0 ? 'neg' : '';
  const row = el('tr', item.holding !== null ? 'board-row board-holding' : 'board-row');
  const nameChildren = [stockIdentityLink({ stockId: item.stockId, stockName: item.name })];
  if (item.holding !== null) nameChildren.push(el('span', 'badge badge-holding', '持仓'));
  row.append(
    el('td', null, el('div', 'board-name-cell', nameChildren)),
    el('td', `num ${chgCls}`, item.quote === null ? '--' : fmtNum(item.quote.close)),
    el('td', `num ${chgCls}`, item.changePct === null ? '--' : `${fmtSigned(item.changePct)}%`),
    el(
      'td',
      null,
      item.watchlists.length === 0
        ? el('span', 'muted', '—')
        : item.watchlists.map((name) => el('span', 'badge board-group-tag', name)),
    ),
    el('td', null, boardAlertCell(item.todayTrigger)),
  );
  row.addEventListener('click', (event) => {
    if (event.target.closest('a, button, input, select, textarea') !== null) return;
    navigateTo(buildMarketLink(item.stockId));
  });
  return row;
};

const defaultOrderForKey = (key) => (key === 'price' || key.endsWith('price') ? 'asc' : 'desc');

const renderBoard = (items) => {
  const wrap = $('#dashboard-board');
  if (wrap === null) return;
  const meta = $('#dashboard-board-meta');
  if (items.length === 0) {
    if (meta !== null) meta.textContent = '';
    mount(wrap, el('p', 'placeholder', '看板为空：添加持仓，或启用引用 Watchlist 的 AlertPlan。'));
    return;
  }
  const stats = boardStats(items);
  if (meta !== null) {
    meta.textContent = `${items.length} 只 · 涨${stats.up} 跌${stats.down} 平${stats.flat}`;
  }
  const listContainer = el('div', 'paginated-list');
  const buildBoardTable = (pageItems) =>
    el('table', 'table board-table', [
      el(
        'thead',
        null,
        el('tr', null, [
          el('th', null, '名称'),
          sortableHeader('现价', 'price', boardSortState, onSort),
          sortableHeader('涨跌幅', 'changePct', boardSortState, onSort),
          el('th', null, 'Watchlist'),
          el('th', null, '预警'),
        ]),
      ),
      el('tbody', null, pageItems.map(boardRow)),
    ]);
  const sortedItems = () => {
    if (boardSortState.key === null) return sortBoardItems(items);
    const direction = boardSortState.order === 'asc' ? 1 : -1;
    return [...items].sort((a, b) => {
      const getSortValue = (item) =>
        boardSortState.key === 'price' ? (item.quote?.close ?? null) : (item.changePct ?? null);
      return direction * compareValues(getSortValue(a), getSortValue(b));
    });
  };
  function onSort(key) {
    boardSortState =
      boardSortState.key === key
        ? { key, order: boardSortState.order === 'asc' ? 'desc' : 'asc' }
        : { key, order: defaultOrderForKey(key) };
    renderPage();
  }
  function renderPage() {
    const sorted = sortedItems();
    const { page, pageSize } = pagination.getState();
    mount(listContainer, buildBoardTable(sorted.slice((page - 1) * pageSize, page * pageSize)));
  }
  const pagination = createPagination({ total: items.length, onChange: renderPage });
  renderPage();
  mount(wrap, [listContainer, pagination.root]);
};

/** 今日预警紧凑行：时间 / 股票 / 方向 / 原因 / 优先级 badge；urgent 行高亮。 */
const alertRow = (t) => {
  const priority = t.priority ?? 'normal';
  const dir = ALERT_DIRECTION_BADGE[t.direction] ?? { cls: '', label: t.direction ?? '--' };
  return el('div', `alert-row${priority === 'urgent' ? ' alert-urgent' : ''}`, [
    el('span', 'alert-time mono', fmtTime(t.createdAt)),
    stockMarketLink(t.stockId, t.stockId),
    el('span', `badge ${dir.cls}`, dir.label),
    el('span', 'alert-reason', typeof t.reason === 'string' ? t.reason : ''),
    el(
      'span',
      `badge ${ALERT_PRIORITY_BADGE[priority] ?? ''}`,
      ALERT_PRIORITY_LABEL[priority] ?? priority,
    ),
  ]);
};

const sortAlerts = (triggers) =>
  [...triggers].sort((a, b) => {
    const pa = ALERT_PRIORITY_ORDER[a.priority] ?? ALERT_PRIORITY_ORDER.normal;
    const pb = ALERT_PRIORITY_ORDER[b.priority] ?? ALERT_PRIORITY_ORDER.normal;
    if (pa !== pb) return pa - pb;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

const renderDashboard = async (setStatus) => {
  const result = await callApi('/api/dashboard');
  if (!result.ok) {
    setStatus(`仪表盘加载失败：${result.error.kind}`, true);
    return;
  }
  const {
    advice: adviceData,
    watchlists,
    alertPlans,
    watch,
    staleWatchlistCount,
    metrics,
    indices,
    board,
    todayTriggers,
  } = result.data;

  // 核心指数 4 卡 + 实时看板
  renderIndices(indices);
  renderBoard(Array.isArray(board) ? board : []);

  // 今日建议 Top 3（条数与决策分布并入卡片 meta；持仓汇总卡片已移至持仓页）
  const advices = adviceData.advices;
  const top = [...advices].sort((a, b) => b.confidence - a.confidence).slice(0, 3);
  mount(
    $('#dash-advice-list'),
    top.length === 0
      ? el('p', 'placeholder', '暂无建议，去「持仓」页点「分析全部」生成。')
      : top.map(adviceCard),
  );
  const byDecision = advices.reduce((acc, a) => {
    acc[a.decision] = (acc[a.decision] ?? 0) + 1;
    return acc;
  }, {});
  const decisionSummary = Object.entries(byDecision)
    .map(([decision, count]) => `${decision}×${count}`)
    .join(' · ');
  $('#dash-advice-meta').textContent =
    `共 ${advices.length} 条${decisionSummary.length > 0 ? ` · ${decisionSummary}` : ''}`;

  setHealth('#dash-watch-dot', watch.state);
  $('#dash-watch-state').textContent = healthLabel(watch.state);
  $('#dash-watch-time').textContent =
    watch.latest === null
      ? '尚未运行'
      : `最近 ${fmtDateTime(watch.latest.finishedAt ?? watch.latest.startedAt)}`;
  $('#dash-watch-run-summary').textContent = watchRunSummaryText(watch.latest);
  $('#dash-alert-count').textContent = String(alertPlans.total);
  $('#dash-watchlist-count').textContent = String(watchlists.total);
  $('#dash-stale-count').textContent = String(staleWatchlistCount);

  // 今日预警（urgent 置顶，至多 8 条）
  const alerts = sortAlerts(Array.isArray(todayTriggers) ? todayTriggers : []).slice(0, 8);
  mount(
    $('#dash-trigger-list'),
    alerts.length === 0
      ? el('p', 'placeholder', '今日暂无触发。盯盘即使没有信号，也会记录运行心跳。')
      : el('div', 'alert-list', alerts.map(alertRow)),
  );

  // v0.7 策略预警指标（§11 / §12）
  if (metrics && typeof metrics === 'object') {
    const card = $('#dash-metrics-card');
    if (card !== null) card.hidden = false;
    $('#dash-metric-total').textContent = String(metrics.todayTotal ?? 0);
    const PRIORITY_LABEL = ALERT_PRIORITY_LABEL;
    const DELIVERY_LABEL = {
      'not-requested': '仅记录',
      'suppressed-cooldown': '冷却',
      'suppressed-daily-limit': '日上限',
      pending: '待发',
      sent: '已发',
      failed: '失败',
      'fallback-log': '降级',
    };
    $('#dash-metric-priority').textContent = formatMetricDistribution(
      metrics.priorityCounts,
      PRIORITY_LABEL,
    );
    $('#dash-metric-delivery').textContent = formatMetricDistribution(
      metrics.deliveryStatusCounts,
      DELIVERY_LABEL,
    );
    const lr = metrics.latestRun ?? {};
    $('#dash-metric-failed').textContent = `${lr.notifyFailed ?? 0}`;
    $('#dash-metric-daily-cap').textContent = `${lr.suppressedByDailyLimit ?? 0}`;
    const noiseSample = metrics.feedbackTotal ?? 0;
    $('#dash-metric-noise').textContent =
      metrics.noiseRate === null
        ? `样本 ${noiseSample}/30`
        : `${(metrics.noiseRate * 100).toFixed(1)}%（n=${noiseSample}）`;
    const metaParts = [];
    if (metrics.latestRun && metrics.latestRun.notifyFailed > 0) {
      metaParts.push(`⚠ ${metrics.latestRun.notifyFailed} 条发送失败`);
    }
    if (metrics.latestRun && metrics.latestRun.suppressedByDailyLimit > 0) {
      metaParts.push(`${metrics.latestRun.suppressedByDailyLimit} 条日上限抑制`);
    }
    if (metrics.latestRun?.error) {
      metaParts.push(`最近一轮失败：${metrics.latestRun.error}`);
    }
    $('#dash-metrics-meta').textContent = metaParts.join(' · ');
  }

  setStatus('仪表盘已刷新');
};

/* ============ holdings ============ */

const renderHoldings = async (setStatus) => {
  const [r, tradesResult] = await Promise.all([
    callApi('/api/holdings'),
    callApi('/api/trades?limit=50'),
  ]);
  const body = $('#holdings-body');
  if (!r.ok) {
    mount(
      body,
      el('tr', null, el('td', { colspan: 8, class: 'placeholder' }, `加载失败：${r.error.kind}`)),
    );
    setStatus(`加载失败：${r.error.kind}`, true);
    return;
  }
  const { holdings, totalValue, totalPnL, totalPnLPct, totalTodayPnl, totalTodayPnlPct } = r.data;
  // 缓存给「分析全部」复用，批量入口不再重复拉 /api/holdings
  currentHoldings = holdings;

  // 顶部汇总卡片（从看盘页迁入；口径与原 dashboard-stats 一致）
  $('#holdings-stat-total-value').textContent = fmtNum(totalValue);
  const statPnlNode = $('#holdings-stat-total-pnl');
  statPnlNode.textContent = fmtSigned(totalPnL);
  statPnlNode.className = `value ${totalPnL > 0 ? 'text-pos' : totalPnL < 0 ? 'text-neg' : ''}`;
  const statPnlPctNode = $('#holdings-stat-total-pnl-pct');
  statPnlPctNode.textContent = fmtPct(totalPnLPct);
  statPnlPctNode.className = `delta ${totalPnL > 0 ? 'pos' : totalPnL < 0 ? 'neg' : ''}`;
  $('#holdings-stat-count').textContent = String(holdings.length);

  const tableWrap = body.closest('.table-wrap');
  let paginationWrap = tableWrap?.nextElementSibling;
  if (
    paginationWrap === null ||
    !(paginationWrap instanceof Element) ||
    !paginationWrap.classList.contains('pagination-wrap')
  ) {
    paginationWrap = document.createElement('div');
    paginationWrap.className = 'pagination-wrap';
    tableWrap?.after(paginationWrap);
  }

  const holdingRow = (item) => {
    const code = String(item.holding.stockId).split('.')[0] || item.holding.stockId;
    const pnlCls = item.pnl > 0 ? 'pos' : item.pnl < 0 ? 'neg' : '';
    const todayCls =
      item.todayPnl === null ? '' : item.todayPnl > 0 ? 'pos' : item.todayPnl < 0 ? 'neg' : '';
    const h = {
      id: item.holding.id,
      stockId: item.holding.stockId,
      stockName: item.stockName,
      quantity: item.holding.quantity,
      availableQuantity: item.holding.availableQuantity,
      avgCost: item.holding.avgCost,
      currentPrice: item.currentPrice,
    };
    const actionBtn = (label, onClick) => {
      const b = el('button', 'btn btn-outline btn-sm', label);
      b.type = 'button';
      b.addEventListener('click', () => onClick(b));
      return b;
    };
    const row = el('tr', null, [
      el('td', null, [
        el('div', null, [
          stockMarketLink(item.holding.stockId, item.stockName),
          adviceSlot(item.holding.stockId),
        ]),
        el('div', 'cell-sub muted', stockMarketLink(item.holding.stockId, code)),
      ]),
      el('td', 'num', String(item.holding.quantity)),
      el('td', 'num', fmtNum(item.holding.avgCost)),
      el('td', 'num', fmtNum(item.currentPrice)),
      el('td', 'num', fmtNum(item.marketValue)),
      el('td', `num ${todayCls}`, [
        el('div', null, item.todayPnl === null ? '--' : fmtSigned(item.todayPnl)),
        el('div', 'cell-sub', item.todayPnlPct === null ? '' : fmtPct(item.todayPnlPct)),
      ]),
      el('td', `num ${pnlCls}`, [
        el('div', null, fmtSigned(item.pnl)),
        el('div', 'cell-sub', fmtPct(item.pnlPct)),
      ]),
      el('td', null, [
        el('div', 'row-actions', [
          actionBtn('分析', (btn) => void runAnalyzeStock(item.holding.stockId, setStatus, btn)),
          actionBtn('加仓', () => openTradeModal(h, 'buy')),
          actionBtn('减仓', () => openTradeModal(h, 'sell')),
          actionBtn('纠错', () => openEditModal(h)),
          actionBtn('平仓', () => openCloseConfirm(h)),
        ]),
      ]),
    ]);
    row.dataset.stockId = item.holding.stockId;
    return row;
  };

  const table = body.closest('table');
  const thead = table?.querySelector('thead');
  const getSortValue = (item, key) => {
    if (key === 'currentPrice') return item.currentPrice ?? null;
    if (key === 'marketValue') return item.marketValue ?? null;
    if (key === 'todayPnlPct') return item.todayPnlPct ?? null;
    if (key === 'pnlPct') return item.pnlPct ?? null;
    return null;
  };
  const sortedHoldings = () => {
    if (holdingsSortState.key === null) return holdings;
    const direction = holdingsSortState.order === 'asc' ? 1 : -1;
    return [...holdings].sort(
      (a, b) =>
        direction *
        compareValues(
          getSortValue(a, holdingsSortState.key),
          getSortValue(b, holdingsSortState.key),
        ),
    );
  };
  const renderHead = () => {
    if (thead === null) return;
    mount(
      thead,
      el('tr', null, [
        el('th', null, '名称 / 代码'),
        el('th', 'num', '数量'),
        el('th', 'num', '成本'),
        sortableHeader('现价', 'currentPrice', holdingsSortState, onSort, 'num'),
        sortableHeader('市值', 'marketValue', holdingsSortState, onSort, 'num'),
        sortableHeader('今日盈亏', 'todayPnlPct', holdingsSortState, onSort, 'num'),
        sortableHeader('盈亏', 'pnlPct', holdingsSortState, onSort, 'num'),
        el('th', null, '操作'),
      ]),
    );
  };
  function onSort(key) {
    holdingsSortState =
      holdingsSortState.key === key
        ? { key, order: holdingsSortState.order === 'asc' ? 'desc' : 'asc' }
        : { key, order: defaultOrderForKey(key) };
    renderHead();
    renderHoldingsPage();
  }

  function renderHoldingsPage() {
    const { page, pageSize } = pagination.getState();
    const pageItems = sortedHoldings().slice((page - 1) * pageSize, page * pageSize);
    mount(body, pageItems.map(holdingRow));
  }
  const pagination = createPagination({
    total: holdings.length,
    onChange: renderHoldingsPage,
  });

  renderHead();
  if (holdings.length === 0) {
    mount(body, el('tr', null, el('td', { colspan: 8, class: 'placeholder' }, '（无持仓）')));
    paginationWrap.replaceChildren();
  } else {
    renderHoldingsPage();
    mount(paginationWrap, pagination.root);
  }
  $('#holdings-total-value').textContent = fmtNum(totalValue);
  const totalPnlCls = totalPnL > 0 ? 'text-pos' : totalPnL < 0 ? 'text-neg' : '';
  mount($('#holdings-total-pnl'), [
    el('div', totalPnlCls, fmtSigned(totalPnL)),
    el('div', 'cell-sub', fmtPct(totalPnLPct)),
  ]);
  const todayTotalNode = $('#holdings-total-today-pnl');
  if (totalTodayPnl === null) {
    todayTotalNode.textContent = '--';
  } else {
    const totalTodayCls = totalTodayPnl > 0 ? 'text-pos' : totalTodayPnl < 0 ? 'text-neg' : '';
    mount(todayTotalNode, [
      el('div', totalTodayCls, fmtSigned(totalTodayPnl)),
      el('div', 'cell-sub', totalTodayPnlPct === null ? '' : fmtPct(totalTodayPnlPct)),
    ]);
  }
  $('#holdings-foot').hidden = holdings.length === 0;
  renderTrades(tradesResult);
  await backfillLatestAdvice(holdings);
  const targetStockId = routeStockId();
  const targetRow =
    targetStockId === null
      ? null
      : [...body.querySelectorAll('tr')].find((row) => row.dataset.stockId === targetStockId);
  if (targetRow !== null && targetRow !== undefined) {
    targetRow.classList.add('route-target');
    targetRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setStatus(`已定位持仓 ${targetStockId}`);
  } else if (targetStockId !== null) {
    setStatus(`当前账户未持有 ${targetStockId}`, true);
  } else {
    setStatus(`持仓已刷新 · ${holdings.length} 只`);
  }
};

const tradeRow = (trade) =>
  el('tr', null, [
    el('td', null, fmtDateTime(trade.executedAt)),
    el('td', 'mono', trade.stockId),
    el(
      'td',
      trade.side === 'buy' ? 'text-pos' : 'text-neg',
      trade.side === 'buy' ? '买入' : '卖出',
    ),
    el('td', 'num', String(trade.quantity)),
    el('td', 'num', fmtNum(trade.price)),
    el('td', null, trade.source),
  ]);

const renderTrades = (result) => {
  const body = $('#trades-body');
  const tableWrap = body?.closest('.table-wrap');
  let paginationWrap = tableWrap?.nextElementSibling;
  if (
    paginationWrap === null ||
    !(paginationWrap instanceof Element) ||
    !paginationWrap.classList.contains('pagination-wrap')
  ) {
    paginationWrap = document.createElement('div');
    paginationWrap.className = 'pagination-wrap';
    tableWrap?.after(paginationWrap);
  }
  if (!result.ok) {
    mount(body, el('tr', null, el('td', 'placeholder', `交易加载失败：${result.error.kind}`)));
    paginationWrap.replaceChildren();
    return;
  }
  const trades = result.data.trades ?? [];
  function renderPage() {
    const { page, pageSize } = pagination.getState();
    const pageItems = trades.slice((page - 1) * pageSize, page * pageSize);
    mount(body, pageItems.map(tradeRow));
  }
  const pagination = createPagination({ total: trades.length, onChange: renderPage });
  if (trades.length === 0) {
    mount(body, el('tr', null, el('td', 'placeholder', '（无交易记录）')));
    paginationWrap.replaceChildren();
    return;
  }
  renderPage();
  mount(paginationWrap, pagination.root);
};

/* ============ 持仓分析结果（内嵌展示，不再跳转建议页） ============ */

/** ToolError.kind → 用户可读文案，状态行不再裸曝英文 kind。 */
const ERROR_KIND_LABELS = {
  invalid_input: '输入无效',
  not_found: '记录不存在',
  invariant_violation: '数据校验失败',
  adapter_error: '行情或外部服务异常',
  permission_denied: '权限不足',
  llm_error: 'AI 分析服务异常',
  timeout: '请求超时',
  internal: '内部错误',
};

const errorKindLabel = (error) => {
  const kind = error?.kind;
  // 不用直接索引：普通对象原型链上有 toString 等属性，会误判未知 kind
  if (typeof kind === 'string' && Object.hasOwn(ERROR_KIND_LABELS, kind)) {
    return ERROR_KIND_LABELS[kind];
  }
  return String(kind ?? '未知错误');
};

/**
 * stockId → 最新有效 advice。
 * 两个来源：本页点「分析」产生的；进入页面时从服务端回填的（backfillLatestAdvice）。
 */
const analysisResults = new Map();

/** 正在分析中的 stockId：防按钮连点重复触发行情 + LLM 调用。 */
const analyzingStocks = new Set();

/** renderHoldings 缓存的持仓列表，「分析全部」直接复用。 */
let currentHoldings = [];

/** 进行中的批量分析句柄；非 null 用于防重入与取消。 */
let analyzeAllRun = null;

/** 最近一次批量分析的失败明细：[{ stockId, label }]。 */
let analysisFailures = [];

/** 批量分析并发上限：串行太慢，全开容易打爆行情 / LLM 限流。 */
const ANALYZE_CONCURRENCY = 3;

const renderAnalysisResults = () => {
  const box = $('#holdings-analysis');
  if (box === null) return;
  if (analysisResults.size === 0 && analysisFailures.length === 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const header = el('div', 'card-header collapsible-header', [
    el('h2', null, `持仓最新建议 · ${analysisResults.size}`),
    el('div', 'card-meta', '点击卡片展开详情 · 完整记录见「建议」页'),
  ]);
  header.addEventListener('click', () => {
    box.classList.toggle('collapsed');
  });
  const children = [header];
  if (analysisFailures.length > 0) {
    children.push(
      el(
        'p',
        'analysis-failures collapsible-content',
        `失败 ${analysisFailures.length} 只：${analysisFailures
          .map((f) => `${f.stockId}（${f.label}）`)
          .join('、')}`,
      ),
    );
  }
  children.push(
    el(
      'div',
      'advice-list collapsible-content',
      [...analysisResults.values()].map((advice) => adviceCard(advice)),
    ),
  );
  mount(box, children);
};

/* ============ 持仓行内建议 badge ============ */

const fillAdviceSlot = (slot, advice) => {
  if (advice === undefined) {
    slot.replaceChildren();
    slot.hidden = true;
    return;
  }
  const badge = decisionBadge(advice.decision);
  badge.title = `有效至 ${fmtDateTime(advice.validUntil)}`;
  mount(slot, [badge]);
  slot.hidden = false;
};

const adviceSlot = (stockId) => {
  const slot = el('span', 'holding-advice');
  slot.dataset.stockId = stockId;
  fillAdviceSlot(slot, analysisResults.get(stockId));
  return slot;
};

/** 分析完成后不重拉持仓，直接把行内 badge 与 analysisResults 对齐。 */
const updateHoldingAdviceBadges = () => {
  document.querySelectorAll('.holding-advice[data-stock-id]').forEach((slot) => {
    fillAdviceSlot(slot, analysisResults.get(slot.dataset.stockId));
  });
};

/**
 * 进入持仓页时拉服务端最新有效建议回填结果区（get_advice 默认不含已过期）。
 * 会话内刚分析出的结果更新时不覆盖；回填失败不阻塞持仓展示。
 */
const backfillLatestAdvice = async (holdings) => {
  const heldIds = new Set(holdings.map((item) => item.holding.stockId));
  // 已不在持仓里的标的建议一并清掉，保持结果区与持仓表一致
  for (const stockId of [...analysisResults.keys()]) {
    if (!heldIds.has(stockId)) analysisResults.delete(stockId);
  }
  const r = await callApi('/api/advice?subjectKind=stock&limit=200');
  if (r.ok) {
    const advices = Array.isArray(r.data?.advices) ? r.data.advices : [];
    for (const advice of advices) {
      const stockId = advice.subjectId;
      if (!heldIds.has(stockId)) continue;
      const existing = analysisResults.get(stockId);
      if (existing !== undefined && new Date(existing.createdAt) >= new Date(advice.createdAt)) {
        continue;
      }
      analysisResults.set(stockId, advice);
    }
  }
  renderAnalysisResults();
  // 行在回填前就已渲染，badge 槽需要手动对齐一次
  updateHoldingAdviceBadges();
};

/* ============ 分析动作 ============ */

const callAnalyzeStock = (stockId) =>
  callApi('/api/tools/analyze_stock/call', {
    method: 'POST',
    body: JSON.stringify({ input: { stockId } }),
  });

const runAnalyzeStock = async (stockId, setStatus, btn, { force = false } = {}) => {
  if (analyzingStocks.has(stockId)) return;
  // 已有未过期建议时先确认，避免重复产生等价 Advice；force 来自确认回调，不再重复询问
  const existing = analysisResults.get(stockId);
  if (!force && existing !== undefined && new Date(existing.validUntil).getTime() > Date.now()) {
    openConfirmModal({
      title: `重新分析 · ${stockId}`,
      message: `该股票已有有效建议（至 ${fmtDateTime(existing.validUntil)}），重新分析会再生成一条建议记录。`,
      confirmLabel: '仍然分析',
      onConfirm: () => void runAnalyzeStock(stockId, setStatus, btn, { force: true }),
    });
    return;
  }
  analyzingStocks.add(stockId);
  if (btn !== undefined) {
    btn.disabled = true;
    btn.textContent = '分析中…';
  }
  setStatus(`分析中：${stockId}`);
  try {
    const ar = await callAnalyzeStock(stockId);
    if (!ar.ok) {
      setStatus(`分析失败：${errorKindLabel(ar.error)}`, true);
      return;
    }
    analysisResults.set(stockId, ar.data.advice);
    renderAnalysisResults();
    updateHoldingAdviceBadges();
    setStatus(`${stockId} 分析完成，结果已展示在下方`);
  } finally {
    analyzingStocks.delete(stockId);
    if (btn !== undefined) {
      btn.disabled = false;
      btn.textContent = '分析';
    }
  }
};

const analyzeAllHoldings = async (setStatus) => {
  const btn = $('#btn-holdings-analyze');
  const cancelBtn = $('#btn-holdings-analyze-cancel');
  if (btn === null || analyzeAllRun !== null) return;
  btn.disabled = true;
  if (cancelBtn !== null) cancelBtn.hidden = false;
  const run = { cancelled: false };
  analyzeAllRun = run;
  try {
    let holdings = currentHoldings;
    if (holdings.length === 0) {
      const r = await callApi('/api/holdings');
      if (!r.ok) {
        setStatus(`加载失败：${errorKindLabel(r.error)}`, true);
        return;
      }
      holdings = r.data.holdings;
    }
    const stockIds = holdings.map((item) => item.holding.stockId);
    if (stockIds.length === 0) {
      setStatus('无持仓可分析');
      return;
    }
    analysisFailures = [];
    renderAnalysisResults();
    let done = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < stockIds.length && !run.cancelled) {
        const stockId = stockIds[cursor];
        cursor += 1;
        analyzingStocks.add(stockId);
        const ar = await callAnalyzeStock(stockId);
        analyzingStocks.delete(stockId);
        if (run.cancelled) break;
        done += 1;
        if (ar.ok) {
          analysisResults.set(stockId, ar.data.advice);
        } else {
          analysisFailures.push({ stockId, label: errorKindLabel(ar.error) });
        }
        // 每完成一只就增量上屏，不等整批结束
        renderAnalysisResults();
        updateHoldingAdviceBadges();
        setStatus(`分析中 ${done}/${stockIds.length}：${stockId} ${ar.ok ? '完成' : '失败'}`);
      }
    };
    const lanes = Math.min(ANALYZE_CONCURRENCY, stockIds.length);
    await Promise.all(Array.from({ length: lanes }, () => worker()));
    if (run.cancelled) {
      setStatus(
        `已取消：完成 ${done}/${stockIds.length}` +
          (analysisFailures.length > 0 ? `，失败 ${analysisFailures.length} 只` : ''),
        analysisFailures.length > 0,
      );
    } else {
      setStatus(
        analysisFailures.length === 0
          ? `分析完成：${done} 只，结果已展示在下方`
          : `分析完成：${done - analysisFailures.length} 成功 / ${analysisFailures.length} 失败`,
        analysisFailures.length > 0,
      );
    }
  } finally {
    analyzeAllRun = null;
    btn.disabled = false;
    if (cancelBtn !== null) cancelBtn.hidden = true;
  }
};

/** 取消进行中的批量分析：在跑的请求收尾，不再派发新任务。 */
const cancelAnalyzeAllHoldings = () => {
  if (analyzeAllRun !== null) analyzeAllRun.cancelled = true;
};

/* ============ watch ============ */

const HEALTH_LABELS = {
  never: '尚未运行',
  running: '正在运行',
  healthy: '运行正常',
  stale: '心跳超时',
  failed: '最近运行失败',
};

const healthLabel = (state) => HEALTH_LABELS[state] ?? state;

const setHealth = (selector, state) => {
  const node = $(selector);
  if (node !== null) node.className = `health-dot health-${state}`;
};

const runWatchOnce = async (setStatus) => {
  const button = $('#btn-dashboard-watch-run');
  if (button === null) return;
  button.disabled = true;
  setStatus('正在执行一轮 AlertPlan 评估…');
  const result = await callApi('/api/watch/run-once', {
    method: 'POST',
    body: JSON.stringify({ notify: false }),
  });
  button.disabled = false;
  if (!result.ok) {
    setStatus(`AlertPlan 评估失败：${result.error.message ?? result.error.kind}`, true);
    return;
  }
  await renderDashboard(setStatus);
  setStatus(`AlertPlan 评估完成 · ${result.data.triggers.length} 条触发`);
};
/* ============ advice ============ */

/* 建议页删除走选择模式：默认态卡片无勾选框；点头部的「删除」进入选择模式后才可选。
 * 筛选切换与路由离开必须重置（app.js 调 resetAdviceDeleteMode），防状态残留。 */
const selectedAdviceIds = new Set();
let adviceSelectMode = false;

const resetAdviceDeleteMode = () => {
  adviceSelectMode = false;
  selectedAdviceIds.clear();
  const btn = $('#btn-advice-delete-mode');
  if (btn !== null) btn.textContent = '删除';
  const bar = $('#advice-batch-bar');
  if (bar !== null) {
    bar.hidden = true;
    bar.replaceChildren();
  }
};

/** 头部「删除 / 取消」按钮：进入或退出选择模式。 */
const toggleAdviceDeleteMode = async (setStatus) => {
  if (adviceSelectMode) resetAdviceDeleteMode();
  else adviceSelectMode = true;
  await renderAdviceList(setStatus);
};

/** 删除建议（选择模式确认入口）：modal 确认 → API → 退出选择模式并刷新列表。 */
const removeAdvices = async (ids, setStatus) => {
  if (ids.length === 0) return;
  const confirmed = await confirmDialog({
    title: '删除建议',
    message: `确定删除选中的 ${ids.length} 条建议吗？删除后不可恢复，关联的 outcome 记录会一并删除。`,
    confirmLabel: `删除 ${ids.length} 条`,
    danger: true,
  });
  if (!confirmed) return;
  const r = await callApi('/api/advice/delete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
  if (!r.ok) {
    setStatus(`删除建议失败：${r.error.message ?? r.error.kind}`, true);
    return;
  }
  resetAdviceDeleteMode();
  const notFoundNote = r.data.notFound.length > 0 ? `（${r.data.notFound.length} 条已不存在）` : '';
  setStatus(`已删除 ${r.data.deleted} 条建议${notFoundNote}`);
  await renderAdviceList(setStatus);
};

const renderAdviceList = async (setStatus) => {
  const r = await callApi('/api/advice?includeExpired=true');
  const list = $('#advice-full-list');
  if (!r.ok) {
    mount(list, el('p', 'placeholder', `加载失败：${r.error.kind}`));
    setStatus(`加载失败：${r.error.kind}`, true);
    return;
  }
  const all = [...r.data.advices].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  // 剪枝：勾选集合只保留仍存在的建议（可能刚被删除）
  const existingIds = new Set(all.map((a) => a.id));
  for (const id of [...selectedAdviceIds]) {
    if (!existingIds.has(id)) selectedAdviceIds.delete(id);
  }
  const filter = $('#advice-filter')?.value ?? 'all';
  const stockId = routeStockId();
  const filtered = filterAdvices(all, filter, stockId);
  // 报告深链接（#advice?id=…）：目标建议置顶到第一页，保证渲染后可见可定位
  const targetAdviceId = routeAdviceId();
  if (targetAdviceId !== null) {
    const targetIndex = filtered.findIndex((advice) => advice.id === targetAdviceId);
    if (targetIndex > 0) filtered.unshift(...filtered.splice(targetIndex, 1));
  }
  const modeBtn = $('#btn-advice-delete-mode');
  if (modeBtn !== null) modeBtn.textContent = adviceSelectMode ? '取消' : '删除';
  let paginationWrap = list.nextElementSibling;
  if (
    paginationWrap === null ||
    !(paginationWrap instanceof Element) ||
    !paginationWrap.classList.contains('pagination-wrap')
  ) {
    paginationWrap = document.createElement('div');
    paginationWrap.className = 'pagination-wrap';
    list.after(paginationWrap);
  }
  function renderPage() {
    const { page, pageSize } = pagination.getState();
    const pageItems = filtered.slice((page - 1) * pageSize, page * pageSize);
    mount(
      list,
      pageItems.map((advice) => {
        const card = adviceCard(
          advice,
          adviceSelectMode
            ? {
                checked: selectedAdviceIds.has(advice.id),
                onToggleSelect: (id, checked) => {
                  if (checked) selectedAdviceIds.add(id);
                  else selectedAdviceIds.delete(id);
                  renderBatchBar();
                },
              }
            : {},
        );
        card.dataset.adviceId = advice.id;
        return card;
      }),
    );
  }
  const renderBatchBar = () => {
    const bar = $('#advice-batch-bar');
    if (bar === null) return;
    if (!adviceSelectMode) {
      bar.hidden = true;
      bar.replaceChildren();
      return;
    }
    const allSelected = filtered.length > 0 && filtered.every((a) => selectedAdviceIds.has(a.id));
    const toggleAll = el(
      'button',
      'btn btn-outline btn-sm',
      allSelected ? '取消全选' : `全选 ${filtered.length} 条`,
    );
    toggleAll.type = 'button';
    toggleAll.addEventListener('click', () => {
      if (allSelected) selectedAdviceIds.clear();
      else for (const a of filtered) selectedAdviceIds.add(a.id);
      renderPage();
      renderBatchBar();
    });
    const confirmDelete = el('button', 'btn btn-danger btn-sm', '确认删除');
    confirmDelete.type = 'button';
    confirmDelete.disabled = selectedAdviceIds.size === 0;
    confirmDelete.addEventListener(
      'click',
      () => void removeAdvices([...selectedAdviceIds], setStatus),
    );
    mount(bar, [
      el('span', 'batch-bar-info', `已选 ${selectedAdviceIds.size} 条`),
      toggleAll,
      confirmDelete,
    ]);
    bar.hidden = false;
  };
  const pagination = createPagination({ total: filtered.length, onChange: renderPage });
  if (filtered.length === 0) {
    mount(
      list,
      el(
        'p',
        'placeholder',
        stockId === null
          ? filter === 'all'
            ? '（暂无建议）'
            : `（无 ${filter} 类建议）`
          : `（${stockId} 暂无匹配建议）`,
      ),
    );
    paginationWrap.replaceChildren();
  } else {
    renderPage();
    mount(paginationWrap, pagination.root);
    // 深链接目标：标记 + 滚动定位（与持仓页 route-target 同一视觉语言）
    if (targetAdviceId !== null) {
      const targetCard = list.querySelector(
        `.advice-card[data-advice-id="${CSS.escape(targetAdviceId)}"]`,
      );
      if (targetCard !== null) {
        targetCard.classList.add('route-target');
        targetCard.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }
  renderBatchBar();
  setStatus(
    stockId === null
      ? `建议已刷新 · ${filtered.length} / ${all.length} 条`
      : `${stockId} · ${filtered.length} 条建议`,
  );
};

/* ============ reports ============ */

const REPORT_KIND_LABEL = {
  opening: '开盘简报',
  closing: '收盘复盘',
  weekly: '周报',
};

let selectedReportId = null;
let reportPollTimer = null;
let reportRunBound = false;

const reportStatusBadge = (status) =>
  el(
    'span',
    `badge ${status === 'partial' ? 'badge-warn' : 'badge-fresh'}`,
    status === 'partial' ? '部分可用' : '完整',
  );

const reportEntityHref = (item) => {
  if (item.entityKind === 'stock') return buildMarketLink(item.entityId);
  if (item.entityKind === 'stock-group' || item.entityKind === 'watch-plan') return '#groups';
  if (item.entityKind === 'advice') return `#advice?id=${encodeURIComponent(item.entityId)}`;
  if (item.entityKind === 'research-note' || item.entityKind === 'stock-event') return '#research';
  return null;
};

const reportBlockNode = (block) => {
  if (block.kind === 'text') {
    return el('p', block.tone === 'warning' ? 'report-warning' : 'report-prose', block.text);
  }
  if (block.kind === 'metrics') {
    return el(
      'div',
      'report-metrics',
      block.items.map((item) => {
        const text =
          item.displayValue ??
          (item.value === null || item.value === undefined
            ? '不可用'
            : item.unit === 'ratio' && typeof item.value === 'number'
              ? fmtPct(item.value, 1)
              : `${item.value}${item.unit ?? ''}`);
        return el('div', 'report-metric', [
          el('span', 'report-metric-label', item.label),
          el('strong', 'report-metric-value', text),
        ]);
      }),
    );
  }
  if (block.kind === 'list') {
    return el(
      'ul',
      'report-list',
      block.items.map((item) => {
        const href = reportEntityHref(item);
        const title =
          href === null
            ? el('strong', null, item.title)
            : Object.assign(el('a', 'stock-link', item.title), { href });
        return el('li', null, [
          title,
          item.detail === undefined ? '' : el('span', 'muted', ` — ${item.detail}`),
        ]);
      }),
    );
  }
  const table = el('table', 'report-table');
  table.append(
    el(
      'thead',
      null,
      el(
        'tr',
        null,
        block.columns.map((column) => el('th', null, column.label)),
      ),
    ),
  );
  table.append(
    el(
      'tbody',
      null,
      block.rows.map((row) =>
        el(
          'tr',
          null,
          block.columns.map((column) =>
            el('td', null, row[column.key] === null ? '不可用' : String(row[column.key] ?? '—')),
          ),
        ),
      ),
    ),
  );
  return el('div', 'report-table-wrap', table);
};

/**
 * 报告 sheet 通用渲染（报告页详情与首页共用）：header + sections + provenance。
 * actions 为右上角操作区节点（报告页传导出/删除按钮；首页只传状态 badge）。
 */
const reportSheetNodes = (report, actions = []) => {
  const nodes = [
    el('header', 'report-sheet-header', [
      el('div', null, [
        el('span', 'section-kicker', REPORT_KIND_LABEL[report.kind] ?? report.kind),
        el('h2', null, report.title),
        el(
          'p',
          'report-period',
          `${report.periodStart}${report.periodStart === report.periodEnd ? '' : ` — ${report.periodEnd}`}`,
        ),
      ]),
      el('div', 'report-sheet-actions', actions),
    ]),
    el('div', 'report-asof', [
      el('span', null, `DATA AS OF ${fmtDateTime(report.dataAsOf)}`),
      el('span', null, `GENERATED ${fmtDateTime(report.generatedAt)}`),
    ]),
  ];
  for (const section of report.sections) {
    const sectionNode = el('section', `report-section report-section-${section.status}`, [
      el('div', 'report-section-head', [
        el('div', null, [
          el('span', 'report-section-key', section.key),
          el('h3', null, section.title),
        ]),
        el(
          'span',
          `badge ${section.status === 'complete' ? 'badge-fresh' : 'badge-warn'}`,
          section.status,
        ),
      ]),
      ...section.blocks.map(reportBlockNode),
      ...section.missingDimensions.map((missing) =>
        el(
          'div',
          'report-missing',
          `${missing.dimension} · ${missing.reason}${missing.retryable ? ' · 可重试' : ''}`,
        ),
      ),
    ]);
    nodes.push(sectionNode);
  }
  if (report.evidence.length > 0) {
    nodes.push(
      el('details', 'report-provenance', [
        el('summary', null, [
          el('span', 'section-kicker', 'PROVENANCE'),
          el('h3', null, `数据来源（${report.evidence.length}）`),
        ]),
        ...report.evidence.map((evidence) =>
          el('div', 'report-source-row', [
            el('strong', null, evidence.dimension),
            el('span', null, evidence.provenance.provider),
            el('span', 'muted', evidence.provenance.freshness),
            el('time', null, fmtDateTime(evidence.provenance.observedAt)),
          ]),
        ),
      ]),
    );
  }
  return nodes;
};

/**
 * 首页 = 最新收盘报告（PRD strategy-ai-managed-automation §4.1/§5）。
 * 复用 list_reports + get_report，不新增绕过 tools 的端点；
 * 空库 / 无收盘报告时给诚实空态与生成路径说明。
 */
const renderHome = async (setStatus) => {
  const container = $('#home-report');
  if (container === null) return;
  const result = await callApi('/api/reports?kind=closing&limit=1');
  if (!result.ok) {
    mount(container, el('p', 'placeholder', `收盘报告加载失败：${result.error.kind}`));
    setStatus(`收盘报告加载失败：${result.error.kind}`, true);
    return;
  }
  const latest = (result.data.reports ?? [])[0];
  if (latest === undefined) {
    const toReports = el('a', 'btn btn-outline btn-sm', '去「报告」页生成');
    toReports.setAttribute('href', '#reports');
    mount(
      container,
      el('div', 'report-empty', [
        el('span', 'report-empty-mark', 'R'),
        el('h2', null, '尚无收盘报告'),
        el(
          'p',
          null,
          '收盘报告在每日收盘后的策略日循环中自动生成；也可以到「报告」页选择交易日手动生成一份。',
        ),
        toReports,
      ]),
    );
    setStatus('尚无收盘报告');
    return;
  }
  const detail = await callApi(`/api/reports/${latest.id}`);
  if (!detail.ok) {
    mount(container, el('p', 'placeholder', `收盘报告加载失败：${detail.error.kind}`));
    setStatus(`收盘报告加载失败：${detail.error.kind}`, true);
    return;
  }
  const report = detail.data.report;
  mount(container, reportSheetNodes(report, [reportStatusBadge(report.status)]));
  setStatus(`最新收盘报告 · ${report.periodEnd}`);
};

const downloadReport = async (reportId, format) => {
  const result = await callApi(`/api/reports/${reportId}/render?format=${format}`);
  if (!result.ok) return;
  const blob = new Blob([result.data.content], { type: result.data.contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${reportId}.${format === 'markdown' ? 'md' : 'txt'}`;
  anchor.click();
  URL.revokeObjectURL(url);
};

const deleteReport = async (reportId, setStatus) => {
  const result = await callApi(`/api/reports/${reportId}`, { method: 'DELETE', body: '{}' });
  if (!result.ok) {
    setStatus(`报告删除失败：${result.error.kind}`, true);
    return;
  }
  selectedReportId = null;
  await renderReports(setStatus);
};

const loadReportDetail = async (reportId, setStatus) => {
  selectedReportId = reportId;
  const result = await callApi(`/api/reports/${reportId}`);
  if (!result.ok) {
    setStatus(`报告加载失败：${result.error.kind}`, true);
    return;
  }
  const report = result.data.report;
  const detail = $('#report-detail');
  const markdown = el('button', 'btn btn-outline btn-sm', '导出 Markdown');
  const plain = el('button', 'btn btn-outline btn-sm', '导出纯文本');
  const remove = el('button', 'btn btn-outline btn-sm', '删除');
  markdown.type = 'button';
  plain.type = 'button';
  remove.type = 'button';
  markdown.addEventListener('click', () => void downloadReport(report.id, 'markdown'));
  plain.addEventListener('click', () => void downloadReport(report.id, 'plain-text'));
  remove.addEventListener('click', () => {
    openConfirmModal({
      title: '删除报告',
      message: `确定删除「${report.title}」？删除后不可恢复。`,
      confirmLabel: '删除',
      onConfirm: () => void deleteReport(report.id, setStatus),
    });
  });

  mount(
    detail,
    reportSheetNodes(report, [reportStatusBadge(report.status), markdown, plain, remove]),
  );
  document.querySelectorAll('.report-history-item').forEach((node) => {
    node.classList.toggle('active', node.dataset.reportId === reportId);
  });
};

const renderReports = async (setStatus) => {
  const dateInput = $('#report-run-date');
  if (dateInput !== null && dateInput.value.length === 0) {
    dateInput.value = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }
  if (!reportRunBound) {
    reportRunBound = true;
    document.querySelectorAll('[data-report-run]').forEach((button) => {
      button.addEventListener('click', async () => {
        const kind = button.dataset.reportRun;
        const date = $('#report-run-date')?.value;
        const state = $('#report-run-state');
        if (kind === undefined || date === undefined || date.length === 0 || state === null) return;
        state.textContent = '生成中…';
        button.disabled = true;
        const generated = await callApi(`/api/reports/run/${kind}`, {
          method: 'POST',
          body: JSON.stringify({ date, notify: false }),
        });
        button.disabled = false;
        if (!generated.ok) {
          state.textContent = `失败 · ${generated.error.kind}`;
          setStatus(`报告生成失败：${generated.error.kind}`, true);
          return;
        }
        selectedReportId = generated.data.report.id;
        state.textContent =
          generated.data.report.status === 'partial' ? '已生成 · 部分可用' : '已生成 · 完整';
        await renderReports(setStatus);
      });
    });
  }
  const kind = $('#report-kind-filter')?.value ?? '';
  const status = $('#report-status-filter')?.value ?? '';
  const params = new URLSearchParams({ limit: '30' });
  if (kind.length > 0) params.set('kind', kind);
  if (status.length > 0) params.set('status', status);
  const result = await callApi(`/api/reports?${params.toString()}`);
  if (!result.ok) {
    setStatus(`报告历史加载失败：${result.error.kind}`, true);
    return;
  }
  const reports = result.data.reports ?? [];
  $('#report-history-meta').textContent = `${reports.length} 份`;
  const history = $('#report-history');
  if (reports.length === 0) {
    mount(history, el('p', 'placeholder', '暂无报告；报告 workflow 接入后会在这里形成历史。'));
    // 删除最后一份报告后详情区同步清空，避免展示已删除内容
    selectedReportId = null;
    mount($('#report-detail'), el('p', 'placeholder', '暂无报告。'));
  } else {
    mount(
      history,
      reports.map((report) => {
        const button = el('button', 'report-history-item', [
          el('span', 'report-history-kind', REPORT_KIND_LABEL[report.kind] ?? report.kind),
          el('strong', null, report.title),
          el('span', 'report-history-period', report.periodEnd),
          reportStatusBadge(report.status),
          el('span', 'report-history-asof', `截至 ${fmtDateTime(report.dataAsOf)}`),
        ]);
        button.type = 'button';
        button.dataset.reportId = report.id;
        button.addEventListener('click', () => void loadReportDetail(report.id, setStatus));
        return button;
      }),
    );
    const nextId =
      reports.some((report) => report.id === selectedReportId) && selectedReportId !== null
        ? selectedReportId
        : reports[0].id;
    await loadReportDetail(nextId, setStatus);
  }
  for (const id of ['report-kind-filter', 'report-status-filter']) {
    const select = $(`#${id}`);
    if (select !== null && select.dataset.bound !== 'true') {
      select.dataset.bound = 'true';
      select.addEventListener('change', () => void renderReports(setStatus));
    }
  }
  if (reportPollTimer === null) {
    reportPollTimer = setInterval(() => {
      if (window.location.hash.startsWith('#reports')) void renderReports(setStatus);
    }, 60_000);
  }
};

/* ============ review ============ */

const formatPercentPoints = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)}%` : '--';

const toDateInputValue = (date) => date.toISOString().slice(0, 10);

const renderAccountPerformanceAudit = async (accountId, from, to) => {
  const base =
    accountId.length > 0 ? `/api/accounts/${accountId}/performance` : '/api/account/performance';
  const [snapshotsResult, auditResult] = await Promise.all([
    callApi(`${base}/snapshots?limit=30`),
    callApi(`${base}/snapshot-audit?from=${from}&to=${to}&limit=200`),
  ]);
  const meta = $('#review-performance-audit-meta');
  const snapshotsBody = $('#review-performance-snapshots-table tbody');
  const auditBody = $('#review-performance-audit-table tbody');
  if (!snapshotsResult.ok || !auditResult.ok) {
    if (meta !== null) {
      meta.textContent = `审计加载失败：${snapshotsResult.error?.kind ?? auditResult.error?.kind ?? 'unknown'}`;
    }
    if (snapshotsBody !== null) {
      snapshotsBody.innerHTML = '<tr><td colspan="6" class="placeholder">暂无快照审计</td></tr>';
    }
    if (auditBody !== null) {
      auditBody.innerHTML = '<tr><td colspan="5" class="placeholder">暂无区间审计</td></tr>';
    }
    return;
  }

  const snapshots = snapshotsResult.data.snapshots ?? [];
  const audit = auditResult.data.audit;
  if (meta !== null) {
    meta.textContent = `${snapshots.length} 个版本 · ${audit.observedTradingDays}/${audit.expectedTradingDays} 个交易日 · ${audit.revisionDayCount} 日有修订 · ${audit.gaps.length} 个缺口`;
  }
  if (snapshotsBody !== null) {
    mount(
      snapshotsBody,
      snapshots.length === 0
        ? el('tr', null, el('td', { colSpan: 6, class: 'placeholder' }, '尚无持久化快照'))
        : snapshots.map((snapshot) => {
            const facts = snapshot.inputFacts;
            const budget =
              facts === undefined
                ? '--'
                : `${facts.priceSeries} 序列 / ${facts.dailyBars + facts.benchmarkBars} bars / ${Math.round(snapshot.calculationDurationMs ?? 0)}ms`;
            return el('tr', null, [
              el('td', null, fmtDateTime(snapshot.calculatedAt)),
              el(
                'td',
                null,
                `${String(snapshot.from).slice(0, 10)} → ${String(snapshot.to).slice(0, 10)}`,
              ),
              el('td', null, `${snapshot.completeness} / ${snapshot.benchmarkStatus}`),
              el(
                'td',
                null,
                snapshot.dataAsOf === undefined ? '--' : String(snapshot.dataAsOf).slice(0, 10),
              ),
              el('td', 'audit-fingerprint', snapshot.inputFingerprint.slice(0, 12)),
              el('td', null, budget),
            ]);
          }),
    );
  }
  if (auditBody !== null) {
    mount(
      auditBody,
      audit.days.length === 0
        ? el('tr', null, el('td', { colSpan: 5, class: 'placeholder' }, '区间内没有 A 股交易日'))
        : [...audit.days].reverse().map((day) => {
            const issue =
              day.missingStockIds.length > 0
                ? day.missingStockIds.join(', ')
                : (day.warnings[0] ?? '--');
            return el('tr', null, [
              el('td', null, day.date),
              el('td', `audit-status-${day.completeness}`, day.completeness),
              el('td', null, day.completeness === 'complete' ? '--' : issue),
              el('td', null, `${day.revisionCount} 版`),
              el('td', 'audit-fingerprint', day.snapshotId?.slice(0, 12) ?? '--'),
            ]);
          }),
    );
  }
};

const renderAccountPerformance = async () => {
  const fromNode = $('#review-performance-from');
  const toNode = $('#review-performance-to');
  if (fromNode === null || toNode === null) return;
  const now = new Date();
  if (fromNode.value === '') {
    fromNode.value = toDateInputValue(new Date(now.getTime() - 30 * 86_400_000));
  }
  if (toNode.value === '') toNode.value = toDateInputValue(now);
  const accountId = getAccountId();
  const path =
    accountId.length > 0 ? `/api/accounts/${accountId}/performance` : '/api/account/performance';
  const result = await callApi(`${path}?from=${fromNode.value}&to=${toNode.value}`);
  const meta = $('#review-performance-meta');
  if (!result.ok) {
    if (meta !== null) meta.textContent = `加载失败：${result.error?.kind ?? 'unknown'}`;
    const tbody = $('#review-performance-table tbody');
    if (tbody !== null)
      tbody.innerHTML = '<tr><td colspan="6" class="placeholder">暂无可用估值</td></tr>';
    await renderAccountPerformanceAudit(accountId, fromNode.value, toNode.value);
    return;
  }
  const performance = result.data;
  if (meta !== null) {
    const completeness =
      performance.completeness === 'complete' ? '完整' : `部分（${performance.completeness}）`;
    const audit = performance.audit;
    const auditText =
      audit?.snapshotId === undefined
        ? '无审计快照'
        : `snapshot ${audit.snapshotId.slice(0, 18)}…${
            audit.dataAsOf === undefined ? '' : ` · dataAsOf ${String(audit.dataAsOf).slice(0, 10)}`
          }`;
    const benchmarkLabel = performance.benchmarkStockId ?? '未配置';
    meta.textContent = `${completeness} · benchmark ${benchmarkLabel} ${performance.benchmarkStatus ?? 'unavailable'} · ${auditText}`;
  }
  mount($('#review-performance-stats'), [
    statBlock('TWR', formatPercentPoints(performance.twrPct)),
    statBlock('最大回撤', formatPercentPoints(performance.maxDrawdownPct)),
    statBlock('基准 TWR', formatPercentPoints(performance.benchmarkTwrPct)),
    statBlock('超额收益', formatPercentPoints(performance.excessTwrPct)),
    statBlock('已实现 PnL', fmtSigned(performance.realizedPnl)),
    statBlock('总 PnL', fmtSigned(performance.totalPnl)),
  ]);
  const rows = Array.isArray(performance.valuation) ? [...performance.valuation].reverse() : [];
  const tbody = $('#review-performance-table tbody');
  if (tbody !== null) {
    mount(
      tbody,
      rows.length === 0
        ? el('tr', null, el('td', { colSpan: 6, class: 'placeholder' }, '区间内没有交易日估值'))
        : rows.map((day) =>
            el('tr', null, [
              el('td', null, String(day.date).slice(0, 10)),
              el('td', null, fmtNum(day.totalValue)),
              el('td', null, fmtSigned(day.externalCashFlow)),
              el('td', null, formatPercentPoints(day.twrReturnPct)),
              el('td', null, formatPercentPoints(day.drawdownPct)),
              el(
                'td',
                null,
                day.completeness === 'complete'
                  ? '完整'
                  : day.missingStockIds?.join(', ') || day.completeness,
              ),
            ]),
          ),
    );
  }
  await renderAccountPerformanceAudit(accountId, fromNode.value, toNode.value);
};

const renderTrend = (data) => {
  const box = $('#review-trend');
  if (!Array.isArray(data) || data.length < 2) {
    box.innerHTML = '';
    mount(
      box,
      el(
        'div',
        { class: 'muted', style: { textAlign: 'center', paddingTop: '60px' } },
        '样本不足 2 个时间窗，暂不绘制趋势图。',
      ),
    );
    return;
  }
  const w = box.clientWidth || 600;
  const h = 160;
  const pad = 32;
  const xs = data.map((_, i) => pad + (i * (w - 2 * pad)) / (data.length - 1));
  const ys = data.map((d) => h - pad - (d.hitRate ?? 0) * (h - 2 * pad));
  const line = data
    .map((_, i) => `${i === 0 ? 'M' : 'L'} ${xs[i].toFixed(1)} ${ys[i].toFixed(1)}`)
    .join(' ');
  const dots = data
    .map(
      (d, i) =>
        `<circle cx="${xs[i].toFixed(1)}" cy="${ys[i].toFixed(1)}" r="3" fill="var(--accent)" />` +
        `<text x="${xs[i].toFixed(1)}" y="${(ys[i] - 8).toFixed(1)}" text-anchor="middle" ` +
        `font-size="10" fill="var(--ink-soft)">${((d.hitRate ?? 0) * 100).toFixed(0)}%</text>`,
    )
    .join('');
  const xLabels = data
    .map((d, i) => {
      const label = d.date ?? d.label ?? String(i);
      return `<text x="${xs[i].toFixed(1)}" y="${(h - pad + 14).toFixed(1)}" text-anchor="middle" font-size="9" fill="var(--muted)">${label}</text>`;
    })
    .join('');
  const svg = `
    <svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
      <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${h - pad}" stroke="var(--line)" />
      <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="var(--line)" />
      <text x="${pad - 4}" y="${pad + 4}" text-anchor="end" font-size="10" fill="var(--muted)">100%</text>
      <text x="${pad - 4}" y="${h - pad}" text-anchor="end" font-size="10" fill="var(--muted)">0%</text>
      <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" />
      ${dots}
      ${xLabels}
    </svg>
  `;
  box.innerHTML = svg;
};

const renderDecisionLoopSummary = async () => {
  const root = $('#review-decision-loop-content');
  if (root === null) return;
  const result = await callApi('/api/review/decision-loop');
  if (!result.ok) {
    mount(root, el('p', 'status error', `闭环摘要加载失败：${result.error?.kind ?? 'unknown'}`));
    return;
  }
  const review = result.data;
  const advice = review.advice;
  const trades = review.trades;
  const observations = review.signalObservations;
  const horizonStats = new Map((observations.stats ?? []).map((item) => [item.horizon, item]));
  const horizonRows = ['t1', 't3', 't5'].map((horizon) => {
    const item = horizonStats.get(horizon);
    const sample = item?.total ?? 0;
    return el('tr', null, [
      el('td', 'mono', horizon.toUpperCase()),
      el('td', null, item === undefined ? '暂无样本' : `${item.complete}/${sample}`),
      el(
        'td',
        null,
        item === undefined ? '--' : `${item.pending} 待观察 · ${item.unavailable} 不可用`,
      ),
      el('td', null, sample === 0 ? '--' : fmtPct(item.missingRate)),
      el('td', null, item?.benchmarkStatus === 'complete' ? '可用' : '不可用 / 未知'),
      el('td', null, item?.observedAsOf === undefined ? '--' : fmtDateTime(item.observedAsOf)),
    ]);
  });
  const attributionRate = decisionLoopAttributionRate(trades);
  mount(root, [
    el('div', 'strategy-review-loop-metrics', [
      statBlock('Advice 已回填', String(advice.backfilled)),
      statBlock('Advice 待回填', String(advice.pending)),
      statBlock(
        'Trade 显式归因率',
        attributionRate === null ? '--' : fmtPct(attributionRate),
        trades.total === 0
          ? '暂无交易样本'
          : `${trades.total - trades.unattributed} / ${trades.total} 笔`,
      ),
      statBlock('Trade 未归因', trades.total === 0 ? '--' : String(trades.unattributed)),
      statBlock(
        '观察事实',
        observations.total === 0 ? '--' : String(observations.total),
        observations.total === 0
          ? '暂无观察样本'
          : `${observations.complete} 完整 · ${observations.pending} 待观察 · ${observations.unavailable} 不可用`,
      ),
      statBlock('数据截止', fmtDateTime(review.dataAsOf)),
    ]),
    el('div', 'table-wrap', [
      el('table', 'table', [
        el(
          'thead',
          null,
          el(
            'tr',
            null,
            ['Horizon', '完整 / 样本', '待观察 / 不可用', '缺失率', 'Benchmark', '观察截止'].map(
              (label) => el('th', null, label),
            ),
          ),
        ),
        el('tbody', null, horizonRows),
      ]),
    ]),
    el('div', 'strategy-review-loop-columns', [
      el('section', null, [
        el('h3', null, '研究假设版本引用'),
        ...(review.researchHypothesisVersions?.length
          ? review.researchHypothesisVersions.map((version) =>
              el(
                'p',
                'mono muted',
                `${version.id} · v${version.version} · ${version.summary ?? '无摘要'}`,
              ),
            )
          : [el('p', 'placeholder', '暂无研究假设版本引用。')]),
      ]),
      el('section', null, [
        el('h3', null, '审计边界'),
        el('p', 'mono muted', `Evidence IDs：${review.evidenceIds?.join('、') || '无'}`),
        ...(review.unknowns?.length
          ? [el('p', 'status warning', `Unknown：${review.unknowns.join('；')}`)]
          : []),
        ...(review.limitations?.length
          ? [el('p', 'muted', `限制：${review.limitations.join('；')}`)]
          : []),
      ]),
    ]),
  ]);
};

const renderReview = async (setStatus) => {
  const [r, calR] = await Promise.all([callApi('/api/review'), callApi('/api/review/calibration')]);
  if (!r.ok) {
    setStatus(`加载失败：${r.error.kind}`, true);
    return;
  }
  const stats = r.data.stats;
  const outcomeSamples = calR.ok ? calR.data.totalWithOutcome : 0;
  const grid = $('#review-stats-grid');
  mount(grid, [
    statBlock('总条数', String(stats.totalAdvices)),
    statBlock('平均信心度', stats.avgConfidence.toFixed(1)),
    statBlock('命中率', calibrationRateText(stats.hitRate, outcomeSamples)),
    statBlock(
      '跟单盈亏',
      calibrationPnlText(stats.pnlWhenFollowed, outcomeSamples),
      outcomeSamples === 0
        ? ''
        : stats.pnlWhenFollowed > 0
          ? 'pos'
          : stats.pnlWhenFollowed < 0
            ? 'neg'
            : '',
    ),
    statBlock(
      '忽略盈亏',
      calibrationPnlText(stats.pnlWhenIgnored, outcomeSamples),
      outcomeSamples === 0
        ? ''
        : stats.pnlWhenIgnored > 0
          ? 'pos'
          : stats.pnlWhenIgnored < 0
            ? 'neg'
            : '',
    ),
    statBlock(
      'follow 占比',
      calibrationRateText(stats.outcomeRate.followed, outcomeSamples),
      outcomeSamples === 0
        ? '尚无 outcome 样本'
        : `${fmtPct(stats.outcomeRate.partiallyFollowed)} 部分 / ${fmtPct(stats.outcomeRate.ignored)} 忽略`,
    ),
  ]);
  $('#review-stats-meta').textContent = `${stats.totalAdvices} 条（含已过期）`;
  await renderDecisionLoopSummary();

  // ====== W4 confidence 自校准表 ======
  if (calR.ok) {
    const cal = calR.data;
    $('#review-calibration-meta').textContent =
      `${cal.totalAdvices} 条 / ${cal.totalWithOutcome} 已回填 · 整体命中率 ${calibrationRateText(cal.overallHitRate, cal.totalWithOutcome)}`;
    const tbody = $('#review-calibration-table tbody');
    tbody.innerHTML = cal.buckets
      .map((b) => {
        const hitColor =
          b.withOutcome === 0 ? '' : b.hitRate >= 0.7 ? 'pos' : b.hitRate <= 0.3 ? 'neg' : 'warn';
        const pnlClass =
          b.withOutcome === 0 ? '' : b.avgPnl > 0 ? 'pos' : b.avgPnl < 0 ? 'neg' : '';
        return (
          `<tr>` +
          `<td>${b.range.min}-${b.range.max}</td>` +
          `<td>${b.total}</td>` +
          `<td>${b.withOutcome}</td>` +
          `<td>${b.hits}</td>` +
          `<td class="${hitColor}">${calibrationRateText(b.hitRate, b.withOutcome)}</td>` +
          `<td class="${pnlClass}">${calibrationPnlText(b.avgPnl, b.withOutcome)}</td>` +
          `<td>${b.avgConfidence.toFixed(1)}</td>` +
          `</tr>`
        );
      })
      .join('');
  } else {
    $('#review-calibration-meta').textContent = `加载校准失败：${calR.error.kind ?? ''}`;
  }

  // 趋势图：当前接口按决策维度聚合，保持事实口径，不创建演示数据。
  const decisionData = (outcomeSamples === 0 ? [] : Object.entries(stats.byDecision ?? {}))
    .filter(([, s]) => s.totalAdvices > 0)
    .map(([decision, s]) => ({ label: decision, hitRate: s.hitRate }));
  renderTrend(decisionData);

  const performanceRefresh = $('#btn-review-performance-refresh');
  if (performanceRefresh !== null && performanceRefresh.dataset.bound !== 'true') {
    performanceRefresh.dataset.bound = 'true';
    performanceRefresh.addEventListener('click', () => void renderAccountPerformance());
  }
  await renderAccountPerformance();

  // 列表 + outcome 回填按钮
  const advices = r.data.advices.advices ?? [];
  const list = $('#review-list');
  if (advices.length === 0) {
    mount(list, el('p', 'placeholder', '（暂无建议）'));
  } else {
    mount(
      list,
      advices.map((a) => {
        const code = String(a.subjectId).split('.')[0] || a.subjectId;
        const li = el('div', 'advice-card');
        const status = a.outcome === undefined ? '（待回填）' : a.outcome.outcome;
        const pnlText = a.outcome?.pnl !== undefined ? `  盈亏 ${fmtSigned(a.outcome.pnl)}` : '';
        const outcomeMeta =
          a.outcome === undefined
            ? []
            : [
                ...(a.outcome.benchmarkPnl === undefined
                  ? []
                  : [`基准 ${fmtSigned(a.outcome.benchmarkPnl)}`]),
                ...(a.outcome.holdingHours === undefined
                  ? []
                  : [`持有 ${a.outcome.holdingHours}h`]),
                ...(Array.isArray(a.outcome.tradeIds) && a.outcome.tradeIds.length > 0
                  ? [`交易 ${a.outcome.tradeIds.join(',')}`]
                  : []),
              ];
        li.append(
          el('div', 'row-1', [
            el('div', 'subject', [el('span', 'code', code), a.subjectId]),
            el('span', 'badge', `${a.decision} · 信心 ${a.confidence}%`),
          ]),
        );
        li.append(el('p', 'premise', a.reasoning?.premise ?? ''));
        const row2 = el('div', 'row-2', [
          `${status}${pnlText}`,
          ...outcomeMeta,
          `有效至 ${fmtDateTime(a.validUntil)}`,
        ]);
        li.append(row2);
        if (a.outcome === undefined) {
          const btn = el('button', 'btn btn-outline btn-sm', '回填 outcome');
          btn.type = 'button';
          btn.addEventListener('click', (event) => {
            event.stopPropagation();
            fillOutcomeForm(a.id, a.decision);
          });
          li.append(btn);
        }
        return li;
      }),
    );
  }
  setStatus('复盘已刷新');
};

const outcomeInputOf = (values) => {
  const optionalNumber = (value) => {
    const text = String(value ?? '').trim();
    if (text.length === 0) return undefined;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const pnl = optionalNumber(values.pnl);
  const benchmarkPnl = optionalNumber(values.benchmarkPnl);
  const holdingHours = optionalNumber(values.holdingHours);
  const tradeIds = String(values.tradeIds ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return {
    outcome: values.outcome,
    ...(pnl === undefined ? {} : { pnl }),
    ...(benchmarkPnl === undefined ? {} : { benchmarkPnl }),
    ...(holdingHours === undefined ? {} : { holdingHours }),
    ...(tradeIds.length > 0 ? { tradeIds } : {}),
    ...(String(values.notes ?? '').length > 0 ? { notes: values.notes } : {}),
  };
};

const fillOutcomeForm = async (adviceId, decision) => {
  const values = await promptDialog({
    title: `回填 outcome（${adviceId.slice(0, 8)} · 决策 ${decision}）`,
    fields: [
      {
        key: 'outcome',
        label: '执行情况',
        value: 'followed',
        options: [
          { value: 'followed', label: '跟随' },
          { value: 'partially_followed', label: '部分跟随' },
          { value: 'ignored', label: '忽略' },
        ],
      },
      {
        key: 'pnl',
        label: '实际盈亏（人民币，可负）',
        placeholder: '未知或未平仓时留空',
      },
      { key: 'benchmarkPnl', label: '同期基准盈亏（可选）', placeholder: '选填' },
      { key: 'holdingHours', label: '持有时长（小时，可选）', placeholder: '选填' },
      {
        key: 'tradeIds',
        label: '关联交易 ID（可选，逗号分隔）',
        placeholder: '例如 trade-1,trade-2',
      },
      { key: 'notes', label: '备注（可选）', placeholder: '选填' },
    ],
    confirmLabel: '回填',
  });
  if (values === null) return;
  const r = await callApi(`/api/review/${adviceId}/outcome`, {
    method: 'POST',
    body: JSON.stringify({
      input: outcomeInputOf(values),
    }),
  });
  if (r.ok) {
    setStatus(`outcome 已回填 ${adviceId.slice(0, 8)}`);
    await renderReview(setStatus);
  } else {
    setStatus(
      `回填失败：${r.error.kind}${r.error.message !== undefined ? `（${r.error.message}）` : ''}`,
      true,
    );
  }
};

/* ============ settings ============ */

const renderSettings = (setStatus) => {
  setStatus('设置已加载');
};

const bindSettingsActions = () => {
  const createBtn = $('#btn-account-create');
  if (createBtn !== null) {
    createBtn.addEventListener('click', async () => {
      const name = $('#account-create-name').value.trim();
      const currency = $('#account-create-currency').value.trim().toUpperCase();
      const initialCapital = Number($('#account-create-capital').value);
      if (
        name.length === 0 ||
        currency.length !== 3 ||
        !Number.isFinite(initialCapital) ||
        initialCapital < 0
      ) {
        await alertDialog('无法创建账户', '请填写账户名称、3 位币种代码和非负初始资金。');
        return;
      }
      createBtn.disabled = true;
      const created = await callApi('/api/tools/create_account/call', {
        method: 'POST',
        body: JSON.stringify({ input: { name, currency, initialCapital } }),
      });
      if (!created.ok) {
        createBtn.disabled = false;
        await alertDialog('创建失败', `${created.error?.kind ?? 'unknown'}。`);
        return;
      }
      const accountId = created.data.account.id;
      const selected = await callApi('/api/account/select', {
        method: 'POST',
        body: JSON.stringify({ accountId }),
      });
      if (!selected.ok) {
        createBtn.disabled = false;
        // v0.8 起：把 error.cause 一并提示（zod issues / SQL 异常都藏在这里），
        // 否则只看 kind='internal' 永远定不到根因。
        const e = selected.error ?? {};
        const detail = e.cause ? `（${e.cause}）` : '';
        await alertDialog('激活失败', `账户已创建，但激活失败：${e.kind ?? 'unknown'}${detail}`);
        return;
      }
      window.__luoome.setAccountId(accountId);
      window.location.hash = '#holdings';
      window.location.reload();
    });
  }
};

const renderSettingsAccount = async () => {
  const box = $('#settings-account');
  if (box === null) return;
  const r = await callApi('/api/holdings');
  if (!r.ok) {
    const message =
      r.error.kind === 'not_found'
        ? '尚未创建账户，请使用上方表单初始化真实账户。'
        : `加载失败：${r.error.kind}`;
    mount(box, el('p', 'placeholder', message));
    return;
  }
  mount(
    box,
    el('div', null, [
      el('p', null, `状态：${r.data.status}`),
      el('p', null, `持仓数：${r.data.holdings.length}`),
      el('p', null, `总市值：${fmtNum(r.data.totalValue)}`),
      el('p', null, `总盈亏：${fmtSigned(r.data.totalPnL)}（${fmtPct(r.data.totalPnLPct)}）`),
    ]),
  );
};

/* ============================================================
 * ruo 迁移：研究页 + 数据健康 + workflow 运行记录
 * （docs/ddd/ruo-feature-migration-detailed-design.md §8）
 * ============================================================ */

/** 新鲜度 → 中文文案 + 颜色类（PRD §6.3）。 */
const FRESHNESS_LABEL = {
  fresh: { label: '新鲜', cls: 'badge-fresh' },
  stale: { label: '过期', cls: 'badge-stale' },
  unknown: { label: '未知', cls: 'badge-unknown' },
  unavailable: { label: '不可用', cls: 'badge-unavailable' },
};

/** 仪表盘数据健康卡片（ruo §8 数据健康组件）。 */
const renderDataHealth = async (setStatus) => {
  const body = document.getElementById('data-health-body');
  if (body === null) return;
  const r = await callApi('/api/market-data-status');
  if (!r.ok) {
    body.textContent = '加载失败';
    return;
  }
  const data =
    /** @type {{providers: Array<{provider: string, freshness: string, latestObservedAt?: string}>, datasets?: Array<{dataset: string, source: string, freshness: string, dataAsOf?: string, lastSuccessAt?: string, lastErrorKind?: string}>, watchHealth: {state: string, triggered?: number, notifyFailed?: number}|null, watchlistStale: Array<{watchlistId: string, name: string}>}} */ (
      r.data
    );
  const providerEls = data.providers.map((p) => {
    const meta = FRESHNESS_LABEL[p.freshness] ?? FRESHNESS_LABEL.unknown;
    const observed = p.latestObservedAt
      ? new Date(p.latestObservedAt).toLocaleString('zh-CN', { hour12: false })
      : '—';
    return el('span', `data-health-provider ${meta.cls}`, [
      `${p.provider} · ${meta.label}`,
      el('span', 'muted', observed),
    ]);
  });
  const wh = data.watchHealth;
  const watchText =
    wh === null
      ? 'watch 从未运行'
      : `watch ${wh.state}（今日触发 ${wh.triggered ?? 0}，失败 ${wh.notifyFailed ?? 0}）`;
  const stale =
    data.watchlistStale.length === 0
      ? null
      : el('div', 'data-health-stale', [
          el('h3', null, 'stale Watchlist'),
          el(
            'ul',
            null,
            data.watchlistStale.map((item) =>
              el('li', null, `${item.name}（${item.watchlistId}）`),
            ),
          ),
        ]);
  // 数据集明细（ruo §8 读模型的 datasets，此前被丢弃）：折叠展示 per-dataset 观测
  const datasets = Array.isArray(data.datasets) ? data.datasets : [];
  const datasetDetail =
    datasets.length === 0
      ? null
      : el('details', 'data-health-datasets', [
          el('summary', null, `数据集明细（${datasets.length}）`),
          el('table', 'table data-health-dataset-table', [
            el('thead', null, [
              el('tr', null, [
                el('th', null, '数据集'),
                el('th', null, '来源'),
                el('th', null, '状态'),
                el('th', null, '数据截至'),
                el('th', null, '最近错误'),
              ]),
            ]),
            el(
              'tbody',
              null,
              datasets.map((ds) => {
                const meta = FRESHNESS_LABEL[ds.freshness] ?? FRESHNESS_LABEL.unknown;
                return el('tr', null, [
                  el('td', null, DATASET_LABELS[ds.dataset] ?? ds.dataset),
                  el('td', null, ds.source),
                  el('td', meta.cls, meta.label),
                  el('td', null, fmtTime(ds.dataAsOf ?? ds.lastSuccessAt)),
                  el('td', 'muted', ds.lastErrorKind ?? ''),
                ]);
              }),
            ),
          ]),
        ]);
  mount(
    body,
    el('div', 'data-health-grid', [
      el('div', 'data-health-providers', [el('h3', null, '行情源'), ...providerEls]),
      el('div', 'data-health-watch', [el('h3', null, 'watch 健康'), el('p', null, watchText)]),
      ...(stale !== null ? [stale] : []),
      ...(datasetDetail !== null ? [datasetDetail] : []),
    ]),
  );
  setStatus('数据健康已更新');
};

/** 设置页 workflow 运行记录卡片。 */
const renderWorkflowRuns = async (setStatus) => {
  const body = document.getElementById('settings-workflow-runs');
  if (body === null) return;
  const r = await callApi('/api/workflow-runs?limit=30');
  if (!r.ok) {
    body.textContent = '加载失败';
    return;
  }
  const runs =
    /** @type {Array<{source: string, name: string, status: string, startedAt: string, finishedAt?: string, summary?: Record<string, unknown>, error?: string}>} */ (
      r.data
    ).runs;
  if (runs.length === 0) {
    body.textContent = '尚无 workflow 运行记录';
    return;
  }
  const row = (run) => {
    const startedAt = new Date(run.startedAt).toLocaleString('zh-CN', { hour12: false });
    const summary = run.summary
      ? Object.entries(run.summary)
          .map(([k, v]) => `${k}=${v}`)
          .join(' · ')
      : '';
    return el('tr', null, [
      el('td', null, run.name),
      el('td', null, run.source),
      el('td', null, run.status),
      el('td', null, startedAt),
      el('td', 'muted', summary || run.error || '—'),
    ]);
  };
  mount(
    body,
    el('details', 'collapsible', [
      el('summary', null, `最近 ${runs.length} 条运行记录（点击展开）`),
      el('table', 'workflow-runs-table mt-2', [
        el(
          'thead',
          null,
          el('tr', null, [
            el('th', null, 'workflow'),
            el('th', null, '源'),
            el('th', null, '状态'),
            el('th', null, '开始'),
            el('th', null, '摘要'),
          ]),
        ),
        el('tbody', null, runs.map(row)),
      ]),
    ]),
  );
  setStatus('workflow 运行记录已更新');
};

/** 研究页：主题浏览、全文搜索和显式股票投影。 */
const renderResearch = async (setStatus) => {
  const vaultForm = /** @type {HTMLFormElement | null} */ (
    document.getElementById('research-vault-settings-form')
  );
  const vaultState = document.getElementById('research-vault-config-state');
  const vaultSettingsStatus = document.getElementById('research-vault-settings-status');
  const vaultSaveButton = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('research-vault-save-btn')
  );
  const input = /** @type {HTMLInputElement | null} */ (
    document.getElementById('research-topic-input')
  );
  const button = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('research-search-btn')
  );
  const results = document.getElementById('research-search-results');
  const detail = /** @type {HTMLElement | null} */ (document.getElementById('research-detail'));
  const kindFilter = /** @type {HTMLSelectElement | null} */ (
    document.getElementById('research-kind-filter')
  );
  const syncButton = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('research-sync-btn')
  );
  const remoteSyncButton = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('research-remote-sync-btn')
  );
  const remoteCancelButton = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('research-remote-cancel-btn')
  );
  const remoteSyncStatus = document.getElementById('research-remote-sync-status');
  const createTopicButton = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('research-create-topic-btn')
  );
  const importDocumentButton = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('research-import-document-btn')
  );
  const importRemoteButton = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('research-import-remote-btn')
  );
  const indexStatus = document.getElementById('research-index-status');
  const embeddingStatus = document.getElementById('research-embedding-status');
  const hybridSearch = /** @type {HTMLInputElement | null} */ (
    document.getElementById('research-hybrid-search')
  );
  const embeddingRebuildButton = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('research-embedding-rebuild-btn')
  );
  const embeddingEvaluateButton = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('research-embedding-evaluate-btn')
  );
  const inbox = document.getElementById('research-inbox');
  const writeStatus = document.getElementById('research-write-status');
  if (
    input === null ||
    button === null ||
    results === null ||
    detail === null ||
    kindFilter === null ||
    syncButton === null
  )
    return;

  const setVaultSettingsStatus = (message, kind = '') => {
    if (vaultSettingsStatus === null) return;
    vaultSettingsStatus.textContent = message;
    vaultSettingsStatus.className = `card-meta ${kind}`.trim();
  };

  const paintEmbeddingStatus = (data) => {
    if (embeddingStatus === null) return;
    if (!data?.configured) {
      embeddingStatus.textContent =
        '语义索引：未启用；FTS5/metadata 仍是确定性基线，正文不会外发。';
      return;
    }
    const model = data.models?.find((item) => item.name === data.defaultModel) ?? data.models?.[0];
    if (!model) {
      embeddingStatus.textContent = '语义索引：已启用但没有可用模型。';
      return;
    }
    const state = model.state;
    embeddingStatus.textContent = `语义索引：${model.name} · ${state.status} · ${state.embeddedChunks}/${state.expectedChunks} chunks · ${model.identity.dimensions} 维 · ${model.identity.version}`;
  };

  const loadEmbeddingStatus = async () => {
    const response = await callApi('/api/research/embeddings/status');
    if (response.ok) paintEmbeddingStatus(response.data);
  };

  const loadVaultSettings = async () => {
    if (vaultForm === null) return;
    const response = await callApi('/api/settings/research-vault');
    if (!response.ok) {
      setVaultSettingsStatus(response.error?.cause ?? 'Vault 设置不可用', 'error');
      return;
    }
    const data = response.data;
    const setValue = (id, value) => {
      const field = /** @type {HTMLInputElement | null} */ (document.getElementById(id));
      if (field !== null) field.value = String(value ?? '');
    };
    const vaultPathField = /** @type {HTMLInputElement | null} */ (
      document.getElementById('research-vault-path')
    );
    if (vaultPathField !== null) {
      vaultPathField.value = '';
      vaultPathField.required = !data.configured;
      vaultPathField.placeholder = data.configured
        ? `已连接 ${data.vaultName ?? 'Vault'}；留空保持当前路径`
        : '/Users/me/Documents/Investment Vault';
    }
    setValue('research-vault-root', data.researchRoot);
    setValue('research-vault-managed-root', data.managedRoot);
    setValue('research-vault-id', data.vaultId);
    setValue('research-vault-max-text', data.maxTextMb);
    setValue('research-vault-max-attachment', data.maxAttachmentMb);
    if (vaultState !== null) {
      vaultState.textContent = data.configError
        ? '配置无效'
        : data.configured
          ? `已连接 · ${data.effectiveVaultId ?? 'Vault'}`
          : '未配置';
      vaultState.className =
        `vault-state ${data.configError ? 'invalid' : data.configured ? 'configured' : ''}`.trim();
    }
    setVaultSettingsStatus(data.configError ?? (data.configured ? '配置已加载' : '填写路径后保存'));
  };

  const loadRemoteSyncStatus = async (preserveMessage = false) => {
    if (remoteSyncButton === null || remoteSyncStatus === null) return;
    const response = await callApi('/api/research/remote-sync/status');
    const configured = response.ok && response.data.configured === true;
    remoteSyncButton.disabled = !configured || researchRemoteSyncController !== null;
    if (!preserveMessage || !configured) {
      remoteSyncStatus.textContent = configured
        ? '远端同步：Git 已显式启用'
        : '远端同步：未启用（需设置 LUOOME_RESEARCH_REMOTE_SYNC=git）';
    }
  };

  const runRemoteSync = async () => {
    if (remoteSyncButton === null || remoteCancelButton === null || remoteSyncStatus === null)
      return;
    const controller = new AbortController();
    researchRemoteSyncController = controller;
    remoteSyncButton.disabled = true;
    remoteCancelButton.hidden = false;
    remoteSyncStatus.textContent = '正在检查工作树、拉取远端并重建索引…';
    try {
      const response = await callApi('/api/research/remote-sync', {
        method: 'POST',
        body: JSON.stringify({ timeoutMs: 60_000 }),
        signal: controller.signal,
      });
      if (!response.ok) {
        remoteSyncStatus.textContent = `远端同步停止：${response.error?.cause ?? response.error?.message ?? response.error?.kind}`;
        return;
      }
      const index = response.data.index;
      remoteSyncStatus.textContent =
        response.data.status === 'succeeded'
          ? `远端同步完成：${response.data.git.status}${index ? `，扫描 ${index.scanned} 个文件` : ''}`
          : `远端已更新，索引部分完成：${response.data.diagnostic ?? '请检查运行记录'}`;
      await load();
    } catch (error) {
      remoteSyncStatus.textContent = controller.signal.aborted
        ? '远端同步取消请求已发送；若已进入本地 fast-forward，将完成该原子步骤后停止'
        : `远端同步失败：${error instanceof Error ? error.message : String(error)}`;
    } finally {
      if (researchRemoteSyncController === controller) researchRemoteSyncController = null;
      remoteCancelButton.hidden = true;
      await loadRemoteSyncStatus(true);
    }
  };

  const saveVaultSettings = async () => {
    if (vaultForm === null || vaultSaveButton === null) return;
    const value = (id) =>
      /** @type {HTMLInputElement} */ (document.getElementById(id)).value.trim();
    const input = {
      vaultPath: value('research-vault-path'),
      researchRoot: value('research-vault-root'),
      managedRoot: value('research-vault-managed-root'),
      vaultId: value('research-vault-id'),
      maxTextMb: Number(value('research-vault-max-text')),
      maxAttachmentMb: Number(value('research-vault-max-attachment')),
    };
    vaultSaveButton.disabled = true;
    setVaultSettingsStatus('正在验证路径并保存…');
    try {
      const saved = await callApi('/api/settings/research-vault', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      if (!saved.ok) {
        setVaultSettingsStatus(saved.error?.message ?? saved.error?.cause ?? '保存失败', 'error');
        return;
      }
      setVaultSettingsStatus('配置已生效，正在建立索引…');
      const synced = await callApi('/api/tools/sync_research_vault/call', {
        method: 'POST',
        body: JSON.stringify({ input: { mode: 'manual' } }),
      });
      if (!synced.ok) {
        await loadVaultSettings();
        setVaultSettingsStatus(
          `配置已保存；同步失败：${synced.error?.message ?? synced.error?.cause ?? synced.error?.kind}`,
          'error',
        );
        return;
      }
      await loadVaultSettings();
      await load();
      setVaultSettingsStatus(
        `已保存并同步：扫描 ${synced.data.scanned} 个 Markdown 文件`,
        'success',
      );
    } finally {
      vaultSaveButton.disabled = false;
    }
  };

  const paintIndexStatus = (status) => {
    if (indexStatus === null) return;
    if (!status) {
      indexStatus.textContent = '索引状态：--';
      return;
    }
    const last = status.lastSyncAt ? ` · ${fmtDateTime(status.lastSyncAt)}` : '';
    indexStatus.textContent = `索引状态：${status.freshness}${last}${status.diagnostic ? ` · ${status.diagnostic}` : ''}`;
    indexStatus.className = `card-meta research-index-${status.freshness}`;
  };

  const paintInbox = (topics, documents) => {
    if (inbox === null) return;
    const rows = [
      ...topics.filter((row) => row.availability !== 'available'),
      ...documents.filter((row) => row.availability !== 'available'),
    ];
    mount(
      inbox,
      rows.length === 0
        ? el('span', 'muted', 'Inbox：暂无缺失、无效或冲突资料')
        : el('span', 'warning', `Inbox：${rows.length} 条资料需要处理`),
    );
  };

  const splitCsv = (value) =>
    value
      .split(/[，,\n]/u)
      .map((item) => item.trim())
      .filter((item, index, items) => item.length > 0 && items.indexOf(item) === index);

  const writeErrorText = (error) => {
    if (!error || typeof error !== 'object') return '写入失败';
    if (error.kind === 'permission_denied') {
      return `写入未开启：${error.required ?? '请设置 LUOOME_EXPOSE_WRITE=true 并重试'}`;
    }
    return error.message ?? error.cause ?? error.required ?? '写入失败';
  };

  const toolErrorText = (error, fallback) =>
    error?.message ?? error?.required ?? error?.cause ?? error?.kind ?? fallback;

  const writeResearch = async (button, toolName, input, label) => {
    if (button !== null) button.disabled = true;
    if (writeStatus !== null) {
      writeStatus.className = 'research-write-status';
      writeStatus.textContent = `正在写入 ${label}…`;
    }
    try {
      const response = await callApi(`/api/tools/${toolName}/call`, {
        method: 'POST',
        body: JSON.stringify({ input }),
      });
      if (!response.ok) {
        if (writeStatus !== null) {
          writeStatus.className = 'research-write-status error';
          writeStatus.textContent = writeErrorText(response.error);
        }
        return;
      }
      const data = response.data;
      const syncLabel = data?.indexed === true ? '已写入并完成索引' : '已写入，索引待同步';
      if (writeStatus !== null) {
        writeStatus.className = 'research-write-status success';
        writeStatus.textContent = `${syncLabel}：${data?.relativePath ?? label}`;
      }
      await load();
    } catch (error) {
      if (writeStatus !== null) {
        writeStatus.className = 'research-write-status error';
        writeStatus.textContent = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (button !== null) button.disabled = false;
    }
  };

  const confirmResearchWrite = (button, toolName, input, label, preview) => {
    openConfirmModal({
      title: '确认写入 managed Vault',
      message: `${preview}\n\n写入后会触发一次索引同步；只有点击“确认写入”才会修改本地文件。`,
      confirmLabel: '确认写入',
      onConfirm: () => void writeResearch(button, toolName, input, label),
    });
  };

  const openCreateTopic = async () => {
    const values = await promptDialog({
      title: '新建研究主题',
      note: '第一步填写元数据；下一步会展示预览并等待确认。',
      fields: [
        { key: 'title', label: '标题', placeholder: '例如：AI 服务器产业链' },
        {
          key: 'kind',
          label: '类型',
          value: 'theme',
          options: [
            { value: 'company', label: '公司' },
            { value: 'industry', label: '产业' },
            { value: 'event', label: '事件' },
            { value: 'theme', label: '主题' },
            { value: 'macro', label: '宏观' },
            { value: 'custom', label: '自定义' },
          ],
        },
        { key: 'summary', label: '摘要', placeholder: '可选' },
        { key: 'subjects', label: '对象（逗号分隔）', placeholder: 'stock:600519.SH' },
        { key: 'tags', label: '标签（逗号分隔）', placeholder: 'AI, 算力' },
      ],
      confirmLabel: '生成预览',
    });
    if (values === null || values.title.length === 0) return;
    const input = {
      title: values.title,
      kind: values.kind,
      ...(values.summary.length > 0 ? { summary: values.summary } : {}),
      subjects: splitCsv(values.subjects),
      tags: splitCsv(values.tags),
    };
    confirmResearchWrite(
      createTopicButton,
      'create_research_topic',
      input,
      `主题「${values.title}」`,
      `标题：${values.title}\n类型：${values.kind}\n摘要：${values.summary || '—'}\n对象：${input.subjects.join('、') || '—'}\n标签：${input.tags.join('、') || '—'}`,
    );
  };

  const openImportDocument = async () => {
    const values = await promptDialog({
      title: '导入本地研究资料',
      note: '只接受你明确提供的 Markdown/TXT；内容会以 untrusted 研究资料保存，不自动生成 Advice。',
      fields: [
        { key: 'title', label: '标题', placeholder: '资料标题' },
        {
          key: 'kind',
          label: '类型',
          value: 'article',
          options: [
            { value: 'report', label: '研报' },
            { value: 'article', label: '文章' },
            { value: 'filing', label: '公告/财报' },
            { value: 'transcript', label: '纪要/逐字稿' },
            { value: 'note', label: '笔记' },
            { value: 'thesis', label: 'Thesis' },
            { value: 'analysis', label: '分析' },
            { value: 'timeline-update', label: '时间线更新' },
          ],
        },
        {
          key: 'format',
          label: '格式',
          value: 'markdown',
          options: [
            { value: 'markdown', label: 'Markdown' },
            { value: 'text', label: '纯文本' },
          ],
        },
        {
          key: 'body',
          label: '正文',
          multiline: true,
          rows: 10,
          placeholder: '粘贴 Markdown 或 TXT 正文',
        },
        { key: 'sourceUrl', label: '来源 URL', placeholder: '可选' },
        { key: 'topicIds', label: '主题 ID（逗号分隔）', placeholder: 'topic_...' },
        { key: 'subjects', label: '对象（逗号分隔）', placeholder: 'stock:600519.SH' },
        { key: 'tags', label: '标签（逗号分隔）', placeholder: '财报, 风险' },
      ],
      confirmLabel: '生成预览',
    });
    if (values === null || values.title.length === 0 || values.body.length === 0) return;
    const input = {
      title: values.title,
      kind: values.kind,
      format: values.format,
      body: values.body,
      ...(values.sourceUrl.length > 0 ? { sourceUrl: values.sourceUrl } : {}),
      topicIds: splitCsv(values.topicIds),
      subjects: splitCsv(values.subjects),
      tags: splitCsv(values.tags),
    };
    const excerpt = values.body.length > 500 ? `${values.body.slice(0, 500)}…` : values.body;
    confirmResearchWrite(
      importDocumentButton,
      'import_local_research_document',
      input,
      `资料「${values.title}」`,
      `标题：${values.title}\n类型：${values.kind} · ${values.format}\n主题：${input.topicIds.join('、') || '—'}\n正文预览：\n${excerpt}`,
    );
  };

  const openImportRemote = async () => {
    const values = await promptDialog({
      title: '导入远程研究资料',
      note: '会经过 SSRF、重定向、媒体类型、大小和超时限制；远程内容始终标记为 untrusted。',
      fields: [
        { key: 'url', label: 'URL', placeholder: 'https://example.com/report.html' },
        { key: 'title', label: '标题', placeholder: '留空则使用网页 title 或 URL 路径' },
        {
          key: 'kind',
          label: '类型',
          value: 'article',
          options: [
            { value: 'report', label: '研报' },
            { value: 'article', label: '文章' },
            { value: 'filing', label: '公告/财报' },
            { value: 'transcript', label: '纪要/逐字稿' },
            { value: 'note', label: '笔记' },
            { value: 'thesis', label: 'Thesis' },
            { value: 'analysis', label: '分析' },
            { value: 'timeline-update', label: '时间线更新' },
          ],
        },
        { key: 'topicIds', label: '主题 ID（逗号分隔）', placeholder: 'topic_...' },
        { key: 'subjects', label: '对象（逗号分隔）', placeholder: 'stock:600519.SH' },
        { key: 'tags', label: '标签（逗号分隔）', placeholder: '来源, 外部' },
      ],
      confirmLabel: '生成预览',
    });
    if (values === null || values.url.length === 0) return;
    const input = {
      url: values.url,
      ...(values.title.length > 0 ? { title: values.title } : {}),
      kind: values.kind,
      topicIds: splitCsv(values.topicIds),
      subjects: splitCsv(values.subjects),
      tags: splitCsv(values.tags),
    };
    confirmResearchWrite(
      importRemoteButton,
      'import_remote_research_document',
      input,
      `远程资料「${values.title || values.url}」`,
      `URL：${values.url}\n类型：${values.kind}\n主题：${input.topicIds.join('、') || '—'}\n对象：${input.subjects.join('、') || '—'}\n远程内容会保存原件并进行安全正文抽取。`,
    );
  };

  const timelineKindLabel = (kind) =>
    ({
      topic: '主题',
      document: '资料',
      'stock-event': '事件',
      'strategy-signal': '策略信号',
      'watch-trigger': '预警触发',
      advice: 'Advice',
      trade: '交易',
      'limit-up': '涨停',
    })[kind] ?? kind;

  const researchTimeline = (timeline) => {
    if (!Array.isArray(timeline) || timeline.length === 0) return null;
    return el('section', 'research-topic-timeline mt-2', [
      el('h3', null, '类型化时间线'),
      el(
        'ul',
        'research-timeline-list',
        timeline
          .slice(0, 30)
          .map((item) =>
            el('li', null, [
              el('span', 'timeline-date', fmtDateTime(item.occurredAt)),
              el('span', 'timeline-badge', timelineKindLabel(item.kind)),
              el('span', null, [
                el('strong', null, item.title),
                item.summary ? el('small', 'muted', item.summary) : null,
              ]),
            ]),
          ),
      ),
    ]);
  };

  const researchLimitUp = (facts) => {
    if (facts === undefined || facts === null) return null;
    if (facts.status === 'unavailable') {
      return el('p', 'muted mt-2', '近期涨停天梯不可用；未将不可用伪装成空结果。');
    }
    const coveredDays = Math.max(0, 30 - (facts.missingDates?.length ?? 0));
    return el('section', 'research-topic-timeline mt-2', [
      el(
        'h3',
        null,
        facts.status === 'partial'
          ? `近期涨停天梯（部分覆盖 ${coveredDays}/30 日）`
          : '近期涨停天梯',
      ),
      facts.status === 'partial'
        ? el('p', 'muted', '仅展示已保存的 PIT 快照；缺失日期未用当前接口回填。')
        : null,
      facts.recent?.length
        ? el(
            'ul',
            'research-timeline-list',
            facts.recent
              .slice(0, 30)
              .map((item) =>
                el('li', null, [
                  el('span', 'timeline-date', item.date),
                  el('span', 'timeline-badge', `${item.ladderLevel} 连板`),
                  el('span', null, item.reason === '--' ? '原因暂缺' : item.reason),
                ]),
              ),
          )
        : el('p', 'muted', '可获得范围内暂无涨停记录'),
    ]);
  };

  const researchProfile = (profile) => {
    if (profile === undefined || profile === null) return null;
    const statusLabel =
      profile.status === 'complete'
        ? '事实完整'
        : profile.status === 'partial'
          ? '部分可用'
          : '不可用';
    const coverage = profile.coverage ?? {};
    return el('section', 'card research-stock-profile mt-2', [
      el('div', 'card-header', [
        el('div', null, [el('h3', null, '股票研究 Profile'), stockIdentityLink(profile.stock)]),
        el(
          'span',
          `badge ${profile.status === 'complete' ? 'badge-ok' : 'badge-warn'}`,
          statusLabel,
        ),
      ]),
      el(
        'p',
        'muted',
        `Topic ${coverage.topics ?? 0} · 资料 ${coverage.documents ?? 0} · 事件 ${coverage.events ?? 0} · 策略信号 ${coverage.strategySignals ?? 0} · 触发 ${coverage.watchTriggers ?? 0}`,
      ),
      profile.factsAsOf ? el('p', 'muted', `事实截止：${fmtDateTime(profile.factsAsOf)}`) : null,
      topicSection(
        '支持证据',
        (profile.evidence ?? []).slice(0, 8).map((item) => item.summary),
      ),
      topicSection(
        '反证',
        (profile.counterEvidence ?? []).slice(0, 8).map((item) => item.summary),
      ),
      topicSection('Unavailable / 待补证', profile.unknowns),
      el('p', 'muted', (profile.limitations ?? []).join(' ')),
    ]);
  };

  const topicSection = (title, items) =>
    Array.isArray(items) && items.length > 0
      ? el('section', 'card-summary-events mt-2', [
          el('h3', null, title),
          el(
            'ul',
            null,
            items.slice(0, 20).map((item) => el('li', null, item)),
          ),
        ])
      : null;

  const showDocument = async (documentId) => {
    setStatus('加载研究资料…');
    const response = await callApi(
      `/api/research/documents/${encodeURIComponent(documentId)}?content=1`,
    );
    if (!response.ok) {
      mount(detail, el('p', 'error', response.error?.message ?? '研究资料不可用'));
      detail.hidden = false;
      return;
    }
    const row = response.data.document;
    paintIndexStatus(response.data.indexStatus);
    const children = [
      el('h2', null, row.title),
      el('p', 'muted', `${row.kind} · ${row.availability}`),
      response.data.content ? el('pre', 'research-document-content', response.data.content) : null,
      researchObsidianLink(response.data.obsidianUri),
    ];
    if (response.data.truncated) children.push(el('p', 'muted', '正文已按安全窗口截断'));
    mount(detail, children);
    detail.hidden = false;
    setStatus(`已加载 ${row.title}`);
  };

  const showTopic = async (topicId) => {
    setStatus('加载研究主题…');
    const response = await callApi(`/api/research/topics/${encodeURIComponent(topicId)}`);
    if (!response.ok) {
      mount(detail, el('p', 'error', response.error?.message ?? '研究主题不可用'));
      detail.hidden = false;
      return;
    }
    const topic = response.data.topic;
    paintIndexStatus(response.data.indexStatus);
    const relationByDocument = new Map(
      (response.data.documentRelations ?? []).map((relation) => [
        relation.documentId,
        relation.relation,
      ]),
    );
    mount(detail, [
      el('h2', null, topic.title),
      el('p', 'muted', `${topic.kind} · ${topic.availability}`),
      topic.summary ? el('p', null, topic.summary) : null,
      response.data.subjects?.length
        ? el(
            'p',
            'muted',
            `显式对象：${response.data.subjects
              .map((subject) => `${subject.subjectKind}:${subject.subjectKey}`)
              .join('、')}`,
          )
        : null,
      response.data.currentThesis
        ? el('section', 'card-summary-thesis mt-2', [
            el('h3', null, '当前 Thesis'),
            el('p', null, response.data.currentThesis.excerpt ?? response.data.currentThesis.title),
          ])
        : null,
      topicSection('支持证据', response.data.sections?.evidence),
      topicSection('反证与风险', response.data.sections?.counterEvidence),
      topicSection('待验证问题', response.data.sections?.unresolved),
      researchObsidianLink(response.data.obsidianUri),
      el(
        'div',
        'research-results-list mt-2',
        response.data.documents.map((document) =>
          el('div', null, [
            researchResultCard(
              document,
              relationByDocument.get(document.id) ?? 'document',
              () => void showDocument(document.id),
            ),
            relationByDocument.has(document.id)
              ? el('small', 'muted', `关系：${relationByDocument.get(document.id)}`)
              : null,
          ]),
        ),
      ),
      researchTimeline(response.data.timeline),
    ]);
    detail.hidden = false;
    setStatus(`已加载 ${topic.title}`);
  };

  const paint = (
    topics,
    documents,
    status,
    timeline = [],
    limitUp = undefined,
    profile = undefined,
  ) => {
    paintIndexStatus(status);
    paintInbox(topics, documents);
    const cards = [
      ...topics.map((topic) => researchResultCard(topic, 'topic', () => void showTopic(topic.id))),
      ...documents.map((document) =>
        researchResultCard(document, 'document', () => void showDocument(document.id)),
      ),
      researchProfile(profile),
      researchTimeline(timeline),
      researchLimitUp(limitUp),
    ];
    const visibleCards = cards.filter(Boolean);
    mount(
      results,
      visibleCards.length === 0
        ? el('p', 'muted', '暂无研究资料；请先同步 Vault')
        : el('div', 'research-results-list', visibleCards),
    );
    detail.hidden = true;
    setStatus(`${topics.length + documents.length} 条研究结果`);
  };

  const load = async () => {
    const query = input.value.trim();
    setStatus(query ? `搜索 ${query}…` : '加载研究主题…');
    if (query) {
      const useHybrid = hybridSearch?.checked === true;
      const response = useHybrid
        ? await callApi('/api/research/search/hybrid', {
            method: 'POST',
            body: JSON.stringify({ text: query, limit: 50 }),
          })
        : await callApi(`/api/research/search?q=${encodeURIComponent(query)}`);
      if (!response.ok) {
        mount(results, el('p', 'error', toolErrorText(response.error, '研究索引不可用')));
        return;
      }
      if (useHybrid && embeddingStatus !== null) {
        const embedding = response.data.embedding;
        embeddingStatus.textContent = `语义检索：${response.data.capability} · ${response.data.complete ? '完整' : '不完整'}${embedding?.diagnostic ? ` · ${embedding.diagnostic}` : ''}`;
      }
      paint(
        [],
        (response.data.hits ?? []).map((hit) => hit.document),
        useHybrid ? undefined : response.data.indexStatus,
      );
      return;
    }
    const kind = kindFilter.value;
    const response = await callApi(
      `/api/research/topics${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`,
    );
    if (!response.ok) {
      mount(results, el('p', 'error', toolErrorText(response.error, '研究索引不可用')));
      return;
    }
    paint(response.data.topics ?? [], [], response.data.indexStatus);
  };

  if (button.dataset.bound !== 'vault') {
    button.dataset.bound = 'vault';
    button.addEventListener('click', () => void load());
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void load();
    });
    kindFilter.addEventListener('change', () => void load());
    syncButton.addEventListener('click', async () => {
      syncButton.disabled = true;
      setStatus('同步 Vault…');
      const response = await callApi('/api/tools/sync_research_vault/call', {
        method: 'POST',
        body: JSON.stringify({ input: { mode: 'manual' } }),
      });
      syncButton.disabled = false;
      if (!response.ok) {
        setStatus(response.error?.message ?? 'Vault 同步失败');
        return;
      }
      setStatus(`Vault 同步完成：扫描 ${response.data.scanned} 个文件`);
      await load();
    });
    embeddingRebuildButton?.addEventListener('click', async () => {
      embeddingRebuildButton.disabled = true;
      setStatus('增量重建语义索引；私人正文将发送给已配置的外部 embedding 模型…');
      const response = await callApi('/api/research/embeddings/rebuild', {
        method: 'POST',
        body: JSON.stringify({ maxChunks: 200 }),
      });
      embeddingRebuildButton.disabled = false;
      if (!response.ok) {
        setStatus(toolErrorText(response.error, '语义索引重建失败'));
        return;
      }
      setStatus(
        `语义索引处理 ${response.data.processed} chunks；覆盖 ${response.data.state.embeddedChunks}/${response.data.state.expectedChunks}`,
      );
      await loadEmbeddingStatus();
    });
    embeddingEvaluateButton?.addEventListener('click', async () => {
      embeddingEvaluateButton.disabled = true;
      setStatus('运行固定评测集；仅发送版本内置的公开评测文本…');
      const response = await callApi('/api/research/embeddings/evaluate', {
        method: 'POST',
        body: JSON.stringify({ topK: 3 }),
      });
      embeddingEvaluateButton.disabled = false;
      if (!response.ok) {
        setStatus(toolErrorText(response.error, '跨模型评测失败'));
        return;
      }
      const summary = response.data.results
        .map((result) =>
          result.status === 'failed'
            ? `${result.model}: 失败（${result.diagnostic ?? 'provider unavailable'}）`
            : `${result.model}: R@3 ${result.recallAtK.toFixed(2)}, MRR ${result.meanReciprocalRank.toFixed(2)}, ${result.latencyMs.toFixed(0)}ms${result.estimatedCostUsd === undefined ? '' : `, $${result.estimatedCostUsd.toFixed(6)}`}`,
        )
        .join('；');
      setStatus(summary || '没有已配置模型可评测');
    });
    remoteSyncButton?.addEventListener('click', () => {
      openConfirmModal({
        title: '确认从 Git 远端拉取 Research Vault',
        message:
          '只允许干净工作树上的 fast-forward。执行前会创建本地 Git bundle 备份；冲突或分叉将停止，不会自动 commit、push、reset、rebase 或选边。\n\n请确认远端仓库为私有仓库，且凭证由本机 Git 凭证管理器提供。',
        confirmLabel: '确认拉取并重建索引',
        onConfirm: () => void runRemoteSync(),
      });
    });
    remoteCancelButton?.addEventListener('click', () => researchRemoteSyncController?.abort());
    createTopicButton?.addEventListener('click', () => void openCreateTopic());
    importDocumentButton?.addEventListener('click', () => void openImportDocument());
    importRemoteButton?.addEventListener('click', () => void openImportRemote());
    vaultForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      void saveVaultSettings();
    });
  }

  await loadVaultSettings();
  await loadEmbeddingStatus();
  await loadRemoteSyncStatus();

  const stockId = routeStockId();
  if (stockId !== null) {
    setStatus(`加载 ${stockId} 的显式研究关联…`);
    const response = await callApi(`/api/research/stocks/${encodeURIComponent(stockId)}`);
    if (!response.ok) {
      mount(results, el('p', 'error', response.error?.message ?? '股票研究投影不可用'));
      return;
    }
    paint(
      response.data.topics ?? [],
      response.data.documents ?? [],
      response.data.indexStatus,
      response.data.timeline ?? [],
      response.data.limitUp,
      response.data.profile,
    );
    return;
  }
  await load();
};

const researchObsidianLink = (uri) => {
  if (!uri) return null;
  const link = el('a', 'btn btn-outline btn-sm', '在 Obsidian 中打开');
  link.setAttribute('href', uri);
  link.setAttribute('target', '_blank');
  link.setAttribute('rel', 'noreferrer');
  return link;
};

const researchResultCard = (row, kind, onOpen) => {
  const open = el('button', 'btn btn-link', row.title);
  open.setAttribute('type', 'button');
  open.addEventListener('click', onOpen);
  return el('article', 'card research-topic-card', [
    open,
    el('p', 'muted', `${kind} · ${row.kind} · ${row.availability}`),
    row.excerpt || row.summary ? el('p', null, row.excerpt ?? row.summary) : null,
  ]);
};

export {
  analyzeAllHoldings,
  bindSettingsActions,
  boardStats,
  calibrationPnlText,
  calibrationRateText,
  cancelAnalyzeAllHoldings,
  decisionLoopAttributionRate,
  errorKindLabel,
  filterAdvices,
  outcomeInputOf,
  renderAdviceList,
  renderDashboard,
  renderDataHealth,
  renderHoldings,
  renderHome,
  renderReports,
  renderResearch,
  renderReview,
  renderSettings,
  renderSettingsAccount,
  renderWorkflowRuns,
  reportEntityHref,
  resetAdviceDeleteMode,
  routeAdviceId,
  routeStockId,
  runWatchOnce,
  sortBoardItems,
  toggleAdviceDeleteMode,
  watchRunSummaryText,
};
