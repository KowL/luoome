// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { consumeUIMessageStream } from './ai-ui-stream.js';
import {
  acceptApiResponse,
  apiHeaders,
  apiRequestSignal,
  callApi,
  getAccountId,
  getSessionEpoch,
  randomRequestId,
} from './api.js';
import { alertDialog, confirmDialog, promptDialog } from './modal.js';
import { $, adviceCard, el, mount, resultErrorText } from './ui.js';

const feed = [];
let sessions = [];
let activeSessionId = null;
let sending = false;
let initialized = false;
let activeAccountId = null;
let activeController = null;
let viewVersion = 0;
let settling = false;
let activeSubjects = [];
let followOutput = true;
let restoredIdentity = null;
let activeMessageCount = 0;
let olderCursor = null;
let hasOlderMessages = false;
let loadingOlder = false;
const renderedEntries = new WeakMap();
const CHAT_RECOVERY_KEY = 'luoome.workspace.chat';
const CHAT_LAUNCH_KEY = 'luoome:chat-launch';
const MAX_CONTEXT_MESSAGES = 20;
const MESSAGE_PAGE_SIZE = 50;
const chatIdentity = () => `local:${getAccountId()}`;
const saveChatView = () => {
  try {
    const previous = recoverChatView();
    const drafts = { ...(previous?.drafts ?? {}) };
    if (previous?.draft !== undefined && previous?.sessionId)
      drafts[previous.sessionId] = previous.draft;
    drafts[activeSessionId ?? 'new'] = $('#chat-input')?.value ?? '';
    sessionStorage.setItem(
      CHAT_RECOVERY_KEY,
      JSON.stringify({
        identity: chatIdentity(),
        sessionId: activeSessionId,
        subjects: activeSubjects,
        drafts,
      }),
    );
  } catch {
    /* 当前浏览器不支持草稿恢复。 */
  }
};
const recoverChatView = () => {
  try {
    const value = JSON.parse(sessionStorage.getItem(CHAT_RECOVERY_KEY) ?? 'null');
    if (value?.identity === chatIdentity()) return value;
    sessionStorage.removeItem(CHAT_RECOVERY_KEY);
  } catch {
    /* 无可恢复草稿。 */
  }
  return null;
};
const resizeChatInput = () => {
  const input = $('#chat-input');
  if (input === null || input.style === undefined || typeof input.scrollHeight !== 'number') return;
  input.style.height = 'auto';
  const height = Math.min(input.scrollHeight, 180);
  input.style.height = `${height}px`;
  input.style.overflowY = input.scrollHeight > 180 ? 'auto' : 'hidden';
};

const consumeChatLaunch = () => {
  try {
    const value = JSON.parse(sessionStorage.getItem(CHAT_LAUNCH_KEY) ?? 'null');
    sessionStorage.removeItem(CHAT_LAUNCH_KEY);
    return value?.identity === chatIdentity() ? value : null;
  } catch {
    return null;
  }
};
const renderSubjects = () => {
  const node = $('#chat-subjects');
  if (node !== null)
    mount(
      node,
      activeSubjects.length === 0
        ? '全局讨论'
        : activeSubjects.map((item) => el('span', 'chat-subject-chip', item.label)),
    );
  const clear = $('#chat-clear-subjects');
  if (clear !== null) clear.hidden = activeSubjects.length === 0;
};
const setDiscussionSubjects = (subjects) => {
  if (sending || settling) return false;
  activeSubjects = subjects.slice(0, 4);
  renderSubjects();
  saveChatView();
  return true;
};
const mountChatView = () => {
  const workspace = $('#chat-workspace');
  const host = $('#route-chat');
  if (workspace === null || host === null) return;
  host.append(workspace);
  renderSubjects();
};
const setSessionsOpen = (open) => {
  $('#chat-session-rail')?.classList.toggle('sessions-open', open);
  $('#chat-sessions-toggle')?.setAttribute('aria-expanded', String(open));
  $('#sidebar-sessions-toggle')?.setAttribute('aria-expanded', String(open));
};
const resetChatIdentity = () => {
  viewVersion += 1;
  activeController?.abort();
  activeController = null;
  sending = false;
  settling = false;
  activeAccountId = null;
  activeSessionId = null;
  activeSubjects = [];
  activeMessageCount = 0;
  olderCursor = null;
  hasOlderMessages = false;
  restoredIdentity = null;
  feed.splice(0);
  sessions = [];
  try {
    sessionStorage.removeItem(CHAT_RECOVERY_KEY);
    sessionStorage.removeItem(CHAT_LAUNCH_KEY);
  } catch {
    /* 无可清理。 */
  }
  const input = $('#chat-input');
  if (input !== null) {
    input.value = '';
    resizeChatInput();
  }
  renderSubjects();
  renderSessions();
  renderChat();
};

const TOOL_LABELS = {
  fetch_quote: '读取行情',
  web_fetch: '读取网页',
  create_account: '创建账户',
  add_holding: '登记持仓',
  update_holding: '更新持仓',
  close_holding: '关闭持仓',
  create_portfolio_cash_flow: '登记资金流水',
  create_strategy: '创建 Strategy',
  create_strategy_version: '创建 Strategy 版本',
  publish_strategy_version: '发布 Strategy 版本',
  pause_strategy: '暂停 Strategy',
  trial_strategy: '试跑 Strategy',
  run_strategy: '正式运行 Strategy',
  create_watchlist: '创建 Watchlist',
  update_watchlist: '更新 Watchlist',
  archive_watchlist: '归档 Watchlist',
  add_watchlist_member: '添加 Watchlist 成员',
  add_watchlist_members: '批量添加 Watchlist 成员',
  update_watchlist_member: '更新 Watchlist 成员',
  archive_watchlist_member: '归档 Watchlist 成员',
  create_alert_plan: '创建 AlertPlan',
  update_alert_plan: '更新 AlertPlan',
  delete_alert_plan: '删除 AlertPlan',
  analyze_stock: '分析个股',
  analyze_position: '分析持仓',
  market_outlook: '市场观点',
};

const toolLabel = (tool) => TOOL_LABELS[tool] ?? tool;
const trimLeadingChatWhitespace = (text) => text.trimStart();

const SCENARIO_LABELS = {
  research: '股票研究',
  portfolio: '持仓与风险',
  watch: '观察盯盘',
  review: '复盘',
  general: '通用问答',
};

// 计划卡只展示确定性路由与场景模板数据，不涉及模型思维链。
const planCardLines = (route) => {
  const lines = [];
  if (Array.isArray(route?.plannedDimensions) && route.plannedDimensions.length > 0) {
    lines.push(`将查询：${route.plannedDimensions.join(' → ')}`);
  }
  if (route?.needsAdvice === true) lines.push('可能生成建议');
  if (route?.involvesWrite === true) lines.push('可能生成待确认草案');
  return lines;
};

