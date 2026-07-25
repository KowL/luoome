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
import { mutateEntity, openAddMemberModal, openGroupModal, openPoolModal } from './mvp-actions.js';
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
  triggerCard,
} from './ui.js';

/* ============ dashboard ============ */

const navigateTo = (href) => {
  window.location.hash = `#${href.replace(/^#/, '')}`;
};

const formatMetricDistribution = (counts, label) => {
  const entries = Object.entries(counts ?? {});
  if (entries.length === 0) return `—`;
  return entries.map(([k, v]) => `${label?.[k] ?? k}×${v}`).join(' · ');
};

const renderDashboard = async (setStatus) => {
  const result = await callApi('/api/dashboard');
  if (!result.ok) {
    setStatus(`仪表盘加载失败：${result.error.kind}`, true);
    return;
  }
  const {
    holdings: d,
    advice: adviceData,
    groups,
    pools,
    watch,
    triggers,
    staleGroupCount,
    metrics,
  } = result.data;

  // 总市值 / 盈亏
  $('#dash-total-value').textContent = fmtNum(d.totalValue);
  const pnlNode = $('#dash-total-pnl');
  pnlNode.textContent = fmtSigned(d.totalPnL);
  pnlNode.className = `value ${d.totalPnL > 0 ? 'text-pos' : d.totalPnL < 0 ? 'text-neg' : ''}`;
  const pnlPctNode = $('#dash-total-pnl-pct');
  pnlPctNode.textContent = fmtPct(d.totalPnLPct);
  pnlPctNode.className = `delta ${d.totalPnL > 0 ? 'pos' : d.totalPnL < 0 ? 'neg' : ''}`;
  $('#dash-holdings-count').textContent = String(d.holdings.length);

  // 今日建议
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
  $('#dash-watch-run-summary').textContent =
    watch.latest === null
      ? '跑一轮后显示评估指标'
      : `评估 ${watch.latest.evaluatedPools} 个方案 / ${watch.latest.evaluatedStocks} 只股票 · ` +
        `触发 ${watch.latest.triggered} · 通知 ${watch.latest.notified}`;
  $('#dash-pool-count').textContent = String(pools.total);
  $('#dash-group-count').textContent = String(groups.total);
  $('#dash-stale-count').textContent = String(staleGroupCount);
  mount(
    $('#dash-trigger-list'),
    triggers.triggers.length === 0
      ? el('p', 'placeholder', '暂无触发。盯盘即使没有信号，也会记录运行心跳。')
      : el(
          'div',
          'trigger-strip',
          triggers.triggers.slice(0, 5).map((t) => triggerCard(t, navigateTo)),
        ),
  );

  // v0.7 策略预警指标（§11 / §12）
  if (metrics && typeof metrics === 'object') {
    const card = $('#dash-metrics-card');
    if (card !== null) card.hidden = false;
    $('#dash-metric-total').textContent = String(metrics.todayTotal ?? 0);
    const PRIORITY_LABEL = { urgent: '急', important: '重要', normal: '普通' };
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
    if (metrics.latestRun && metrics.latestRun.error) {
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
  const { holdings, totalValue, totalPnL, totalPnLPct } = r.data;
  // 缓存给「分析全部」复用，批量入口不再重复拉 /api/holdings
  currentHoldings = holdings;
  if (holdings.length === 0) {
    mount(body, el('tr', null, el('td', { colspan: 9, class: 'placeholder' }, '（无持仓）')));
  } else {
    mount(
      body,
      holdings.map((item) => {
        const code = String(item.holding.stockId).split('.')[0] || item.holding.stockId;
        const pnlCls = item.pnl > 0 ? 'pos' : item.pnl < 0 ? 'neg' : '';
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
        return el('tr', null, [
          el('td', null, code),
          el('td', null, [item.stockName, adviceSlot(item.holding.stockId)]),
          el('td', 'num', String(item.holding.quantity)),
          el('td', 'num', fmtNum(item.holding.avgCost)),
          el('td', 'num', fmtNum(item.currentPrice)),
          el('td', 'num', fmtNum(item.marketValue)),
          el('td', `num ${pnlCls}`, fmtSigned(item.pnl)),
          el('td', `num ${pnlCls}`, fmtPct(item.pnlPct)),
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
      }),
    );
  }
  $('#holdings-total-value').textContent = fmtNum(totalValue);
  const pnlNode = $('#holdings-total-pnl');
  pnlNode.textContent = fmtSigned(totalPnL);
  pnlNode.className = `num ${totalPnL > 0 ? 'text-pos' : totalPnL < 0 ? 'text-neg' : ''}`;
  const pctNode = $('#holdings-total-pnl-pct');
  pctNode.textContent = fmtPct(totalPnLPct);
  pctNode.className = `num ${totalPnL > 0 ? 'text-pos' : totalPnL < 0 ? 'text-neg' : ''}`;
  $('#holdings-foot').hidden = holdings.length === 0;
  renderTrades(tradesResult);
  await backfillLatestAdvice(holdings);
  setStatus(`持仓已刷新 · ${holdings.length} 只`);
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
  const children = [
    el('div', 'card-header', [
      el('h2', null, `持仓最新建议 · ${analysisResults.size}`),
      el('div', 'card-meta', '点击卡片展开详情 · 完整记录见「建议」页'),
    ]),
  ];
  if (analysisFailures.length > 0) {
    children.push(
      el(
        'p',
        'analysis-failures',
        `失败 ${analysisFailures.length} 只：${analysisFailures
          .map((f) => `${f.stockId}（${f.label}）`)
          .join('、')}`,
      ),
    );
  }
  children.push(
    el(
      'div',
      'advice-list',
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

/* ============ groups / watch ============ */

const HEALTH_LABELS = {
  never: '尚未运行',
  running: '正在运行',
  healthy: '运行正常',
  stale: '心跳超时',
  failed: '最近运行失败',
};

const healthLabel = (state) => HEALTH_LABELS[state] ?? state;

const WATCH_PLAN_STATES = {
  ready: ['成员就绪', 'badge-pos'],
  stale: ['成员已过期', 'badge-warn'],
  empty: ['暂无成员', 'badge-neutral'],
  'group-disabled': ['分组已停用', 'badge-neg'],
  'group-missing': ['分组不存在', 'badge-neg'],
};

const setHealth = (selector, state) => {
  const node = $(selector);
  if (node !== null) node.className = `health-dot health-${state}`;
};

const isDynamicGroup = (group) =>
  group.resolver.kind === 'formula' || group.resolver.kind === 'llm';

/** 战法 id → 名称映射（用户看名称不看 id）。renderGroups 时刷新。 */
let tacticNames = new Map();
const loadTacticNames = async () => {
  const r = await callApi('/api/tactics');
  tacticNames = new Map(r.ok ? r.data.tactics.map((t) => [t.id, t.name]) : []);
};
const tacticLabel = (id) => tacticNames.get(id) ?? id;

const resolverLabel = (resolver) => {
  if (resolver.kind === 'manual') return `手动 · ${resolver.stockIds.length} 只`;
  if (resolver.kind === 'holdings') return '持仓活视图';
  if (resolver.kind === 'formula') return `战法 · ${tacticLabel(resolver.tacticId)}`;
  return `LLM · 最多 ${resolver.maxMembers} 只`;
};

/**
 * 预警卡片（v0.7 策略预警，docs/.../§10）—— 委托给 ui.js 的 triggerCard，
 * 注入 navigate 用于「规则太频繁」跳转。
 */
const triggerCardLocal = (trigger, navigate) => triggerCard(trigger, navigate);

const ruleLabel = (rule) => {
  if (rule.kind === 'price-change') return `日内涨跌 ≥ ${(rule.pct * 100).toFixed(1)}%`;
  if (rule.kind === 'cost-threshold') {
    const parts = [];
    if (rule.stopLossPct) parts.push(`止损 ${(rule.stopLossPct * 100).toFixed(1)}%`);
    if (rule.takeProfitPct) parts.push(`止盈 ${(rule.takeProfitPct * 100).toFixed(1)}%`);
    return parts.join(' · ');
  }
  return `战法 ${tacticLabel(rule.tacticId)} ≥ ${rule.minScore}`;
};

const watchPlanCard = (view, refresh) => {
  const pool = view.plan;
  const [stateLabel, stateClass] = WATCH_PLAN_STATES[view.state] ?? [view.state, 'badge-neutral'];
  const edit = el('button', 'btn btn-outline btn-sm', '编辑');
  edit.addEventListener('click', () => void openPoolModal(pool, pool.groupId));
  const toggle = el('button', 'btn btn-outline btn-sm', pool.enabled ? '停用' : '启用');
  toggle.addEventListener(
    'click',
    () =>
      void mutateEntity(
        'update_stock_pool',
        { id: pool.id, enabled: !pool.enabled },
        refresh,
        pool.enabled ? '盯盘方案已停用' : '盯盘方案已启用',
      ),
  );
  const remove = el('button', 'btn btn-ghost btn-sm', '删除');
  remove.addEventListener('click', () => {
    if (!window.confirm(`删除盯盘方案「${pool.name}」？历史触发会保留。`)) return;
    void mutateEntity('delete_stock_pool', { id: pool.id }, refresh, '盯盘方案已删除');
  });
  return el('article', `group-plan-card state-${view.state} ${pool.enabled ? '' : 'disabled'}`, [
    el('div', 'pool-card-head', [
      el('div', null, [el('h3', null, pool.name)]),
      el('div', 'plan-badges', [
        el(
          'span',
          `badge ${pool.enabled ? 'badge-pos' : 'badge-neutral'}`,
          pool.enabled ? '运行中' : '已停用',
        ),
        el('span', `badge ${stateClass}`, stateLabel),
      ]),
    ]),
    el('p', 'muted', pool.description ?? '未填写方案说明'),
    el(
      'div',
      'rule-list',
      pool.rules.map((rule) => el('span', 'rule-chip', ruleLabel(rule))),
    ),
    el('div', 'pool-foot', [
      el('span', 'muted', `冷却 ${pool.cooldownMinutes} 分钟 · ${view.memberCount} 只成员`),
      el('div', 'row-actions', [edit, toggle, remove]),
    ]),
  ]);
};

let selectedGroupId = '';

const showGroupDetail = async (id, setStatus) => {
  selectedGroupId = id;
  document.querySelectorAll('.entity-row').forEach((node) => {
    node.classList.toggle('selected', node.dataset.id === id);
  });
  const [result, plansResult, triggersResult] = await Promise.all([
    callApi(`/api/groups/${encodeURIComponent(id)}`),
    callApi(`/api/watch/plans?groupId=${encodeURIComponent(id)}`),
    callApi('/api/watch/triggers?limit=100'),
  ]);
  const detail = $('#group-detail');
  if (!result.ok) {
    mount(detail, el('p', 'placeholder', `分组详情加载失败：${result.error.kind}`));
    return;
  }
  const { group, members, latestRefreshAt, stale } = result.data;
  // 拉一次行情补齐现价 / 日内变化（非交易时段 / 缺行情时大多为 null，前端降级 `--`）
  const quoteMap = new Map();
  const stockIds = members.map((m) => m.stockId);
  if (stockIds.length > 0) {
    const qResp = await callApi('/api/tools/batch_quote/call', {
      method: 'POST',
      body: JSON.stringify({ input: { stockIds } }),
    });
    if (qResp.ok && Array.isArray(qResp.data?.quotes)) {
      for (const q of qResp.data.quotes) quoteMap.set(q.stockId, q);
    }
  }
  // 公式 / LLM 这两类是快照过来的，reason 写的是「战法 …命中 / LLM rationale」，值得看；
  // 手动 / 持仓 这两类的 reason 是系统标签（manual 固定成员 / holdings 活视图），删掉。
  const showReason = group.resolver.kind === 'formula' || group.resolver.kind === 'llm';
  const heading = el('div', 'detail-heading', [
    el('div', null, [
      el('h2', null, group.name),
      el('p', 'muted', group.description ?? '未填写说明'),
    ]),
    el(
      'span',
      `badge ${group.enabled ? 'badge-pos' : 'badge-neutral'}`,
      group.enabled ? '启用' : '停用',
    ),
  ]);
  const meta = el('div', 'detail-meta', [
    el('span', null, `来源：${resolverLabel(group.resolver)}`),
    el('span', null, `刷新：${group.refreshPolicy}`),
    el(
      'span',
      stale ? 'text-neg' : 'muted',
      stale ? '快照已过期' : `最近：${fmtDateTime(latestRefreshAt)}`,
    ),
  ]);
  const actions = el('div', 'row-actions');
  const edit = el('button', 'btn btn-outline btn-sm', '编辑');
  edit.addEventListener('click', () => openGroupModal({ group }));
  const toggle = el('button', 'btn btn-outline btn-sm', group.enabled ? '停用' : '启用');
  toggle.addEventListener(
    'click',
    () =>
      void mutateEntity(
        'update_stock_group',
        { id: group.id, enabled: !group.enabled },
        () => renderGroups(setStatus),
        group.enabled ? '分组已停用' : '分组已启用',
      ),
  );
  actions.append(edit, toggle);
  if (isDynamicGroup(group)) {
    const refresh = el('button', 'btn btn-primary btn-sm', '刷新成员');
    refresh.addEventListener(
      'click',
      () =>
        void mutateEntity(
          'refresh_stock_group',
          { groupId: group.id },
          () => renderGroups(setStatus),
          '分组刷新完成',
        ),
    );
    actions.append(refresh);
  }
  const remove = el('button', 'btn btn-ghost btn-sm', '删除');
  remove.addEventListener('click', () => {
    if (!window.confirm(`删除分组「${group.name}」？被盯盘方案引用时系统会拒绝。`)) return;
    void mutateEntity(
      'delete_stock_group',
      { id: group.id },
      () => {
        selectedGroupId = '';
        return renderGroups(setStatus);
      },
      '分组已删除',
    );
  });
  actions.append(remove);
  const addMemberBtn =
    group.resolver.kind === 'manual' ? el('button', 'btn btn-primary btn-sm', '+ 添加成员') : null;
  if (addMemberBtn !== null) {
    addMemberBtn.addEventListener(
      'click',
      () => void openAddMemberModal(group, () => showGroupDetail(group.id, setStatus)),
    );
  }
  const emptyMembersText =
    group.resolver.kind === 'manual'
      ? members.length === 0
        ? '当前没有成员。点击下方「+ 添加成员」逐只加入，或回编辑批量调整。'
        : null
      : members.length === 0
        ? '当前没有成员。动态分组可点击「刷新成员」。'
        : null;
  const membersBox =
    emptyMembersText !== null
      ? el('p', 'placeholder', emptyMembersText)
      : el(
          'div',
          'member-list',
          members.map((member) => {
            const quote = quoteMap.get(member.stockId) ?? null;
            const close = quote?.close;
            const open = quote?.open;
            let pctText = '—';
            let pctClass = '';
            if (
              typeof close === 'number' &&
              Number.isFinite(close) &&
              typeof open === 'number' &&
              Number.isFinite(open) &&
              open !== 0
            ) {
              const pct = (close - open) / open;
              const sign = pct > 0 ? '+' : '';
              pctText = `${sign}${(pct * 100).toFixed(2)}%`;
              pctClass = pct > 0 ? 'text-pos' : pct < 0 ? 'text-neg' : '';
            }
            const line1 = el('div', 'member-line-1', [
              el('strong', 'mono', member.stockId),
              el('span', 'member-name', member.name),
              el(
                'span',
                `member-price ${typeof close === 'number' ? '' : 'muted'}`,
                typeof close === 'number' && Number.isFinite(close) ? close.toFixed(2) : '--',
              ),
              el('span', `member-pct ${pctClass}`, pctText),
            ]);
            const row = el('div', 'member-row', [line1]);
            if (showReason && member.reason.length > 0) {
              row.append(el('div', 'member-line-2 muted', member.reason));
            }
            return row;
          }),
        );
  const addPlan = el('button', 'btn btn-primary btn-sm', '+ 新建盯盘方案');
  addPlan.addEventListener('click', () => void openPoolModal(null, group.id));
  const plans = plansResult.ok ? plansResult.data.plans : [];
  const plansBox = !plansResult.ok
    ? el('p', 'placeholder', `方案加载失败：${plansResult.error.kind}`)
    : plans.length === 0
      ? el(
          'div',
          'plan-empty',
          el('p', 'placeholder', '这个分组还没有盯盘方案。添加规则后才会进入盘中评估。'),
        )
      : el(
          'div',
          'group-plan-grid',
          plans.map((view) => watchPlanCard(view, () => showGroupDetail(group.id, setStatus))),
        );
  const planIds = new Set(plans.map(({ plan }) => plan.id));
  const groupTriggers = triggersResult.ok
    ? triggersResult.data.triggers.filter((trigger) => planIds.has(trigger.poolId))
    : [];
  const triggerBox = !triggersResult.ok
    ? el('p', 'placeholder', `触发记录加载失败：${triggersResult.error.kind}`)
    : groupTriggers.length === 0
      ? el('p', 'placeholder', '暂无触发记录。')
      : el(
          'div',
          'trigger-strip',
          groupTriggers.slice(0, 6).map((t) => triggerCard(t, navigateTo)),
        );
  mount(detail, [
    heading,
    meta,
    actions,
    el('div', 'detail-section-heading', [
      el('h3', 'detail-section-title', `盯盘方案 · ${plans.length}`),
      addPlan,
    ]),
    plansBox,
    el('div', 'detail-section-heading', [
      el('h3', 'detail-section-title', `当前成员 · ${members.length}`),
      addMemberBtn,
    ]),
    membersBox,
    el('h3', 'detail-section-title', '最近触发'),
    triggerBox,
  ]);
};

const renderGroups = async (setStatus) => {
  const [result, plansResult] = await Promise.all([
    callApi('/api/groups'),
    callApi('/api/watch/plans'),
    loadTacticNames(),
  ]);
  const list = $('#groups-list');
  if (!result.ok) {
    mount(list, el('p', 'placeholder', `加载失败：${result.error.kind}`));
    setStatus(`分组加载失败：${result.error.kind}`, true);
    return;
  }
  const items = result.data.groups;
  const planCounts = new Map();
  if (plansResult.ok) {
    for (const { plan } of plansResult.data.plans) {
      planCounts.set(plan.groupId, (planCounts.get(plan.groupId) ?? 0) + 1);
    }
  }
  $('#groups-meta').textContent = `${items.length} 个`;

  // v0.7 策略预警：模板与自然语言草案
  bindPlanCreator(setStatus);
  void renderPlanCreator(setStatus);
  mount(
    list,
    items.length === 0
      ? el('p', 'placeholder', '暂无分组，先创建一个成员来源。')
      : items.map((item) => {
          const row = el('button', 'entity-row', [
            el('span', 'entity-row-main', [
              el('strong', null, item.group.name),
              el('small', 'muted', resolverLabel(item.group.resolver)),
            ]),
            el('span', 'entity-stats', [
              el('span', 'entity-count', `${item.memberCount ?? 0} 股`),
              el('span', 'entity-plan-count', `${planCounts.get(item.group.id) ?? 0} 方案`),
            ]),
          ]);
          row.type = 'button';
          row.dataset.id = item.group.id;
          row.addEventListener('click', () => void showGroupDetail(item.group.id, setStatus));
          return row;
        }),
  );
  const target =
    items.find((item) => item.group.id === selectedGroupId)?.group.id ?? items[0]?.group.id;
  if (target !== undefined) await showGroupDetail(target, setStatus);
  else mount($('#group-detail'), el('p', 'placeholder', '创建分组后，可在这里查看成员。'));
  setStatus(`分组已刷新 · ${items.length} 个`);
};

const runWatchOnce = async (setStatus) => {
  const button = $('#btn-dashboard-watch-run');
  if (button === null) return;
  button.disabled = true;
  setStatus('正在执行一轮盯盘…');
  const result = await callApi('/api/watch/run-once', {
    method: 'POST',
    body: JSON.stringify({ notify: false }),
  });
  button.disabled = false;
  if (!result.ok) {
    setStatus(`盯盘失败：${result.error.message ?? result.error.kind}`, true);
    return;
  }
  await renderDashboard(setStatus);
  setStatus(`盯盘完成 · ${result.data.triggers.length} 条触发`);
};

/* ============ tactics ============ */

const renderTacticsList = async (setStatus) => {
  const r = await callApi('/api/tactics');
  const list = $('#tactics-list');
  if (!r.ok) {
    mount(list, el('p', 'placeholder', `加载失败：${r.error.kind}`));
    setStatus(`加载失败：${r.error.kind}`, true);
    return;
  }
  if (r.data.tactics.length === 0) {
    mount(list, el('p', 'placeholder', '（暂无战法）'));
    return;
  }
  const ul = el('ul');
  ul.style.listStyle = 'none';
  ul.style.padding = '0';
  ul.style.margin = '0';
  for (const t of r.data.tactics) {
    const li = el(
      'li',
      null,
      el('div', null, [
        el('strong', null, t.name),
        el('span', 'badge', ` ${t.tag} `),
        el('span', 'badge', ` ${t.direction} `),
        el('span', 'badge', ` ${t.source} `),
        el('p', 'muted', t.description),
      ]),
    );
    li.style.padding = 'var(--space-3) 0';
    li.style.borderBottom = '1px solid var(--line)';
    ul.append(li);
  }
  mount(list, ul);
  setStatus(`战法列表已刷新 · ${r.data.tactics.length} 个`);
};

const runTacticScan = async (setStatus) => {
  const btn = $('#btn-tactic-scan');
  if (btn !== null) btn.disabled = true;
  setStatus('扫描中…（list_tactics → run_tactic × N → score_signals）');
  const r = await callApi('/api/tactics/scan?topN=10&scope=holdings');
  const box = $('#tactic-signals');
  if (!r.ok) {
    mount(box, el('p', 'placeholder', `扫描失败：${r.error.kind}`));
    setStatus(`扫描失败：${r.error.kind}`, true);
    if (btn !== null) btn.disabled = false;
    return;
  }
  const d = r.data;
  const head = el(
    'p',
    'muted',
    `战法 ${d.totalTactics} · 评估 ${d.evaluatedStocks ?? 0} 股 · 命中 ${d.ranked.length}`,
  );
  if (d.ranked.length === 0) {
    mount(box, [head, el('p', 'placeholder', '（未命中任何战法信号）')]);
    setStatus('扫描完成（无信号）');
    if (btn !== null) btn.disabled = false;
    return;
  }
  const ul = el('ul');
  ul.style.listStyle = 'none';
  ul.style.padding = '0';
  for (const s of d.ranked) {
    const code = String(s.stockId ?? '').split('.')[0] || s.stockId;
    const li = el(
      'li',
      null,
      el('div', null, [
        el('strong', null, `${code} · ${s.tacticName}`),
        el('p', null, `方向 ${s.direction} · 评分 ${(s.llmScore ?? 0).toFixed(1)}`),
        el('p', 'muted', s.rationale ?? ''),
      ]),
    );
    li.style.padding = 'var(--space-3) 0';
    li.style.borderBottom = '1px solid var(--line)';
    ul.append(li);
  }
  mount(box, [head, ul]);
  setStatus(`扫描完成 · top ${d.ranked.length}`);
  if (btn !== null) btn.disabled = false;
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
  const filtered = filter === 'all' ? all : all.filter((a) => a.decision === filter);
  if (filtered.length === 0) {
    mount(
      list,
      el('p', 'placeholder', filter === 'all' ? '（暂无建议）' : `（无 ${filter} 类建议）`),
    );
  } else {
    mount(list, filtered.map(adviceCard));
  }
  setStatus(`建议已刷新 · ${filtered.length} / ${all.length} 条`);
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
  const followedText = window.prompt(
    `回填 ${adviceId.slice(0, 8)}（决策 ${decision}）\n输入: followed / partially_followed / ignored`,
    'followed',
  );
  if (followedText === null) return;
  const pnlText = window.prompt('实际盈亏（人民币，可负）', '0');
  if (pnlText === null) return;
  const pnl = Number(pnlText);
  const notes = window.prompt('备注（可选）', '') ?? '';
  const r = await callApi(`/api/review/${adviceId}/outcome`, {
    method: 'POST',
    body: JSON.stringify({
      input: {
        followed: followedText === 'followed' || followedText === '1',
        pnl: Number.isFinite(pnl) ? pnl : 0,
        ...(notes.length > 0 ? { notes } : {}),
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
        window.alert('请填写账户名称、3 位币种代码和非负初始资金。');
        return;
      }
      createBtn.disabled = true;
      const created = await callApi('/api/tools/create_account/call', {
        method: 'POST',
        body: JSON.stringify({ input: { name, currency, initialCapital } }),
      });
      if (!created.ok) {
        createBtn.disabled = false;
        window.alert(`创建失败：${created.error?.kind ?? 'unknown'}。请先保存有效 token。`);
        return;
      }
      const accountId = created.data.account.id;
      const selected = await callApi('/api/account/select', {
        method: 'POST',
        body: JSON.stringify({ accountId }),
      });
      if (!selected.ok) {
        createBtn.disabled = false;
        // v0.8 起：把 error.cause 一并 alert（zod issues / SQL 异常都藏在这里），
        // 否则只看 kind='internal' 永远定不到根因。
        const e = selected.error ?? {};
        const detail = e.cause ? `（${e.cause}）` : '';
        window.alert(`账户已创建，但激活失败：${e.kind ?? 'unknown'}${detail}`);
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

/* ============ 盯盘方案模板与自然语言草案（v0.7 §10） ============ */

let _planTemplatesCache = null;
let _planTemplateGroups = null;

const fetchPlanTemplates = async () => {
  if (_planTemplatesCache !== null) return _planTemplatesCache;
  const r = await callApi('/api/watch/templates');
  if (!r.ok) {
    _planTemplatesCache = [];
    return _planTemplatesCache;
  }
  _planTemplatesCache = r.data.templates ?? [];
  return _planTemplatesCache;
};

const fetchGroupOptions = async () => {
  if (_planTemplateGroups !== null) return _planTemplateGroups;
  const r = await callApi('/api/groups');
  if (!r.ok) {
    _planTemplateGroups = [];
    return _planTemplateGroups;
  }
  _planTemplateGroups = (r.data.groups ?? []).map((row) => row.group) ?? [];
  return _planTemplateGroups;
};

const ensureModalContainer = (id, anchorSelector) => {
  let host = document.getElementById(id);
  if (host !== null) return host;
  host = document.createElement('div');
  host.id = id;
  host.className = 'modal-root';
  const anchor = document.querySelector(anchorSelector);
  (anchor ?? document.body).append(host);
  return host;
};

/** 把模板 / 草案按真实控件 id 填入创建表单（表单只支持 3 种规则类型）。 */
const fillPoolFormFromDraft = (draft, suggestedName) => {
  const setVal = (id, value) => {
    const node = document.getElementById(id);
    if (node !== null && value !== undefined && value !== null) node.value = String(value);
  };
  setVal('pool-name', draft.name ?? suggestedName);
  setVal('pool-description', draft.description ?? '');
  setVal('pool-cooldown', draft.cooldownMinutes ?? 30);
  const rule = Array.isArray(draft.rules) ? draft.rules[0] : null;
  const kind = document.getElementById('pool-rule-kind');
  if (rule === null || kind === null) return;
  if (rule.kind === 'price-change' || rule.kind === 'cost-threshold' || rule.kind === 'tactic') {
    kind.value = rule.kind;
    kind.dispatchEvent(new Event('change'));
    if (rule.kind === 'price-change') {
      setVal('pool-price-pct', (rule.pct ?? 0.05) * 100);
    } else if (rule.kind === 'cost-threshold') {
      setVal('pool-stop-loss', (rule.stopLossPct ?? 0.08) * 100);
      setVal('pool-take-profit', (rule.takeProfitPct ?? 0.15) * 100);
    } else {
      setVal('pool-tactic-id', rule.tacticId);
      setVal('pool-min-score', rule.minScore ?? 60);
    }
  }
  // price-level / composite 等模板规则超出表单支持范围：只填名称与说明，规则请手动选择。
};

const openPlanFromTemplate = async (template) => {
  const groups = await fetchGroupOptions();
  const firstGroup = groups[0]?.id ?? '';
  const groupId = template.draft.groupId ?? firstGroup;
  await openPoolModal(null, groupId);
  requestAnimationFrame(() => fillPoolFormFromDraft({ ...template.draft, groupId }, template.name));
};

const renderPlanCreator = async (setStatus) => {
  const container = $('#plan-templates');
  if (container === null) return;
  const templates = await fetchPlanTemplates();
  if (templates.length === 0) {
    mount(container, el('p', 'placeholder', '模板加载失败，去重新刷新页面。'));
    return;
  }
  const cards = templates.map((tpl) => {
    const card = el('article', 'plan-template-card', [
      el('div', 'template-header', [
        el('span', 'template-icon', tpl.icon ?? '📌'),
        el('strong', null, tpl.name),
      ]),
      el('p', 'muted', tpl.description),
    ]);
    const actions = el('div', 'template-actions');
    const useBtn = el('button', 'btn btn-primary btn-sm', '使用此模板');
    useBtn.type = 'button';
    useBtn.addEventListener('click', () => {
      void openPlanFromTemplate(tpl);
    });
    const detailBtn = el('button', 'btn btn-outline btn-sm', '详情');
    detailBtn.type = 'button';
    detailBtn.addEventListener('click', () => openTemplateDetailModal(tpl));
    actions.append(detailBtn, useBtn);
    card.append(actions);
    return card;
  });
  mount(container, el('div', 'template-grid-inner', cards));
};

/** 动态弹窗：复用 body > .modal + .modal-content 形态。 */
const openDynamicModal = (contentNode) => {
  const modal = el('div', 'modal', [el('div', 'modal-content', [contentNode])]);
  const close = () => modal.remove();
  modal.addEventListener('click', (event) => {
    if (event.target === modal) close();
  });
  document.body.append(modal);
  return { modal, close };
};

/** 模板详情弹窗：JSON 不直接显示在卡片上，弹窗里可查看 + 编辑后使用。 */
const openTemplateDetailModal = (tpl) => {
  const err = el('p', 'modal-error');
  const editor = el('textarea', 'draft-json-editor', JSON.stringify(tpl.draft, null, 2));
  const use = el('button', 'btn btn-primary btn-sm', '使用此模板');
  use.type = 'button';
  const cancel = el('button', 'btn btn-outline btn-sm', '取消');
  cancel.type = 'button';
  const { close } = openDynamicModal(
    el('div', null, [
      el('h2', null, `模板详情：${tpl.name}`),
      el('p', 'muted', tpl.description ?? ''),
      el('p', 'hint', '规则配置如下，可直接修改后再使用。'),
      editor,
      err,
      el('div', 'modal-actions', [cancel, use]),
    ]),
  );
  cancel.addEventListener('click', close);
  use.addEventListener('click', () => {
    let draft;
    try {
      draft = JSON.parse(editor.value);
    } catch {
      err.textContent = 'JSON 格式有误，请检查后再试。';
      return;
    }
    if (draft === null || typeof draft !== 'object' || !Array.isArray(draft.rules)) {
      err.textContent = '配置缺少 rules 数组，无法使用。';
      return;
    }
    close();
    void openPoolModal(null, draft.groupId ?? '').then(() => {
      requestAnimationFrame(() => fillPoolFormFromDraft(draft, draft.name ?? tpl.name));
    });
  });
};

const bindPlanCreator = (setStatus) => {
  const newBtn = $('#btn-plan-new');
  if (newBtn === null) return;
  if (newBtn.dataset.bound === '1') return;
  newBtn.dataset.bound = '1';
  newBtn.addEventListener('click', () => void openPoolModal());
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

/** 股票搜索：复用 /api/stocks/search（优先 adshare，本地兜底）。 */
const searchStocks = async (query) => {
  const r = await callApi(`/api/stocks/search?query=${encodeURIComponent(query)}&limit=8`);
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
    /** @type {{providers: Array<{provider: string, freshness: string, latestObservedAt?: string}>, watchHealth: {state: string, triggered?: number, notifyFailed?: number}|null, groupStale: Array<{groupId: string, name: string}>}} */ (
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
    data.groupStale.length === 0
      ? null
      : el('div', 'data-health-stale', [
          el('h3', null, 'stale 分组'),
          el(
            'ul',
            null,
            data.groupStale.map((g) => el('li', null, `${g.name}（${g.groupId}）`)),
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

  btn.addEventListener('click', () => void runSearch());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void runSearch();
  });
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
    /** @type {{summary: {activeThesis: Record<string, unknown>|null, noteCount: number, eventCount: number, upcomingEvents: Array<Record<string, unknown>>}, timeline: Array<{type: string, at: string, payload: Record<string, unknown>}>}} */ (
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
  mount(summaryEl, [thesisBlock, upcomingBlock]);

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
    buildAddNoteForm(stockId, code, name, () => loadResearch(stockId, code, name)),
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
const buildAddNoteForm = (stockId, code, name, onDone) => {
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
      .../** @type {HTMLSelectElement} */ ((stance).value !== '—'
        ? { stance: /** @type {HTMLSelectElement} */ (stance).value }
        : {}),
      .../** @type {HTMLInputElement} */ ((tags).value.length > 0
        ? {
            tags: /** @type {HTMLInputElement} */ (tags).value
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0),
          }
        : {}),
      .../** @type {HTMLInputElement} */ ((sourceUrl).value.length > 0
        ? { sourceUrl: /** @type {HTMLInputElement} */ (sourceUrl).value }
        : {}),
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
  bindPlanCreator,
  bindSettingsActions,
  cancelAnalyzeAllHoldings,
  errorKindLabel,
  renderAdviceList,
  renderDashboard,
  renderDataHealth,
  renderGroups,
  renderHoldings,
  renderPlanCreator,
  renderResearch,
  renderReview,
  renderSettings,
  renderSettingsAccount,
  renderTacticsList,
  renderWorkflowRuns,
  runTacticScan,
  runWatchOnce,
};
