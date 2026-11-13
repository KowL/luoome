import { callApi, getAccountId, getSessionEpoch } from './api.js';
import { initChat, mountChatView } from './chat.js';
import {
  openTradingPlanDetailByVersionId,
  planActionLabel,
  planStatusBadgeClass,
  planStatusLabel,
  planVersionId,
} from './trading-plan-panel.js';
import { $, el, fmtDateTime, mount } from './ui.js';

let version = 0;
let initialized = false;

const section = (index, title, body) =>
  el('section', 'workspace-section', [
    el('div', 'workspace-section-title', [
      el('div', null, [el('span', null, index), el('h2', null, title)]),
    ]),
    body,
  ]);

const card = (title, rows) => el('div', 'workspace-card', [el('h3', null, title), ...rows]);

const row = (label, value) =>
  el('p', 'workspace-card-row', [el('span', 'muted', label), el('strong', null, String(value))]);

const emptyCard = (text) => el('p', 'muted', text);

const resultText = (result) => (result.ok ? null : '读取失败，稍后刷新再看。');

const reportRows = (reports) => {
  if (reports.length === 0) return [emptyCard('今日盘前 / 盘后报告尚未生成。')];
  return reports
    .slice(0, 3)
    .map((report) =>
      card(report.title ?? '日报', [
        row('类型', report.kind ?? 'report'),
        row('区间', `${report.periodStart ?? '--'} → ${report.periodEnd ?? '--'}`),
        row('生成', report.createdAt === undefined ? '--' : fmtDateTime(report.createdAt)),
      ]),
    );
};

const watchlistRows = (overview) => {
  const lists = Array.isArray(overview?.watchlists) ? overview.watchlists : [];
  if (lists.length === 0) return [emptyCard('没有启用中的自选池。')];
  return lists.slice(0, 5).map((entry) => {
    const latestRun = entry.latestRun ?? entry.lastRun;
    const changes = Array.isArray(entry.changes)
      ? entry.changes.length
      : typeof entry.changeCount === 'number'
        ? entry.changeCount
        : undefined;
    return card(entry.name ?? '自选池', [
      row('成员', entry.memberCount ?? entry.members?.length ?? '--'),
      row('最近变化', changes ?? '--'),
      row(
        '最近运行',
        latestRun?.startedAt === undefined ? '未运行' : fmtDateTime(latestRun.startedAt),
      ),
    ]);
  });
};

const planActionBadgeClass = (action) => {
  if (action === 'enter') return 'badge-buy';
  if (action === 'observe') return 'badge-watch';
  if (action === 'avoid') return 'badge-avoid';
  if (action === 'reduce' || action === 'exit') return 'badge-sell';
  return 'badge-neutral';
};

const planCard = (plan) => {
  const stockName = plan.stockName ?? plan.stockId ?? '交易计划';
  const stockCode = plan.stockId ?? '';
  const actionLabel = planActionLabel(plan.action);
  const actionCls = planActionBadgeClass(plan.action);
  const statusLabel = planStatusLabel(plan.status);
  const statusCls = planStatusBadgeClass(plan.status);

  const header = el('div', 'workspace-card-header', [
    el('div', 'workspace-card-title', [
      el('span', 'stock-name', stockName),
      stockCode && stockCode !== stockName ? el('span', 'stock-code', stockCode) : null,
    ]),
    el('div', 'workspace-card-badges', [
      el('span', `badge ${actionCls}`, actionLabel),
      el('span', `badge ${statusCls}`, statusLabel),
    ]),
  ]);

  const metrics = [];
  if (plan.action === 'enter') {
    if (plan.entryPriceLow !== undefined && plan.entryPriceHigh !== undefined) {
      metrics.push(row('入场区间', `${plan.entryPriceLow} ~ ${plan.entryPriceHigh} 元`));
    }
    if (plan.position?.targetPct !== undefined && plan.position.targetPct > 0) {
      metrics.push(row('目标仓位', `${plan.position.targetPct}%`));
    }
  }
  if (plan.exit?.stopLoss !== undefined || plan.exit?.takeProfit !== undefined) {
    const stopLoss = plan.exit?.stopLoss ? `${plan.exit.stopLoss} 元` : '--';
    const takeProfit = plan.exit?.takeProfit ? `${plan.exit.takeProfit} 元` : '--';
    metrics.push(row('止损 / 止盈', `${stopLoss} / ${takeProfit}`));
  }

  const nextReview = plan.holding?.nextReviewAt ?? plan.reviewAt;
  if (nextReview) {
    metrics.push(row('下次复核', fmtDateTime(nextReview)));
  } else if (plan.validUntil) {
    metrics.push(row('有效期至', fmtDateTime(plan.validUntil)));
  }

  const summaryText =
    plan.evidence?.[0]?.summary ??
    (typeof plan.explanation?.supportingEvidenceIds?.[0] === 'string'
      ? plan.explanation.supportingEvidenceIds[0]
      : null);
  const summaryNode = summaryText ? el('p', 'workspace-card-summary', summaryText) : null;

  const footer = el('div', 'workspace-card-footer', [
    el('span', 'muted', `版本 v${plan.version ?? 1}`),
    el('span', 'action-link', '计划详情 ↗'),
  ]);

  const cardNode = el('div', 'workspace-card workspace-plan-card interactive', [
    header,
    ...metrics,
    summaryNode,
    footer,
  ]);

  cardNode.addEventListener('click', () => {
    void openTradingPlanDetailByVersionId(planVersionId(plan));
  });

  return cardNode;
};