const planCard = (route) => {
  const card = el('div', 'chat-plan');
  card.append(
    el('div', 'chat-plan-title', `计划 · ${SCENARIO_LABELS[route.scenario] ?? route.scenario}`),
  );
  card.append(el('p', 'chat-plan-detail', planCardLines(route).join('；')));
  return card;
};

const parseChatRouteHeader = (value) => {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const route = JSON.parse(decodeURIComponent(value));
    return typeof route?.scenario === 'string' ? route : null;
  } catch {
    return null;
  }
};

const legacySettlementText = (text) => {
  const match = text.trimStart().match(/^\[草案处理记录\] (?:ok|fail) \S+ (.*)$/s);
  return match?.[1] ?? null;
};

const draftFromPart = (part, context) => {
  if (part.output?.__luoomeDraft !== true || part.output.draft === undefined) return null;
  return { ...part.output.draft, ...context, toolCallId: part.toolCallId };
};

const settlementText = (settlement) => {
  if (settlement.status === 'cancelled') return '已取消，未执行';
  if (settlement.status === 'executing')
    return '执行中；若页面或进程曾中断，请核对实际账本后可取消该草案';
  if (settlement.status === 'succeeded') {
    return `${toolLabel(settlement.tool)}执行成功`;
  }
  const reason = resultErrorText(settlement.result, '未知错误');
  if (reason.includes('consensus_version_conflict'))
    return '共识已被其它页面更新。请回首页核对最新版本，再重新提出草案。';
  return `执行失败：${reason}`;
};

const isSettled = (draft) =>
  ['succeeded', 'failed', 'cancelled'].includes(draft.settlement?.status);

const usageText = (metadata) => {
  const usage = metadata?.usage;
  if (usage === undefined) return '';
  const values = [];
  if (typeof usage.inputTokens === 'number') values.push(`输入 ${usage.inputTokens}`);
  if (typeof usage.outputTokens === 'number') values.push(`输出 ${usage.outputTokens}`);
  if (typeof usage.totalTokens === 'number') values.push(`合计 ${usage.totalTokens} tokens`);
  return values.join(' · ');
};

const draftDecisionPath = (draft) =>
  `/api/chat/sessions/${encodeURIComponent(draft.sessionId)}/drafts/${encodeURIComponent(draft.messageId)}/${encodeURIComponent(draft.toolCallId)}`;

const settleDraft = async (draft, approved) => {
  if (sending || settling || isSettled(draft)) return;
  const version = viewVersion;
  settling = true;
  draft.error = null;
  renderChat();
  const response = await callApi(draftDecisionPath(draft), {
    method: 'POST',
    headers: apiHeaders(undefined, draft.accountId),
    body: JSON.stringify({ approved }),
  });
  if (version !== viewVersion) return;
  settling = false;
  if (response.ok) draft.settlement = response.data;
  else draft.error = resultErrorText(response, '请求未完成，请刷新会话后重试');
  renderChat();
  // 执行回执已由草案卡片展示，不再自动追加一轮模型调用。
  if (response.ok) document.dispatchEvent(new Event('luoome:workspace-updated'));
};

const DRAFT_FIELD_SOURCE_LABELS = { default: '默认', inferred: '推断' };

const formatDraftFieldValue = (value) => {
  if (Array.isArray(value)) return value.map(formatDraftFieldValue).join('、');
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value))
    return new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
  return String(value ?? '—');
};

// display 投影渲染：targetObject + 字段表（来源标记）+ 不支持/歧义警示。
// 无 display 的历史草案回落到 summary + raw JSON。
const draftDisplayNode = (display) => {
  const wrap = el('div', 'chat-draft-display');
  wrap.append(el('p', 'chat-draft-target', String(display.targetObject ?? '')));
  const fields = Array.isArray(display.fields) ? display.fields : [];
  if (fields.length > 0) {
    wrap.append(
      el(
        'ul',
        'chat-draft-fields',
        fields.map((f) => {
          const badge = DRAFT_FIELD_SOURCE_LABELS[f?.source];
          return el(
            'li',
            null,
            `${String(f?.name ?? '')}: ${formatDraftFieldValue(f?.value)}${badge ? `（${badge}）` : ''}`,
          );
        }),
      ),
    );
  }
  for (const item of Array.isArray(display.unsupported) ? display.unsupported : []) {
    wrap.append(el('p', 'chat-draft-warn', `不支持：${String(item)}`));
  }
  for (const item of Array.isArray(display.ambiguous) ? display.ambiguous : []) {
    wrap.append(el('p', 'chat-draft-warn', `注意：${String(item)}`));
  }
  return wrap;
};

// 「编辑」= 预填修正：把 display 字段摘要转成自然语言预填进输入框，模型重新生成草案。
const draftEditPrefill = (draft) => {
  const fields = Array.isArray(draft.display?.fields) ? draft.display.fields : [];
  const summary = fields
    .map((f) => `${String(f?.name ?? '')}=${formatDraftFieldValue(f?.value)}`)
    .join('，');
  const target = draft.display?.targetObject ?? toolLabel(draft.tool);
  return `请修改刚才的草案（${String(target)}）${summary.length > 0 ? `：${summary}` : ''}，我想改为：`;
};

const draftCard = (draft) => {
  const card = el('div', 'chat-draft');
  card.append(el('div', 'chat-draft-title', `待确认 · ${toolLabel(draft.tool)}`));
  if (draft.display !== undefined && draft.display !== null) {
    card.append(draftDisplayNode(draft.display));
  } else {
    card.append(el('p', 'chat-draft-summary', String(draft.summary ?? '')));
    card.append(el('pre', 'chat-draft-input', JSON.stringify(draft.input ?? {}, null, 2)));
  }
  if (draft.settlement !== undefined) {
    card.append(
      el(
        'p',
        draft.settlement.status === 'succeeded' ? 'chat-draft-settled ok' : 'chat-draft-settled',
        settlementText(draft.settlement),
      ),
    );
    if (isSettled(draft)) {
      card.firstElementChild.textContent = `操作记录 · ${toolLabel(draft.tool)}`;
      const advice = draft.settlement.result?.ok ? draft.settlement.result.data?.advice : null;
      if (advice !== null && advice !== undefined) card.append(adviceCard(advice));
      return card;
    }
  }
  if (!draft.sessionId || !draft.messageId || !draft.toolCallId) {
    card.append(el('p', 'chat-draft-warn', '该历史草案缺少执行标识，请让助手重新生成。'));
    return card;
  }
  if (draft.error) card.append(el('p', 'chat-draft-warn', draft.error));
  const executing = draft.settlement?.status === 'executing';
  const buttons = [];
  if (executing) {
    // executing 不会自行推进：核对账本后可显式取消（终态），再让助手重新生成草案。
    const cancelExecutingBtn = el('button', 'btn btn-outline btn-sm', '取消该草案');
    cancelExecutingBtn.type = 'button';
    cancelExecutingBtn.disabled = sending || settling;
    cancelExecutingBtn.addEventListener('click', () => void settleDraft(draft, false));
    buttons.push(cancelExecutingBtn);
  } else {
    const confirmBtn = el('button', 'btn btn-primary btn-sm', '确认执行');
    confirmBtn.type = 'button';
    confirmBtn.disabled = sending || settling;
    confirmBtn.addEventListener('click', () => void settleDraft(draft, true));
    buttons.push(confirmBtn);
    const editBtn = el('button', 'btn btn-outline btn-sm', '修改要求');
    editBtn.type = 'button';
    editBtn.disabled = sending || settling;
    editBtn.addEventListener('click', () => {
      const input = $('#chat-input');
      if (input !== null) {
        input.value = draftEditPrefill(draft);
        input.focus();
        resizeChatInput();
      }
    });
    const cancelBtn = el('button', 'btn btn-outline btn-sm', '取消');
    cancelBtn.type = 'button';
    cancelBtn.disabled = sending || settling;
    cancelBtn.addEventListener('click', () => void settleDraft(draft, false));
    buttons.push(editBtn, cancelBtn);
  }
  card.append(el('div', 'chat-draft-actions', buttons));
  if (sending) card.append(el('p', 'chat-draft-settled', '回复保存后即可确认'));
  return card;
};

