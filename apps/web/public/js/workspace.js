import { callApi, getAccountId, getSessionEpoch } from './api.js';
import { initChat, mountChatView } from './chat.js';
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

const planRows = (plans, views) => {
  const list = Array.isArray(plans) ? plans : Array.isArray(views) ? views : [];
  if (list.length === 0) return [emptyCard('没有生效中的 TradingPlan。')];
  return list
    .slice(0, 5)
    .map((plan) =>
      card(plan.name ?? plan.title ?? 'TradingPlan', [
        row('状态', plan.status ?? '--'),
        row('版本', plan.version ?? plan.versionId ?? '--'),
        row('复核', plan.reviewAt === undefined ? '--' : fmtDateTime(plan.reviewAt)),
      ]),
    );
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
  mount(
    $('#workspace-plans'),
    el('div', 'workspace-card-grid', planRows(planData?.plans, planData?.views)),
  );
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
