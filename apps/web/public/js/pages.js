/* apps/web/public/js/pages.js —— 7 个路由页面的渲染逻辑。 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import { openCloseConfirm, openEditModal, openTradeModal } from './holdings-actions.js';
import { mutateEntity, openGroupModal, openPoolModal } from './mvp-actions.js';
import {
  $,
  adviceCard,
  el,
  fmtDateTime,
  fmtNum,
  fmtPct,
  fmtSigned,
  mount,
  statBlock,
} from './ui.js';

/* ============ dashboard ============ */

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
      : el('div', 'trigger-strip', triggers.triggers.slice(0, 5).map(triggerCard)),
  );

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
          b.addEventListener('click', onClick);
          return b;
        };
        return el('tr', null, [
          el('td', null, code),
          el('td', null, item.stockName),
          el('td', 'num', String(item.holding.quantity)),
          el('td', 'num', fmtNum(item.holding.avgCost)),
          el('td', 'num', fmtNum(item.currentPrice)),
          el('td', 'num', fmtNum(item.marketValue)),
          el('td', `num ${pnlCls}`, fmtSigned(item.pnl)),
          el('td', `num ${pnlCls}`, fmtPct(item.pnlPct)),
          el('td', null, [
            el('div', 'row-actions', [
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

const analyzeAllHoldings = async (setStatus) => {
  const btn = $('#btn-holdings-analyze');
  if (btn === null) return;
  btn.disabled = true;
  try {
    const r = await callApi('/api/holdings');
    if (!r.ok) {
      setStatus(`加载失败：${r.error.kind}`, true);
      return;
    }
    let done = 0;
    let failed = 0;
    for (const item of r.data.holdings) {
      const stockId = item.holding.stockId;
      setStatus(`分析中 ${done + 1}/${r.data.holdings.length}：${stockId}`);
      const ar = await callApi('/api/tools/analyze_stock/call', {
        method: 'POST',
        body: JSON.stringify({ input: { stockId } }),
      });
      if (ar.ok) done += 1;
      else failed += 1;
    }
    setStatus(
      failed === 0 ? `分析完成：${done} 只` : `分析完成：${done} 成功 / ${failed} 失败`,
      failed > 0,
    );
  } finally {
    btn.disabled = false;
  }
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

const resolverLabel = (resolver) => {
  if (resolver.kind === 'manual') return `手动 · ${resolver.stockIds.length} 只`;
  if (resolver.kind === 'holdings') return '持仓活视图';
  if (resolver.kind === 'formula') return `战法 · ${resolver.tacticId}`;
  return `LLM · 最多 ${resolver.maxMembers} 只`;
};

const triggerCard = (trigger) =>
  el('article', `trigger-card direction-${trigger.direction}`, [
    el('div', 'trigger-card-main', [
      el('strong', 'mono', trigger.stockId),
      el('span', 'badge', trigger.ruleKind),
      el('span', `badge badge-${trigger.direction}`, trigger.direction),
    ]),
    el('p', null, trigger.reason),
    el(
      'small',
      'muted',
      `${fmtDateTime(trigger.createdAt)} · ${trigger.notified ? '已通知' : '仅记录'}`,
    ),
  ]);

const ruleLabel = (rule) => {
  if (rule.kind === 'price-change') return `日内涨跌 ≥ ${(rule.pct * 100).toFixed(1)}%`;
  if (rule.kind === 'cost-threshold') {
    const parts = [];
    if (rule.stopLossPct) parts.push(`止损 ${(rule.stopLossPct * 100).toFixed(1)}%`);
    if (rule.takeProfitPct) parts.push(`止盈 ${(rule.takeProfitPct * 100).toFixed(1)}%`);
    return parts.join(' · ');
  }
  return `战法 ${rule.tacticId} ≥ ${rule.minScore}`;
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
      el('div', null, [el('span', 'eyebrow', pool.id), el('h3', null, pool.name)]),
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
  const heading = el('div', 'detail-heading', [
    el('div', null, [
      el('span', 'eyebrow', group.id),
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
  const membersBox =
    members.length === 0
      ? el('p', 'placeholder', '当前没有成员。动态分组可点击「刷新成员」。')
      : el(
          'div',
          'member-list',
          members.map((member) =>
            el('div', 'member-row', [
              el('strong', 'mono', member.stockId),
              el('span', 'muted', member.reason),
              el('time', 'muted', fmtDateTime(member.refreshedAt)),
            ]),
          ),
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
      : el('div', 'trigger-strip', groupTriggers.slice(0, 6).map(triggerCard));
  mount(detail, [
    heading,
    meta,
    actions,
    el('div', 'detail-section-heading', [
      el('h3', 'detail-section-title', `盯盘方案 · ${plans.length}`),
      addPlan,
    ]),
    plansBox,
    el('h3', 'detail-section-title', `当前成员 · ${members.length}`),
    membersBox,
    el('h3', 'detail-section-title', '最近触发'),
    triggerBox,
  ]);
};

const renderGroups = async (setStatus) => {
  const [result, plansResult] = await Promise.all([
    callApi('/api/groups'),
    callApi('/api/watch/plans'),
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
        el('strong', null, `${t.name}（${t.id}）`),
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
        window.alert(`账户已创建，但激活失败：${selected.error?.kind ?? 'unknown'}`);
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
      el('p', null, `账户 ID：${r.data.accountId}`),
      el('p', null, `状态：${r.data.status}`),
      el('p', null, `持仓数：${r.data.holdings.length}`),
      el('p', null, `总市值：${fmtNum(r.data.totalValue)}`),
      el('p', null, `总盈亏：${fmtSigned(r.data.totalPnL)}（${fmtPct(r.data.totalPnLPct)}）`),
    ]),
  );
};

export {
  analyzeAllHoldings,
  bindSettingsActions,
  renderAdviceList,
  renderDashboard,
  renderGroups,
  renderHoldings,
  renderReview,
  renderSettings,
  renderSettingsAccount,
  renderTacticsList,
  runTacticScan,
  runWatchOnce,
};