const actionStatus = (action) =>
  action.status === 'running'
    ? '处理中'
    : action.output?.__luoomeOutputOmitted === true
      ? '结果已省略'
      : action.ok
        ? action.draft
          ? '草案已生成'
          : '已完成'
        : '未完成';

const actionDetails = (action) => {
  const output = action.output?.data ?? action.output;
  if (output === null || typeof output !== 'object') return [];
  const details = [];
  if (output.__luoomeOutputOmitted === true && typeof output.message === 'string')
    details.push(output.message);
  for (const key of ['summary', 'source', 'asOf', 'fetchedAt']) {
    if (typeof output[key] === 'string' && output[key].length > 0)
      details.push(
        `${{ summary: '摘要', source: '来源', asOf: '数据时间', fetchedAt: '读取时间' }[key]}：${output[key]}`,
      );
  }
  if (typeof action.output?.error?.message === 'string')
    details.push(`失败原因：${action.output.error.message}`);
  return details;
};

const actionSourceUrl = (action) => {
  const output = action.output?.data ?? action.output;
  const value = output?.url ?? output?.link;
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
};

const usedActionsNode = (usedActions) => {
  const details = el('details', 'chat-used-actions');
  const running = usedActions.filter((action) => action.status === 'running').length;
  details.append(
    el('summary', null, [
      el('span', 'chat-used-actions-title', `执行过程 · ${usedActions.length} 步`),
      el(
        'span',
        `chat-action-summary-state${running > 0 ? ' running' : ''}`,
        running > 0 ? `${running} 项处理中` : '查看工具与数据来源',
      ),
    ]),
  );
  details.append(
    el(
      'ol',
      'chat-action-steps',
      usedActions.map((action, index) => {
        const item = el('li', `chat-action-step${action.status === 'running' ? ' running' : ''}`);
        item.append(
          el('div', 'chat-action-step-head', [
            el('span', 'chat-action-step-index', String(index + 1).padStart(2, '0')),
            el('span', 'chat-action-step-name', toolLabel(action.tool)),
            el('span', `chat-action-step-status${action.ok ? ' ok' : ''}`, actionStatus(action)),
          ]),
        );
        for (const detail of actionDetails(action))
          item.append(el('p', 'chat-action-detail', detail));
        const source = actionSourceUrl(action);
        if (source !== null) {
          const link = el('a', 'chat-evidence-source', '打开原始来源 ↗');
          link.href = source;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          item.append(link);
        }
        return item;
      }),
    ),
  );
  return details;
};

const copyMessage = async (entry, button) => {
  try {
    await navigator.clipboard.writeText(entry.content);
    button.textContent = '已复制';
  } catch {
    button.textContent = '复制失败';
  }
  setTimeout(() => {
    button.textContent = '复制';
  }, 1600);
};