const planRows = (plans, views) => {
  const list = Array.isArray(plans) ? plans : Array.isArray(views) ? views : [];
  if (list.length === 0) return [emptyCard('没有生效中的交易计划。')];
  return list.slice(0, 6).map(planCard);
};

export const renderInvestmentWorkspace = async () => {
  initInvestmentWorkspace();
  const requestVersion = ++version;
  const accountId = getAccountId();
  const epoch = getSessionEpoch();
  const [reports, watchlists, plans] = await Promise.all([
    callApi('/api/reports?limit=5'),
    callApi('/api/watchlists/overview'),
    callApi('/api/trading-plans'),
  ]);
  if (requestVersion !== version || accountId !== getAccountId() || epoch !== getSessionEpoch())
    return;
  const facts = $('#workspace-facts');
  if (facts) facts.textContent = '今日决策事实只读展示；报告、自选池与计划均来自已有事实。';
  const reportsBody = el(
    'div',
    'workspace-card-grid',
    reportRows(reports.ok ? (reports.data.reports ?? []) : []),
  );
  mount(
    $('#workspace-holdings'),
    el('div', null, [resultText(reports) === null ? reportsBody : emptyCard(resultText(reports))]),
  );
  mount(
    $('#workspace-directions'),
    el('div', 'workspace-card-grid', watchlistRows(watchlists.ok ? watchlists.data : null)),
  );
  mount($('#workspace-consensus'), el('div'));
  const planData = plans.ok ? plans.data : null;
  mount($('#workspace-plans'), planRows(planData?.plans, planData?.views));
  mount($('#workspace-tracking'), el('div'));
  mount($('#workspace-report'), el('div'));
  mount($('#workspace-account'), el('div'));
};

export const mountWorkspaceChatRoute = () => {
  mountChatView('full');
  const back = $('#chat-return');
  if (back) back.hidden = !location.hash.includes('from=workspace');
};

export const openWorkspaceDiscussion = (_subjects = [], prompt = '') => {
  if (prompt) sessionStorage.setItem('luoome:chat-prompt', prompt);
  location.hash = '#chat?from=workspace';
};

export const initInvestmentWorkspace = () => {
  if (initialized) return;
  initialized = true;
  const date = $('#workspace-date');
  if (date) {
    date.textContent = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: 'long',
      day: 'numeric',
      weekday: 'long',
    }).format(new Date());
  }
  $('#workspace-ask')?.addEventListener('click', () => void openWorkspaceDiscussion());
  document.querySelectorAll('[data-workspace-prompt]').forEach((button) => {
    button.addEventListener(
      'click',
      () => void openWorkspaceDiscussion([], button.dataset.workspacePrompt),
    );
  });
  $('#workspace-expand')?.addEventListener('click', () => {
    location.hash = '#chat?from=workspace';
  });
  $('#chat-return')?.addEventListener('click', () => history.back());
  document.addEventListener('luoome:identity-cleared', () => {
    version += 1;
    for (const id of [
      'workspace-holdings',
      'workspace-directions',
      'workspace-plans',
      'workspace-tracking',
      'workspace-facts',
    ]) {
      $(`#${id}`)?.replaceChildren();
    }
  });
  document.addEventListener('luoome:workspace-updated', () => void renderInvestmentWorkspace());
};

// re-export for callers that still mount chat inline
export { initChat };
