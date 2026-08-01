/* apps/web/public/js/pages.js —— 7 个路由页面的渲染逻辑。 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import {
  openCloseConfirm,
  openConfirmModal,
  openEditModal,
  openTradeModal,
} from './holdings-actions.js';
import { buildMarketLink, navigateToStock, parseRouteHash } from './market.js';
import { alertDialog, promptDialog } from './modal.js';
import { createStockSearchBox } from './search-box.js';
import { stockIdentityLink } from './stock-link.js';
import {
  $,
  adviceCard,
  decisionBadge,
  el,
  fmtDateTime,
  fmtNum,
  fmtPct,
  fmtSigned,
  mount,
  statBlock,
} from './ui.js';

/* ============ dashboard ============ */

const navigateTo = (href) => {
  window.location.hash = `#${href.replace(/^#/, '')}`;
};

const routeStockId = (hash = window.location.hash) => {
  const value = parseRouteHash(hash).params.get('stockId')?.trim().toUpperCase();
  return value === undefined || value.length === 0 ? null : value;
};

const filterAdvices = (advices, decision, stockId) =>
  advices.filter(
    (advice) =>
      (decision === 'all' || advice.decision === decision) &&
      (stockId === null || advice.subjectId === stockId),
  );

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

/** 仪表盘搜索框只建一次（renderDashboard 有 5s 自动刷新）；选中走行情页统一入口。 */
const bindDashboardSearch = () => {
  const wrap = $('#dashboard-stock-search');
  if (wrap === null) return;
  createStockSearchBox(wrap, { onSelect: (stock) => navigateToStock(stock) });
};

/* ---- 看板纯函数（pages.test.js 直接单测） ---- */

/**
 * 成员涨跌幅（小数）：昨收基准 (close − prevClose) / prevClose。
 * quote 缺 prevClose（如 tencent 分钟端点无昨收）时返回 null，前端显示「—」，
 * 不回退今开基准——(close−open)/open 不是市场口径的涨跌幅。
 */
const memberChangePct = (quote) => {
  const close = quote?.close;
  const prevClose = quote?.prevClose;
  if (
    typeof close === 'number' &&
    Number.isFinite(close) &&
    typeof prevClose === 'number' &&
    Number.isFinite(prevClose) &&
    prevClose > 0
  ) {
    return (close - prevClose) / prevClose;
  }
  return null;
};

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

/** 指数条：unsupported 或空数组时整条隐藏；红涨绿跌沿用 --pos/--neg。 */
const renderIndices = (indicesData, asOf) => {
  const strip = $('#dashboard-indices');
  if (strip === null) return;
  const list = Array.isArray(indicesData?.indices) ? indicesData.indices : [];
  if (indicesData?.unsupported === true || list.length === 0) {
    strip.hidden = true;
    strip.replaceChildren();
    return;
  }
  strip.hidden = false;
  const chips = list.map((idx) => {
    const cls = idx.change > 0 ? 'pos' : idx.change < 0 ? 'neg' : 'flat';
    return el('span', `index-chip ${cls}`, [
      el('span', 'index-name', idx.name),
      el('span', 'index-close mono', fmtNum(idx.close)),
      el('span', 'index-change mono', `${fmtSigned(idx.change)}（${fmtSigned(idx.changePct)}%）`),
    ]);
  });
  mount(strip, [...chips, el('span', 'index-asof', `截至 ${fmtTime(asOf)}`)]);
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
  mount(
    wrap,
    el('table', 'table board-table', [
      el(
        'thead',
        null,
        el('tr', null, [
          el('th', null, '名称'),
          el('th', 'num', '现价'),
          el('th', 'num', '涨跌幅'),
          el('th', null, 'Watchlist'),
          el('th', null, '预警'),
        ]),
      ),
      el('tbody', null, sortBoardItems(items).map(boardRow)),
    ]),
  );
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
  bindDashboardSearch();
  const result = await callApi('/api/dashboard');
  if (!result.ok) {
    setStatus(`仪表盘加载失败：${result.error.kind}`, true);
    return;
  }
  const {
    asOf,
    holdings: d,
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

  // 指数条 + 实时看板
  renderIndices(indices, asOf);
  renderBoard(Array.isArray(board) ? board : []);

  // 总市值 / 盈亏
  $('#dash-total-value').textContent = fmtNum(d.totalValue);
  const pnlNode = $('#dash-total-pnl');
  pnlNode.textContent = fmtSigned(d.totalPnL);
  pnlNode.className = `value ${d.totalPnL > 0 ? 'text-pos' : d.totalPnL < 0 ? 'text-neg' : ''}`;
  const pnlPctNode = $('#dash-total-pnl-pct');
  pnlPctNode.textContent = fmtPct(d.totalPnLPct);
  pnlPctNode.className = `delta ${d.totalPnL > 0 ? 'pos' : d.totalPnL < 0 ? 'neg' : ''}`;
  $('#dash-holdings-count').textContent = String(d.holdings.length);

  // 今日建议 Top 3
  const advices = adviceData.advices;
  $('#dash-advice-count').textContent = String(advices.length);
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
  $('#dash-advice-summary').textContent = Object.entries(byDecision)
    .map(([decision, count]) => `${decision}×${count}`)
    .join(' · ');

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
  if (holdings.length === 0) {
    mount(body, el('tr', null, el('td', { colspan: 8, class: 'placeholder' }, '（无持仓）')));
  } else {
    mount(
      body,
      holdings.map((item) => {
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
              actionBtn(
                '分析',
                (btn) => void runAnalyzeStock(item.holding.stockId, setStatus, btn),
              ),
              actionBtn('加仓', () => openTradeModal(h, 'buy')),
              actionBtn('减仓', () => openTradeModal(h, 'sell')),
              actionBtn('纠错', () => openEditModal(h)),
              actionBtn('平仓', () => openCloseConfirm(h)),
            ]),
          ]),
        ]);
        row.dataset.stockId = item.holding.stockId;
        return row;
      }),
    );
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