const formatMessageTime = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const pad = (part) => String(part).padStart(2, '0');
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() === now.toDateString()) return clock;
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${clock}`;
};

const renderEntry = (entry) => {
  if (entry.type === 'subjects')
    return el(
      'div',
      'chat-subject-history',
      `讨论：${entry.labels.length > 0 ? entry.labels.join(' / ') : '全局'}`,
    );
  if (entry.type === 'msg') {
    const node = el(
      'div',
      `chat-msg ${entry.role}${entry.failed ? ' failed' : ''}${entry.streaming ? ' streaming' : ''}`,
      [el('span', 'chat-msg-content', entry.content)],
    );
    if (entry.cancelled === true) node.append(el('span', 'chat-cancelled-mark', '已中断'));
    if (entry.failure) node.append(el('p', 'chat-msg-error', entry.failure));
    const footer = el('div', 'chat-msg-footer');
    if (entry.role === 'user' && entry.at !== undefined)
      footer.append(el('time', 'chat-msg-time', formatMessageTime(entry.at)));
    if (entry.content.length > 0 || entry.retry !== undefined) {
      const actions = el('div', 'chat-msg-actions');
      if (entry.content.length > 0) {
        const copy = el('button', 'chat-msg-action', '复制');
        copy.type = 'button';
        copy.addEventListener('click', () => void copyMessage(entry, copy));
        actions.append(copy);
      }
      if (entry.retry !== undefined) {
        const retry = el('button', 'chat-msg-action', '重试回答');
        retry.type = 'button';
        retry.disabled = sending || settling;
        retry.addEventListener('click', () => void retryMessage(entry));
        const edit = el('button', 'chat-msg-action', '编辑后重发');
        edit.type = 'button';
        edit.disabled = sending || settling;
        edit.addEventListener('click', () => {
          const input = $('#chat-input');
          if (input !== null) {
            input.value = entry.retry.text;
            input.focus();
            resizeChatInput();
            saveChatView();
          }
        });
        actions.append(retry, edit);
      }
      footer.append(actions);
    }
    if (footer.childNodes.length > 0) node.append(footer);
    return node;
  }
  if (entry.type === 'note') return el('div', 'chat-msg system', entry.text);
  if (entry.type === 'status') {
    return el('div', 'chat-msg system chat-stream-status', entry.text);
  }
  if (entry.type === 'actions') return usedActionsNode(entry.usedActions);
  if (entry.type === 'plan') return planCard(entry.route);
  if (entry.type === 'usage') return el('p', 'chat-usage', usageText(entry.metadata));
  return el('div', 'chat-drafts', entry.drafts.map(draftCard));
};

const emptyState = () => {
  const labels = activeSubjects.map((item) => item.label).join('、');
  const suggestions =
    labels.length > 0
      ? [
          `核对${labels}的最新事实，说明数据时间和缺口`,
          `围绕${labels}整理支持依据、反证和主要风险`,
          `总结${labels}当前结论的有效期与下一步`,
        ]
      : [
          '检查我的持仓、可用资金与集中度风险',
          '研究一个参与方向，先说明证据与覆盖范围',
          '核对当前计划的有效版本、等待条件和跟踪状态',
          '复盘近期建议与实际结果',
        ];
  const chips = suggestions.map((text) => {
    const button = el('button', 'chat-suggestion', text);
    button.type = 'button';
    button.addEventListener('click', () => {
      const input = $('#chat-input');
      if (input !== null) {
        input.value = text;
        input.focus();
        resizeChatInput();
        saveChatView();
      }
    });
    return button;
  });
  return el('div', 'chat-empty-state', [
    el('div', 'chat-empty-mark', '◇'),
    el('span', 'section-kicker', 'LOCAL ADVISOR'),
    el('h2', null, labels.length > 0 ? `正在讨论：${labels}` : '用对话管理你的投资'),
    el(
      'p',
      null,
      '查询持仓、整理研究、管理资金与盯盘。助手先核对事实，修改经你确认后执行，再说明实际结果。',
    ),
    el('div', 'chat-suggestions', chips),
  ]);
};

let evidenceOpen = false;

const renderEvidence = () => {
  const panel = $('#chat-evidence-panel');
  const content = $('#chat-evidence-content');
  if (panel === null || content === null) return;
  const sections = [];
  if (activeSubjects.length > 0)
    sections.push(
      el('section', 'chat-evidence-section', [
        el('h3', null, '讨论对象'),
        el(
          'ul',
          null,
          activeSubjects.map((item) => el('li', null, item.label)),
        ),
      ]),
    );
  const plans = feed.filter((entry) => entry.type === 'plan');
  if (plans.length > 0)
    sections.push(
      el('section', 'chat-evidence-section', [
        el('h3', null, '研究计划'),
        el(
          'ul',
          null,
          plans.flatMap((entry) => planCardLines(entry.route).map((line) => el('li', null, line))),
        ),
      ]),
    );
  const actions = feed
    .filter((entry) => entry.type === 'actions')
    .flatMap((entry) => entry.usedActions);
  if (actions.length > 0)
    sections.push(
      el('section', 'chat-evidence-section', [
        el('h3', null, '工具产物与来源'),
        el(
          'ul',
          null,
          actions.map((action) => {
            const item = el('li', null, `${toolLabel(action.tool)} · ${actionStatus(action)}`);
            for (const detail of actionDetails(action))
              item.append(el('p', 'chat-action-detail', detail));
            const source = actionSourceUrl(action);
            if (source !== null) {
              const link = el('a', 'chat-evidence-source', '打开原始来源');
              link.href = source;
              link.target = '_blank';
              link.rel = 'noopener noreferrer';
              item.append(link);
            }
            return item;
          }),
        ),
      ]),
    );
  const advice = feed
    .filter((entry) => entry.type === 'drafts')
    .flatMap((entry) => entry.drafts)
    .map((draft) => draft.settlement?.result?.data?.advice)
    .filter((item) => item !== undefined && item !== null);
  for (const item of advice) {
    const evidence = item.reasoning?.evidence ?? [];
    const counter = item.reasoning?.counterEvidence ?? [];
    const risks = item.risks ?? [];
    sections.push(
      el('section', 'chat-evidence-section', [
        el('h3', null, '建议依据与风险'),
        ...(evidence.length > 0
          ? [
              el(
                'ul',
                null,
                evidence.map((line) => el('li', null, line)),
              ),
            ]
          : []),
        ...(counter.length > 0
          ? [
              el('h3', null, '反证'),
              el(
                'ul',
                null,
                counter.map((line) => el('li', null, line)),
              ),
            ]
          : []),
        ...(risks.length > 0
          ? [
              el('h3', null, '风险'),
              el(
                'ul',
                null,
                risks.map((line) => el('li', null, line)),
              ),
            ]
          : []),
      ]),
    );
  }
  const hasContent = sections.length > 0;
  panel.hidden = !evidenceOpen || !hasContent;
  $('#chat-workspace')?.classList.toggle('evidence-open', !panel.hidden);
  const toggle = $('#chat-evidence-toggle');
  if (toggle !== null) {
    toggle.disabled = !hasContent;
    toggle.classList.toggle('active', !panel.hidden);
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
    toggle.setAttribute('aria-selected', String(!panel.hidden));
  }
  const dialogTab = $('#chat-dialog-tab');
  if (dialogTab !== null) {
    dialogTab.classList.toggle('active', panel.hidden);
    dialogTab.setAttribute('aria-selected', String(panel.hidden));
  }
  mount(
    content,
    hasContent ? sections : el('p', 'muted', '发起研究后，这里会显示讨论对象、计划和真实依据。'),
  );
};

const renderChat = () => {
  const log = $('#chat-log');
  if (log === null) return;
  const previousTop = log.scrollTop;
  const nodes =
    feed.length === 0
      ? [emptyState()]
      : feed.map((entry) => {
          const signature = JSON.stringify(
            entry.type === 'drafts' || entry.type === 'msg' ? [entry, sending, settling] : entry,
          );
          let rendered = renderedEntries.get(entry);
          if (rendered?.signature !== signature) {
            rendered = { signature, node: renderEntry(entry) };
            renderedEntries.set(entry, rendered);
          }
          return rendered.node;
        });
  nodes.forEach((node, index) => {
    if (log.childNodes[index] !== node) log.insertBefore(node, log.childNodes[index] ?? null);
  });
  while (log.childNodes.length > nodes.length) log.lastChild.remove();
  log.scrollTop = followOutput ? log.scrollHeight : previousTop;
  const newContent = $('#chat-new-content');
  if (newContent !== null) newContent.hidden = followOutput || !sending;
  const sendButton = $('#chat-send');
  if (sendButton !== null) sendButton.disabled = sending || settling;
  const newButton = $('#chat-new-session');
  if (newButton !== null) newButton.disabled = sending || settling;
  const older = $('#chat-load-older');
  if (older !== null) {
    older.hidden = !hasOlderMessages;
    older.disabled = loadingOlder;
    older.textContent = loadingOlder ? '正在读取…' : '加载更早消息';
  }
  const handoff = $('#chat-handoff');
  if (handoff !== null) {
    handoff.hidden = activeMessageCount < MAX_CONTEXT_MESSAGES - 4;
    const text = $('#chat-handoff-text');
    if (text !== null)
      text.textContent =
        activeMessageCount >= MAX_CONTEXT_MESSAGES
          ? '当前会话已到本轮上下文上限，请通过交接摘要继续。'
          : '当前会话接近本轮上下文上限，可提前整理交接摘要。';
  }
  renderEvidence();
  log.setAttribute('aria-busy', String(sending || settling));
};

const formatSessionTime = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const elapsed = Date.now() - date.getTime();
  if (elapsed >= 0) {
    const minutes = Math.floor(elapsed / 60_000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} 天前`;
  }
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
};

const renameSession = async (session) => {
  if (sending || settling) return;
  const values = await promptDialog({
    title: '重命名会话',
    fields: [{ key: 'title', label: '会话名称', value: session.title }],
    confirmLabel: '重命名',
  });
  const title = values?.title;
  if (title === undefined || title.length === 0 || title === session.title) return;
  const result = await callApi(`/api/chat/sessions/${encodeURIComponent(session.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
  if (!result.ok) {
    await alertDialog('重命名失败', resultErrorText(result, '未知错误'));
    return;
  }
  await refreshSessions();
};

const deleteSession = async (session) => {
  if (sending || settling) return;
  const confirmed = await confirmDialog({
    title: '删除会话',
    message: `只删除会话「${session.title}」及其消息，不删除关联标的、组合、预警、研究产物或已确认的投资记录。`,
    confirmLabel: '删除',
    danger: true,
  });
  if (!confirmed) return;
  const result = await callApi(`/api/chat/sessions/${encodeURIComponent(session.id)}`, {
    method: 'DELETE',
  });
  if (!result.ok) {
    await alertDialog('删除失败', resultErrorText(result, '未知错误'));
    return;
  }
  if (activeSessionId === session.id) {
    activeSessionId = null;
    activeSubjects = [];
    activeMessageCount = 0;
    olderCursor = null;
    hasOlderMessages = false;
    feed.splice(0);
    const input = $('#chat-input');
    if (input !== null) {
      input.value = draftFor('new');
      resizeChatInput();
    }
    renderSubjects();
  }
  await refreshSessions();
  renderChat();
  saveChatView();
};

const renderSessions = () => {
  const list = $('#chat-session-list');
  if (list === null) return;
  mount(
    list,
    sessions.length === 0
      ? el('p', 'chat-session-empty', '还没有会话')
      : sessions.map((session) => {
          const open = el('button', 'chat-session-open', [
            el('span', 'chat-session-title', session.title),
            el(
              'span',
              'chat-session-time',
              sending && session.id === activeSessionId
                ? '正在回答…'
                : formatSessionTime(session.updatedAt),
            ),
          ]);
          open.type = 'button';
          open.disabled = sending || settling;
          open.addEventListener('click', () => void selectSession(session.id));
          const rename = el('button', 'chat-session-action', '✎');
          rename.type = 'button';
          rename.title = '重命名';
          rename.disabled = sending || settling;
          rename.addEventListener('click', () => void renameSession(session));
          const remove = el('button', 'chat-session-action danger', '×');
          remove.type = 'button';
          remove.title = '删除';
          remove.disabled = sending || settling;
          remove.addEventListener('click', () => void deleteSession(session));
          return el('div', `chat-session-item${session.id === activeSessionId ? ' active' : ''}`, [
            open,
            el('div', 'chat-session-actions', [rename, remove]),
          ]);
        }),
  );
};

const subjectKey = (labels) => labels.join('\u0000');

const appendSubjectEntry = (feed, labels) => {
  const last = feed.findLast((entry) => entry.type === 'subjects');
  if (last !== undefined && subjectKey(last.labels) === subjectKey(labels)) return;
  feed.push({ type: 'subjects', labels });
};

const persistedFeed = (messages, context = {}) => {
  const result = [];
  for (const message of messages) {
    const text = message.parts
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
    const legacyText = legacySettlementText(text);
    if (legacyText !== null) {
      result.push({ type: 'note', text: `历史处理记录：${legacyText}` });
      continue;
    }
    const visibleText = trimLeadingChatWhitespace(text);
    const cancelled =
      message.role === 'assistant' &&
      message.parts.some((part) => part.type === 'data-luoome-cancelled');
    const streamError = message.parts.find((part) => part.type === 'data-luoome-stream-error');
    if (visibleText.trim().length > 0 || cancelled || streamError !== undefined) {
      const subjectPart = message.parts.find((part) => part.type === 'data-luoome-subjects');
      if (subjectPart !== undefined) appendSubjectEntry(result, subjectPart.data?.labels ?? []);
      const createdAt = message.createdAt === undefined ? null : new Date(message.createdAt);
      result.push({
        type: 'msg',
        messageId: message.id,
        role: message.role,
        content: visibleText || (streamError === undefined ? '回答已中断。' : '回答未完成。'),
        ...(createdAt !== null && !Number.isNaN(createdAt.getTime())
          ? { at: createdAt.toISOString() }
          : {}),
        ...(cancelled ? { cancelled: true } : {}),
        ...(streamError !== undefined
          ? {
              failed: true,
              failure: String(
                streamError.data?.message ?? '回答未完成，请重试；系统不会自动重发操作。',
              ),
            }
          : {}),
      });
    }
    if (message.role !== 'assistant') continue;
    const settlements = new Map(
      message.parts
        .filter((part) => part.type === 'data-luoome-draft-settlement')
        .map((part) => [part.data?.toolCallId, part.data]),
    );
    const actions = [];
    const drafts = [];
    for (const part of message.parts) {
      if (part.type === 'data-luoome-runtime' && typeof part.data?.notice === 'string')
        result.push({ type: 'note', text: part.data.notice });
      if (part.type === 'data-luoome-usage') result.push({ type: 'usage', metadata: part.data });
      if (typeof part.type !== 'string' || !part.type.startsWith('tool-')) continue;
      const output = part.output;
      actions.push({
        toolCallId: part.toolCallId,
        tool: part.type.slice(5),
        input: part.input,
        output,
        status: ['input-streaming', 'input-available'].includes(part.state)
          ? 'running'
          : 'finished',
        ok: part.state === 'output-available' && output?.error === undefined,
        draft: output?.__luoomeDraft === true,
      });
      const draft = draftFromPart(part, { ...context, messageId: message.id });
      if (draft !== null) {
        const settlement = settlements.get(part.toolCallId);
        if (settlement !== undefined) draft.settlement = settlement;
        drafts.push(draft);
      }
    }
    if (actions.length > 0) result.push({ type: 'actions', usedActions: actions });
    if (drafts.length > 0) result.push({ type: 'drafts', drafts });
  }
  let lastUser = null;
  let retryEntry = null;
  for (const entry of result) {
    if (entry.type !== 'msg') continue;
    if (entry.role === 'user') {
      if (retryEntry !== null) delete retryEntry.retry;
      retryEntry = null;
      lastUser = entry;
      continue;
    }
    if ((entry.cancelled === true || entry.failed === true) && lastUser?.messageId !== undefined) {
      if (retryEntry !== null) delete retryEntry.retry;
      entry.retry = { text: lastUser.content, messageId: lastUser.messageId };
      retryEntry = entry;
    } else if (retryEntry !== null) {
      delete retryEntry.retry;
      retryEntry = null;
    }
  }
  if (
    context.suppressPendingNote !== true &&
    messages.at(-1)?.role === 'user' &&
    legacySettlementText(
      messages
        .at(-1)
        .parts.filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(''),
    ) === null
  ) {
    const pending = result.findLast((entry) => entry.type === 'msg' && entry.role === 'user');
    result.push({
      type: 'msg',
      role: 'assistant',
      failed: true,
      content: '这个问题已保存，回答尚未完成或已中断。可重试回答；系统不会自动重发操作。',
      ...(pending?.messageId === undefined
        ? {}
        : { retry: { text: pending.content, messageId: pending.messageId } }),
    });
  }
  return result;
};

const draftFor = (sessionId) => {
  const recovery = recoverChatView();
  if (recovery?.drafts?.[sessionId] !== undefined) return recovery.drafts[sessionId];
  return recovery?.sessionId === sessionId ? (recovery.draft ?? '') : '';
};

const selectSession = async (sessionId) => {
  if (sending || settling) return;
  if (sessionId === activeSessionId) {
    if (!location.hash.startsWith('#chat')) location.hash = '#chat';
    return;
  }
  saveChatView();
  const version = viewVersion;
  const accountId = activeAccountId ?? getAccountId();
  const result = await callApi(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}?limit=${MESSAGE_PAGE_SIZE}`,
  );
  if (version !== viewVersion) return;
  if (!result.ok) {
    await alertDialog('读取会话失败', resultErrorText(result, '未知错误'));
    return;
  }
  const messages = result.data.messages ?? [];
  activeSessionId = sessionId;
  activeMessageCount = messages.length + (result.data.hasMore ? MESSAGE_PAGE_SIZE : 0);
  olderCursor = result.data.nextCursor ?? null;
  hasOlderMessages = result.data.hasMore === true;
  const subjectPart = [...messages]
    .reverse()
    .flatMap((message) => message.parts)
    .find((part) => part.type === 'data-luoome-subjects');
  activeSubjects =
    subjectPart?.data?.refs === undefined
      ? []
      : subjectPart.data.refs.map((ref, index) => ({
          ref,
          label: subjectPart.data.labels?.[index] ?? ref.id,
        }));
  feed.splice(
    0,
    feed.length,
    ...persistedFeed(messages, {
      sessionId,
      accountId,
    }),
  );
  const input = $('#chat-input');
  if (input !== null) {
    input.value = draftFor(sessionId);
    resizeChatInput();
  }
  setSessionsOpen(false);
  renderSessions();
  renderSubjects();
  renderChat();
  saveChatView();
  if (!location.hash.startsWith('#chat')) location.hash = '#chat';
};