const renderTrades = (result) => {
  const body = $('#trades-body');
  if (!result.ok) {
    mount(body, el('tr', null, el('td', 'placeholder', `交易加载失败：${result.error.kind}`)));
    return;
  }
  mount(
    body,
    result.data.trades.length === 0
      ? el('tr', null, el('td', 'placeholder', '（无交易记录）'))
      : result.data.trades.map((trade) =>
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
          ]),
        ),
  );
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

const renderAdviceList = async (setStatus) => {
  const r = await callApi('/api/advice?includeExpired=true');
  const list = $('#advice-full-list');
  if (!r.ok) {
    mount(list, el('p', 'placeholder', `加载失败：${r.error.kind}`));
    setStatus(`加载失败：${r.error.kind}`, true);
    return;
  }
  const all = [...r.data.advices].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const filter = $('#advice-filter')?.value ?? 'all';
  const stockId = routeStockId();
  const filtered = filterAdvices(all, filter, stockId);
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
  } else {
    mount(list, filtered.map(adviceCard));
  }
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
  if (item.entityKind === 'advice') return '#advice';
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
      block.items.map((item) =>
        el('div', 'report-metric', [
          el('span', 'report-metric-label', item.label),
          el(
            'strong',
            'report-metric-value',
            `${item.displayValue ?? item.value ?? '不可用'}${item.unit ?? ''}`,
          ),
        ]),
      ),
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
  markdown.type = 'button';
  plain.type = 'button';
  markdown.addEventListener('click', () => void downloadReport(report.id, 'markdown'));
  plain.addEventListener('click', () => void downloadReport(report.id, 'plain-text'));

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
      el('div', 'report-sheet-actions', [reportStatusBadge(report.status), markdown, plain]),
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
      el('section', 'report-provenance', [
        el('span', 'section-kicker', 'PROVENANCE'),
        el('h3', null, '数据来源'),
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
  mount(detail, nodes);
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

const renderReview = async (setStatus) => {
  const r = await callApi('/api/review');
  if (!r.ok) {
    setStatus(`加载失败：${r.error.kind}`, true);
    return;
  }
  const stats = r.data.stats;
  const grid = $('#review-stats-grid');
  mount(grid, [
    statBlock('总条数', String(stats.totalAdvices)),
    statBlock('平均信心度', stats.avgConfidence.toFixed(1)),
    statBlock('命中率', fmtPct(stats.hitRate)),
    statBlock(
      '跟单盈亏',
      fmtSigned(stats.pnlWhenFollowed),
      stats.pnlWhenFollowed > 0 ? 'pos' : stats.pnlWhenFollowed < 0 ? 'neg' : '',
    ),
    statBlock(
      '忽略盈亏',
      fmtSigned(stats.pnlWhenIgnored),
      stats.pnlWhenIgnored > 0 ? 'pos' : stats.pnlWhenIgnored < 0 ? 'neg' : '',
    ),
    statBlock(
      'follow 占比',
      fmtPct(stats.outcomeRate.followed),
      `${fmtPct(stats.outcomeRate.partiallyFollowed)} 部分 / ${fmtPct(stats.outcomeRate.ignored)} 忽略`,
    ),
  ]);
  $('#review-stats-meta').textContent = `${stats.totalAdvices} 条（含已过期）`;

  // ====== W4 confidence 自校准表 ======
  const calR = await callApi('/api/review/calibration');
  if (calR.ok) {
    const cal = calR.data;
    $('#review-calibration-meta').textContent =
      `${cal.totalAdvices} 条 / ${cal.totalWithOutcome} 已回填 · 整体命中率 ${fmtPct(cal.overallHitRate)}`;
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
          `<td class="${hitColor}">${fmtPct(b.hitRate)}</td>` +
          `<td class="${pnlClass}">${fmtSigned(b.avgPnl)}</td>` +
          `<td>${b.avgConfidence.toFixed(1)}</td>` +
          `</tr>`
        );
      })
      .join('');
  } else {
    $('#review-calibration-meta').textContent = `加载校准失败：${calR.error.kind ?? ''}`;
  }

  // 趋势图：mock 数据（W4.E 待后端给出 byDay 序列）；先用 byDecision 的 hitRate
  const decisionData = Object.entries(stats.byDecision ?? {})
    .filter(([, s]) => s.totalAdvices > 0)
    .map(([decision, s]) => ({ label: decision, hitRate: s.hitRate }));
  renderTrend(decisionData);

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
        li.append(
          el('div', 'row-1', [
            el('div', 'subject', [el('span', 'code', code), a.subjectId]),
            el('span', 'badge', `${a.decision} · 信心 ${a.confidence}%`),
          ]),
        );
        li.append(el('p', 'premise', a.reasoning?.premise ?? ''));
        const row2 = el('div', 'row-2', `${status}${pnlText}  有效至 ${fmtDateTime(a.validUntil)}`);
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