const refreshSessions = async () => {
  const version = viewVersion;
  const result = await callApi('/api/chat/sessions');
  if (version !== viewVersion) return false;
  if (!result.ok) {
    return false;
  }
  sessions = Array.isArray(result.data?.sessions) ? result.data.sessions : [];
  renderSessions();
  return true;
};

const refreshSessionList = async () => {
  if (sending || settling) return false;
  return refreshSessions();
};

const createSession = async ({ title, subjects = [], draft = '' } = {}) => {
  saveChatView();
  const version = viewVersion;
  const result = await callApi('/api/chat/sessions', {
    method: 'POST',
    body: JSON.stringify(title === undefined ? {} : { title }),
  });
  if (version !== viewVersion) return null;
  if (!result.ok) {
    await alertDialog('创建会话失败', resultErrorText(result, '无法创建会话'));
    return null;
  }
  const session = result.data.session;
  sessions = [session, ...sessions.filter((item) => item.id !== session.id)];
  activeSessionId = session.id;
  activeSubjects = subjects.slice(0, 4);
  activeMessageCount = 0;
  olderCursor = null;
  hasOlderMessages = false;
  feed.splice(0);
  const input = $('#chat-input');
  if (input !== null) {
    input.value = draft;
    resizeChatInput();
  }
  setSessionsOpen(false);
  renderSubjects();
  saveChatView();
  renderSessions();
  renderChat();
  if (!location.hash.startsWith('#chat')) location.hash = '#chat';
  input?.focus();
  return session;
};

const loadOlderMessages = async () => {
  if (loadingOlder || !hasOlderMessages || olderCursor === null || activeSessionId === null) return;
  loadingOlder = true;
  renderChat();
  const version = viewVersion;
  const sessionId = activeSessionId;
  const log = $('#chat-log');
  const previousHeight = log?.scrollHeight ?? 0;
  const previousTop = log?.scrollTop ?? 0;
  try {
    const result = await callApi(
      `/api/chat/sessions/${encodeURIComponent(sessionId)}?limit=${MESSAGE_PAGE_SIZE}&cursor=${encodeURIComponent(olderCursor)}`,
    );
    if (version !== viewVersion || sessionId !== activeSessionId) return;
    if (!result.ok) throw new Error(resultErrorText(result, '读取更早消息失败'));
    const messages = result.data.messages ?? [];
    feed.splice(
      0,
      0,
      ...persistedFeed(messages, {
        sessionId,
        accountId: activeAccountId ?? getAccountId(),
        suppressPendingNote: true,
      }),
    );
    olderCursor = result.data.nextCursor ?? null;
    hasOlderMessages = result.data.hasMore === true;
    followOutput = false;
    renderChat();
    if (log !== null) log.scrollTop = log.scrollHeight - previousHeight + previousTop;
  } catch (error) {
    await alertDialog('读取更早消息失败', error instanceof Error ? error.message : String(error));
  } finally {
    if (version === viewVersion) {
      loadingOlder = false;
      renderChat();
    }
  }
};

const openHandoffSession = async (pendingText = '') => {
  if (sending || settling || activeSessionId === null) return;
  const source = sessions.find((session) => session.id === activeSessionId);
  const transcript = feed
    .filter((entry) => entry.type === 'msg' && !entry.failed)
    .slice(-MAX_CONTEXT_MESSAGES)
    .map((entry) => `${entry.role === 'user' ? '用户' : '助手'}：${entry.content}`)
    .join('\n\n');
  const summary = [
    `来源会话：${source?.title ?? '未命名会话'}（${activeSessionId}）`,
    activeSubjects.length > 0
      ? `讨论对象：${activeSubjects.map((item) => item.label).join('、')}`
      : '讨论对象：全局',
    '最近对话摘录：',
    transcript,
  ]
    .filter((part) => part.length > 0)
    .join('\n\n')
    .slice(0, 7000);
  const values = await promptDialog({
    title: '新建关联会话',
    note: '原会话完整保留。请核对并编辑交接摘要；创建后由你确认发送，不会自动重跑任何操作。',
    fields: [{ key: 'summary', label: '交接摘要', value: summary, multiline: true, rows: 14 }],
    confirmLabel: '创建并预填',
  });
  const handoff = values?.summary?.trim();
  if (handoff === undefined || handoff.length === 0) return;
  const draft = [
    '请基于以下来源会话的交接摘要继续讨论。先核对其中的事实、假设和未完成事项，不要重复执行已经完成的操作。',
    handoff,
    pendingText.trim().length > 0 ? `待继续的问题：${pendingText.trim()}` : '',
  ]
    .filter((part) => part.length > 0)
    .join('\n\n')
    .slice(0, 8000);
  await createSession({
    title: `${source?.title ?? '会话'} · 接续`.slice(0, 80),
    subjects: activeSubjects,
    draft,
  });
};

const removeEntry = (target) => {
  const index = feed.indexOf(target);
  if (index >= 0) feed.splice(index, 1);
};

const retryMessage = async (entry) => {
  if (sending || settling || entry.retry === undefined) return;
  const retry = entry.retry;
  delete entry.retry;
  entry.superseded = true;
  renderChat();
  await send(retry.text, { messageId: retry.messageId, retry: true });
};

const send = async (
  requestedText,
  { messageId = `user_${randomRequestId()}`, retry = false } = {},
) => {
  const input = $('#chat-input');
  if (input === null || sending || settling) return;
  const text = (requestedText ?? input.value).trim();
  if (text.length === 0) return;
  if (!retry && activeMessageCount >= MAX_CONTEXT_MESSAGES) {
    await openHandoffSession(text);
    return;
  }
  sending = true;
  renderSessions();
  const sendBtn = $('#chat-send');
  if (sendBtn !== null) sendBtn.disabled = true;
  const controller = new AbortController();
  activeController = controller;
  const version = viewVersion;
  const accountId = getAccountId();
  const cancelBtn = el('button', 'btn btn-outline btn-sm chat-cancel', '停止');
  cancelBtn.type = 'button';
  cancelBtn.id = 'chat-cancel';
  cancelBtn.addEventListener('click', () => controller.abort());
  const composerBar = $('#chat-form .chat-composer-bar');
  if (composerBar !== null) composerBar.append(cancelBtn);
  else $('#chat-form')?.append(cancelBtn);
  if (sendBtn !== null) sendBtn.hidden = true;
  let assistantEntry = null;
  let sessionId = null;
  let assistantMessageId = null;

  try {
    if (
      activeSessionId === null &&
      (await createSession({ subjects: activeSubjects, draft: input.value })) === null
    )
      return;
    sessionId = activeSessionId;
    if (sessionId === null) return;
    if (requestedText === undefined) input.value = '';
    if (input.value.length === 0) resizeChatInput();
    if (!retry) {
      activeMessageCount += 1;
      if (activeSubjects.length > 0)
        appendSubjectEntry(
          feed,
          activeSubjects.map((item) => item.label),
        );
      feed.push({
        type: 'msg',
        role: 'user',
        messageId,
        content: text,
        at: new Date().toISOString(),
      });
    }
    followOutput = true;
    saveChatView();
    renderChat();
    const statusEntry = { type: 'status', text: '正在连接模型' };
    const actionsEntry = { type: 'actions', usedActions: [] };
    assistantEntry = {
      type: 'msg',
      role: 'assistant',
      content: '',
      cancelled: false,
      streaming: true,
      retry: { text, messageId },
    };
    const toolCalls = new Map();
    let assistantStarted = false;
    feed.push(statusEntry);
    renderChat();

    const ensureAssistant = () => {
      if (assistantStarted) return;
      assistantStarted = true;
      feed.push(assistantEntry);
    };
    const ensureActions = () => {
      if (!feed.includes(actionsEntry)) feed.push(actionsEntry);
    };
    const headers = apiHeaders({ 'content-type': 'application/json' }, accountId);
    const sessionEpoch = getSessionEpoch();
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers,
      signal: apiRequestSignal(controller.signal),
      body: JSON.stringify({
        sessionId,
        subjects: activeSubjects.map((item) => item.ref),
        messages: [
          {
            id: messageId,
            role: 'user',
            parts: [{ type: 'text', text }],
          },
        ],
      }),
    });
    if (!acceptApiResponse(response, sessionEpoch) || version !== viewVersion) return;
    const route = parseChatRouteHeader(response.headers.get('x-luoome-chat-route'));
    if (route !== null) {
      if (route.scenario !== 'general') evidenceOpen = true;
      const previousPlan = retry ? feed.findLast((entry) => entry.type === 'plan') : undefined;
      if (previousPlan !== undefined) previousPlan.route = route;
      else feed.push({ type: 'plan', route });
    }
    await consumeUIMessageStream(response, (part) => {
      if (version !== viewVersion || sessionEpoch !== getSessionEpoch()) return;
      if (part.type === 'start') {
        if (typeof part.messageId === 'string') assistantMessageId = part.messageId;
      } else if (part.type === 'start-step') {
        statusEntry.text = '正在梳理上下文';
      } else if (part.type === 'tool-input-available') {
        statusEntry.text = `正在调用 ${toolLabel(part.toolName)}`;
        evidenceOpen = true;
        const action = {
          toolCallId: part.toolCallId,
          tool: part.toolName,
          input: part.input,
          status: 'running',
          ok: false,
        };
        toolCalls.set(part.toolCallId, action);
        actionsEntry.usedActions.push(action);
        ensureActions();
      } else if (part.type === 'tool-output-available') {
        const action = toolCalls.get(part.toolCallId);
        if (action !== undefined) {
          action.status = 'finished';
          action.ok = part.output?.error === undefined;
          action.draft = part.output?.__luoomeDraft === true;
          action.output = part.output;
        }
        if (part.output?.__luoomeDraft === true && part.output.draft !== undefined) {
          const draft = draftFromPart(part, {
            sessionId,
            messageId: assistantMessageId,
            accountId,
          });
          feed.push({ type: 'drafts', drafts: [draft] });
        }
      } else if (part.type === 'tool-output-error') {
        const action = toolCalls.get(part.toolCallId);
        if (action !== undefined) {
          action.status = 'finished';
          action.ok = false;
          action.output = { error: { message: String(part.errorText ?? '工具执行失败') } };
        }
      } else if (part.type === 'finish' && part.messageMetadata?.usage !== undefined) {
        feed.push({ type: 'usage', metadata: part.messageMetadata });
      } else if (part.type === 'data-luoome-runtime' && typeof part.data?.notice === 'string') {
        if (!feed.some((entry) => entry.type === 'note' && entry.text === part.data.notice))
          feed.push({ type: 'note', text: part.data.notice });
      } else if (part.type === 'data-luoome-usage') {
        feed.push({ type: 'usage', metadata: part.data });
      } else if (part.type === 'abort') {
        controller.abort();
        throw new DOMException('响应已停止', 'AbortError');
      } else if (part.type === 'text-start') {
        statusEntry.text = '正在生成回答';
        ensureAssistant();
      } else if (part.type === 'text-delta') {
        ensureAssistant();
        const delta = String(part.delta ?? '');
        assistantEntry.content +=
          assistantEntry.content.length === 0 ? trimLeadingChatWhitespace(delta) : delta;
      } else if (part.type === 'error') {
        throw new Error(String(part.errorText ?? '模型流式响应失败'));
      }
      renderChat();
    });
    if (version !== viewVersion) return;
    removeEntry(statusEntry);
    activeMessageCount += 1;
    delete assistantEntry.streaming;
    if (assistantEntry.content.trim().length === 0 && toolCalls.size === 0) {
      assistantEntry.content = '模型没有返回内容，请重试。';
      assistantEntry.failed = true;
      ensureAssistant();
    } else {
      delete assistantEntry.retry;
    }
    renderChat();
    await refreshSessions();
  } catch (error) {
    if (version !== viewVersion) return;
    const status = feed.findLast((entry) => entry.type === 'status');
    if (status !== undefined) removeEntry(status);
    activeMessageCount += 1;
    if (assistantEntry !== null) {
      delete assistantEntry.streaming;
      if (controller.signal.aborted) {
        assistantEntry.cancelled = true;
        if (assistantEntry.content.trim().length === 0)
          assistantEntry.content = '回答已停止，已生成的内容以服务端记录为准。';
      } else {
        const reason =
          error instanceof TypeError
            ? '连接中断，请重试；已生成的部分内容会保留在会话中'
            : error instanceof Error
              ? error.message
              : '未知错误';
        assistantEntry.failed = true;
        assistantEntry.failure = `请求失败：${reason}`;
        if (assistantEntry.content.length === 0) assistantEntry.content = '回答未完成。';
      }
      if (!feed.includes(assistantEntry)) feed.push(assistantEntry);
      renderChat();
      await refreshSessions();
    }
  } finally {
    cancelBtn.remove();
    if (activeController === controller) {
      sending = false;
      activeController = null;
      if (sendBtn !== null) {
        sendBtn.hidden = false;
        sendBtn.disabled = false;
      }
      renderSessions();
      renderChat();
      saveChatView();
    }
  }
};