const fillOutcomeForm = async (adviceId, decision) => {
  const values = await promptDialog({
    title: `回填 outcome（${adviceId.slice(0, 8)} · 决策 ${decision}）`,
    fields: [
      {
        key: 'followed',
        label: '执行情况',
        value: 'followed',
        options: [
          { value: 'followed', label: '跟随' },
          { value: 'partially_followed', label: '部分跟随' },
          { value: 'ignored', label: '忽略' },
        ],
      },
      { key: 'pnl', label: '实际盈亏（人民币，可负）', value: '0' },
      { key: 'notes', label: '备注（可选）', placeholder: '选填' },
    ],
    confirmLabel: '回填',
  });
  if (values === null) return;
  const pnl = Number(values.pnl);
  const r = await callApi(`/api/review/${adviceId}/outcome`, {
    method: 'POST',
    body: JSON.stringify({
      input: {
        followed: values.followed === 'followed',
        pnl: Number.isFinite(pnl) ? pnl : 0,
        ...(values.notes.length > 0 ? { notes: values.notes } : {}),
      },
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
  const input = $('#settings-token');
  if (input === null) return;
  input.value = window.__luoome.getToken();
  setStatus('设置已加载');
};

const bindSettingsActions = () => {
  const setToken = window.__luoome.setToken;
  const saveBtn = $('#btn-token-save');
  const clrBtn = $('#btn-token-clear');
  if (saveBtn !== null) {
    saveBtn.addEventListener('click', () => {
      const token = $('#settings-token').value.trim();
      setToken(token);
      saveBtn.textContent = '已保存';
      window.setTimeout(() => {
        saveBtn.textContent = '保存 token';
      }, 1200);
    });
  }
  if (clrBtn !== null) {
    clrBtn.addEventListener('click', () => {
      setToken('');
      $('#settings-token').value = '';
    });
  }
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
        await alertDialog('创建失败', `${created.error?.kind ?? 'unknown'}。请先保存有效 token。`);
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

const callTool = (tool, input) =>
  callApi(`/api/tools/${tool}/call`, {
    method: 'POST',
    body: JSON.stringify({ input }),
  });

/** 股票搜索：复用 /api/stocks/search（优先 tushare，本地兜底）；与行情页共用 q 参数。 */
const searchStocks = async (query) => {
  const r = await callApi(`/api/stocks/search?q=${encodeURIComponent(query)}&limit=8`);
  if (!r.ok) return [];
  const data = r.data;
  return data && Array.isArray(data.stocks) ? data.stocks : [];
};

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
    /** @type {{providers: Array<{provider: string, freshness: string, latestObservedAt?: string}>, watchHealth: {state: string, triggered?: number, notifyFailed?: number}|null, watchlistStale: Array<{watchlistId: string, name: string}>}} */ (
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
  mount(
    body,
    el('div', 'data-health-grid', [
      el('div', 'data-health-providers', [el('h3', null, '行情源'), ...providerEls]),
      el('div', 'data-health-watch', [el('h3', null, 'watch 健康'), el('p', null, watchText)]),
      ...(stale !== null ? [stale] : []),
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

/** 研究页：搜索 → 时间线 → 新增/编辑笔记。 */
const renderResearch = async (setStatus) => {
  const detail = /** @type {HTMLElement | null} */ (document.getElementById('research-detail'));
  if (detail !== null) detail.hidden = true;

  const input = /** @type {HTMLInputElement | null} */ (
    document.getElementById('research-stock-input')
  );
  const btn = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('research-search-btn')
  );
  const results = document.getElementById('research-search-results');
  if (input === null || btn === null || results === null) return;

  const runSearch = async () => {
    const q = input.value.trim();
    if (q.length === 0) return;
    setStatus(`搜索 ${q}…`);
    const list = await searchStocks(q);
    mount(
      results,
      list.length === 0
        ? el('p', 'muted', '无匹配')
        : el(
            'ul',
            'research-results-list',
            list.map((c) =>
              el('li', null, [
                el('button', 'btn btn-link', `${c.code} · ${c.name}（${c.exchange}）`),
              ]),
            ),
          ),
    );
    // 绑定选择
    const buttons = results.querySelectorAll('button');
    buttons.forEach((button, i) => {
      button.addEventListener('click', () => {
        const c = list[i];
        if (c) void loadResearch(c.id, c.code, c.name);
      });
    });
    setStatus(`找到 ${list.length} 个候选`);
  };

  if (btn.dataset.bound !== '1') {
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => void runSearch());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void runSearch();
    });
  }

  const stockId = routeStockId();
  if (stockId !== null) {
    input.value = stockId;
    setStatus(`加载 ${stockId} 研究记录…`);
    const candidates = await searchStocks(stockId);
    const stock = candidates.find((candidate) => candidate.id === stockId);
    if (stock === undefined) {
      setStatus(`未找到股票 ${stockId}`, true);
    } else {
      await loadResearch(stock.id, stock.code, stock.name);
    }
  }
};

/** 加载并渲染某只股票的研究时间线。 */
const loadResearch = async (stockId, code, name) => {
  const detail = /** @type {HTMLElement | null} */ (document.getElementById('research-detail'));
  const titleEl = document.getElementById('research-title');
  const summaryEl = document.getElementById('research-summary');
  const summaryMeta = document.getElementById('research-summary-meta');
  const timelineEl = document.getElementById('research-timeline');
  const addNoteEl = document.getElementById('research-add-note');
  if (!detail || !titleEl || !summaryEl || !summaryMeta || !timelineEl || !addNoteEl) return;
  detail.hidden = false;
  titleEl.textContent = `${code} · ${name} · 研究档案`;
  summaryMeta.textContent = '加载中…';
  mount(summaryEl, el('p', 'muted', '加载中…'));
  mount(timelineEl, el('p', 'muted', '加载中…'));
  mount(addNoteEl, el('p', 'muted', '加载中…'));

  const r = await callApi(`/api/stocks/${encodeURIComponent(stockId)}/research-timeline`);
  if (!r.ok) {
    summaryMeta.textContent = '加载失败';
    mount(summaryEl, el('p', 'error', r.error?.message ?? '加载失败'));
    return;
  }
  const data =
    /** @type {{summary: {activeThesis: Record<string, unknown>|null, noteCount: number, eventCount: number, upcomingEvents: Array<Record<string, unknown>>, strategySignals: Array<Record<string, unknown>>, watchlistMemberships: Array<{watchlist: {name: string}, member: {stage: string, priority: string}, sources: Array<Record<string, unknown>>}>}, timeline: Array<{type: string, at: string, payload: Record<string, unknown>}>}} */ (
      r.data
    );
  summaryMeta.textContent = `${data.summary.noteCount} 笔记 · ${data.summary.eventCount} 事件`;

  // 摘要
  const thesis = data.summary.activeThesis;
  const thesisBlock = thesis
    ? el('div', 'card-summary-thesis', [
        el('h3', null, '当前假设'),
        el(
          'p',
          'muted',
          `更新于 ${new Date(String(thesis.updatedAt)).toLocaleString('zh-CN', { hour12: false })}`,
        ),
        el('p', null, String(thesis.content ?? '')),
        el('div', 'flex gap-2 mt-2', [
          el('button', 'btn btn-outline btn-sm', '编辑（保存为新版本）', [], {
            click: () => openEditNoteModal(stockId, /** @type {any} */ (thesis), code, name),
          }),
        ]),
      ])
    : el('div', 'muted', '无当前假设（可通过下方「新增笔记 / 假设」创建 thesis）');

  const upcoming = data.summary.upcomingEvents;
  const upcomingBlock = el('div', 'card-summary-events', [
    el('h3', null, '未来事件'),
    upcoming.length === 0
      ? el('p', 'muted', '无未来 30/90 天事件')
      : el(
          'ul',
          null,
          upcoming.slice(0, 8).map((e) => {
            const date = new Date(String(e.occursAt)).toLocaleDateString('zh-CN');
            return el('li', null, `${date} · ${e.title}（${e.kind}，${e.importance ?? 'normal'}）`);
          }),
        ),
  ]);
  const strategyBlock = el('div', 'card-summary-events', [
    el('h3', null, 'StrategySignal'),
    data.summary.strategySignals.length === 0
      ? el('p', 'muted', '暂无 StrategySignal')
      : el(
          'ul',
          null,
          data.summary.strategySignals
            .slice(0, 8)
            .map((signal) =>
              el(
                'li',
                null,
                `${signal.strategyId} · ${signal.ruleId} · ${signal.direction} · score ${signal.score} · data ${new Date(String(signal.ts)).toLocaleString('zh-CN', { hour12: false })} · ${(signal.evidence ?? []).join('；')}`,
              ),
            ),
        ),
  ]);
  const watchlistBlock = el('div', 'card-summary-events', [
    el('h3', null, 'Watchlist 来源'),
    data.summary.watchlistMemberships.length === 0
      ? el('p', 'muted', '不在任何 Watchlist')
      : el(
          'ul',
          null,
          data.summary.watchlistMemberships.map(({ watchlist, member, sources }) =>
            el(
              'li',
              null,
              `${watchlist.name} · ${member.stage}/${member.priority} · ${sources.map((source) => `${source.kind}:${source.status}`).join('、')}`,
            ),
          ),
        ),
  ]);
  mount(summaryEl, [thesisBlock, upcomingBlock, strategyBlock, watchlistBlock]);

  // 时间线
  const TYPES = ['note', 'event', 'trigger', 'advice'];
  const filterRow = el('div', 'research-timeline-filters-row', [
    el('button', 'btn btn-outline btn-sm active', '全部', [], {
      click: () => paintTimeline(data.timeline),
    }),
    ...TYPES.map((t) =>
      el('button', 'btn btn-outline btn-sm', t, [], {
        click: () => paintTimeline(data.timeline.filter((it) => it.type === t)),
      }),
    ),
  ]);
  mount(document.getElementById('research-timeline-filters') ?? timelineEl, filterRow);
  paintTimeline(data.timeline);

  // 新增笔记表单
  mount(
    addNoteEl,
    buildAddNoteForm(stockId, () => loadResearch(stockId, code, name)),
  );
};

const paintTimeline = (items) => {
  const el2 = document.getElementById('research-timeline');
  if (el2 === null) return;
  if (items.length === 0) {
    mount(el2, el('p', 'muted', '时间线为空'));
    return;
  }
  mount(
    el2,
    el(
      'ul',
      'research-timeline-list',
      items.slice(0, 200).map((it) => {
        const at = new Date(it.at).toLocaleString('zh-CN', { hour12: false });
        const badge = el('span', `timeline-badge timeline-${it.type}`, it.type);
        let body;
        if (it.type === 'note') body = String(it.payload.content ?? '');
        else if (it.type === 'event')
          body = `${it.payload.title ?? ''}（${it.payload.kind ?? ''}）`;
        else if (it.type === 'trigger') body = String(it.payload.reason ?? '');
        else
          body = `${it.payload.decision ?? ''} · ${String(it.payload.premise ?? '').slice(0, 80)}`;
        return el('li', null, [badge, el('span', 'muted', at), el('span', null, body)]);
      }),
    ),
  );
};

/** 新增笔记表单：kind=thesis 自动 active；submit 后刷新。 */
const buildAddNoteForm = (stockId, onDone) => {
  const form = el('form', 'research-add-note-form');
  const kindSelect = el('select', null, [
    el('option', null, 'note（普通）'),
    el('option', null, 'thesis（当前假设）'),
    el('option', null, 'source-summary（来源摘要）'),
  ]);
  kindSelect.value = 'note';
  const content = el('textarea', null, '', { rows: 4, placeholder: '笔记内容' });
  const stance = el('select', null, [
    el('option', null, '—'),
    el('option', null, 'bullish'),
    el('option', null, 'bearish'),
    el('option', null, 'neutral'),
  ]);
  const tags = el('input', null, '', { placeholder: '标签（逗号分隔，可选）' });
  const sourceUrl = el('input', null, '', { placeholder: '来源 URL（source-summary 必填）' });
  const errBox = el('p', 'modal-error');
  const submitBtn = el('button', 'btn btn-primary btn-sm', '保存', [], { type: 'submit' });
  form.append(
    el('div', 'field', [el('label', null, '类型'), kindSelect]),
    el('div', 'field', [el('label', null, '内容'), content]),
    el('div', 'field', [el('label', null, '立场'), stance]),
    el('div', 'field', [el('label', null, '标签'), tags]),
    el('div', 'field', [el('label', null, '来源 URL'), sourceUrl]),
    errBox,
    el('div', 'flex gap-2', [submitBtn]),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.textContent = '';
    const kind = /** @type {HTMLSelectElement} */ (kindSelect).value;
    const input = {
      stockId,
      kind,
      content: /** @type {HTMLTextAreaElement} */ (content).value,
      .../** @type {HTMLSelectElement} */ (
        stance.value !== '—' ? { stance: /** @type {HTMLSelectElement} */ (stance).value } : {}
      ),
      .../** @type {HTMLInputElement} */ (
        tags.value.length > 0
          ? {
              tags: /** @type {HTMLInputElement} */ (tags).value
                .split(',')
                .map((s) => s.trim())
                .filter((s) => s.length > 0),
            }
          : {}
      ),
      .../** @type {HTMLInputElement} */ (
        sourceUrl.value.length > 0
          ? { sourceUrl: /** @type {HTMLInputElement} */ (sourceUrl).value }
          : {}
      ),
    };
    const r = await callTool('add_research_note', input);
    if (!r.ok) {
      errBox.textContent = r.error?.message ?? '保存失败';
      return;
    }
    content.value = '';
    onDone();
  });
  return form;
};

/** 简化版：编辑 thesis 弹窗（保存为新版本，历史保留）。 */
const openEditNoteModal = (stockId, thesis, code, name) => {
  const ta = el('textarea', null, String(thesis.content ?? ''), { rows: 6 });
  const stance = el('select', null, [
    el('option', null, 'bullish'),
    el('option', null, 'bearish'),
    el('option', null, 'neutral'),
  ]);
  stance.value = String(thesis.stance ?? 'neutral');
  const err = el('p', 'modal-error');
  const save = el('button', 'btn btn-primary btn-sm', '保存为新版本', [], { type: 'button' });
  const cancel = el('button', 'btn btn-outline btn-sm', '取消', [], { type: 'button' });
  const modal = el('div', 'modal', [
    el('div', 'modal-content', [
      el('h2', null, `编辑 thesis：${code} · ${name}`),
      el('p', 'muted', '保存后会产生新版本（supersedesId 串联），历史版本保留在时间线'),
      el('div', 'field', [el('label', null, '立场'), stance]),
      el('div', 'field', [el('label', null, '新版本内容'), ta]),
      err,
      el('div', 'flex gap-2', [save, cancel]),
    ]),
  ]);
  document.body.append(modal);
  const close = () => modal.remove();
  cancel.addEventListener('click', close);
  save.addEventListener('click', async () => {
    const input = {
      noteId: thesis.id,
      content: ta.value,
      stance: stance.value,
    };
    const r = await callTool('update_research_note', input);
    if (!r.ok) {
      err.textContent = r.error?.message ?? '保存失败';
      return;
    }
    close();
    void loadResearch(stockId, code, name);
  });
};

export {
  analyzeAllHoldings,
  bindSettingsActions,
  boardStats,
  cancelAnalyzeAllHoldings,
  errorKindLabel,
  filterAdvices,
  memberChangePct,
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
  routeStockId,
  runWatchOnce,
  sortBoardItems,
  watchRunSummaryText,
};