const initChat = () => {
  if (initialized) return;
  initialized = true;
  $('#chat-check-state')?.addEventListener('click', () => void refreshChat());
  $('#chat-clear-subjects')?.addEventListener('click', () => setDiscussionSubjects([]));
  $('#chat-load-older')?.addEventListener('click', () => void loadOlderMessages());
  $('#chat-handoff-open')?.addEventListener('click', () => void openHandoffSession());
  $('#chat-evidence-toggle')?.addEventListener('click', () => {
    evidenceOpen = !evidenceOpen;
    renderEvidence();
  });
  $('#chat-dialog-tab')?.addEventListener('click', () => {
    evidenceOpen = false;
    renderEvidence();
  });
  $('#chat-evidence-close')?.addEventListener('click', () => {
    evidenceOpen = false;
    renderEvidence();
  });
  const toggleSessions = () => {
    const open = !$('#chat-session-rail')?.classList.contains('sessions-open');
    setSessionsOpen(open);
  };
  $('#chat-sessions-toggle')?.addEventListener('click', toggleSessions);
  $('#sidebar-sessions-toggle')?.addEventListener('click', toggleSessions);
  $('#chat-sessions-close')?.addEventListener('click', () => setSessionsOpen(false));
  $('#chat-input')?.addEventListener('input', () => {
    resizeChatInput();
    saveChatView();
  });
  $('#chat-input')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      void send();
    }
  });
  $('#chat-log')?.addEventListener('scroll', (event) => {
    const log = event.currentTarget;
    followOutput = log.scrollHeight - log.clientHeight - log.scrollTop < 60;
    if (followOutput && $('#chat-new-content') !== null) $('#chat-new-content').hidden = true;
  });
  $('#chat-new-content')?.addEventListener('click', () => {
    followOutput = true;
    const log = $('#chat-log');
    if (log !== null) log.scrollTop = log.scrollHeight;
    $('#chat-new-content').hidden = true;
  });
  const syncViewport = () => {
    document.documentElement.style.setProperty(
      '--chat-viewport-height',
      `${window.visualViewport?.height ?? window.innerHeight}px`,
    );
    document.documentElement.style.setProperty(
      '--chat-viewport-top',
      `${window.visualViewport?.offsetTop ?? 0}px`,
    );
  };
  window.visualViewport?.addEventListener('resize', syncViewport);
  window.visualViewport?.addEventListener('scroll', syncViewport);
  syncViewport();
  $('#chat-new-session')?.addEventListener('click', () => {
    if (!sending && !settling) void createSession();
  });
  $('#chat-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void send();
  });
};

const refreshChat = async () => {
  const accountId = getAccountId();
  if (accountId === activeAccountId && (sending || settling)) return;
  const identity = chatIdentity();
  if (restoredIdentity !== null && restoredIdentity !== identity) resetChatIdentity();
  const recovery = recoverChatView();
  const preferredSession = activeSessionId ?? recovery?.sessionId;
  const requestVersion = ++viewVersion;
  activeController?.abort();
  activeController = null;
  sending = false;
  settling = false;
  activeAccountId = accountId;
  restoredIdentity = identity;
  activeSessionId = null;
  const refreshed = await refreshSessions();
  if (requestVersion !== viewVersion) return;
  if (!refreshed) {
    activeSessionId = preferredSession ?? null;
    if (feed.at(-1)?.text !== '连接暂不可用，保留当前已读取内容。恢复后请重新核对会话状态。')
      feed.push({
        type: 'note',
        text: '连接暂不可用，保留当前已读取内容。恢复后请重新核对会话状态。',
      });
    renderChat();
    return;
  }
  const launch = consumeChatLaunch();
  if (launch !== null) {
    const created = await createSession({
      subjects: Array.isArray(launch.subjects) ? launch.subjects : [],
      draft: typeof launch.prompt === 'string' ? launch.prompt : '',
    });
    if (created !== null && launch.send === true) {
      document.dispatchEvent(new Event('luoome:chat-home-draft-clear'));
      await send();
    }
    return;
  }
  const first = sessions.find((session) => session.id === preferredSession) ?? sessions[0];
  if (first !== undefined) await selectSession(first.id);
  else {
    activeSubjects = Array.isArray(recovery?.subjects) ? recovery.subjects : [];
    feed.splice(0);
    const input = $('#chat-input');
    if (input !== null) {
      input.value = draftFor('new');
      resizeChatInput();
    }
    renderSubjects();
    renderChat();
  }
  if (requestVersion !== viewVersion) return;
  saveChatView();
};

globalThis.document?.addEventListener?.('luoome:identity-cleared', resetChatIdentity);

const ensureChatSession = async () => activeSessionId ?? (await createSession())?.id ?? null;

export {
  draftCard,
  draftDecisionPath,
  draftEditPrefill,
  draftFromPart,
  ensureChatSession,
  formatDraftFieldValue,
  initChat,
  mountChatView,
  parseChatRouteHeader,
  persistedFeed,
  planCardLines,
  refreshChat,
  refreshSessionList,
  renderChat,
  saveChatView,
  send,
  setDiscussionSubjects,
  settlementText,
  trimLeadingChatWhitespace,
  usageText,
};
