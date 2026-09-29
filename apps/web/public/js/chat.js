// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { consumeUIMessageStream } from './ai-ui-stream.js';
import { apiHeaders, callApi, getAccountId } from './api.js';
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

const TOOL_LABELS = {
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
  create_research_topic: '创建研究主题',
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
  if (settlement.status === 'succeeded') return `${toolLabel(settlement.tool)}执行成功`;
  return `执行失败：${resultErrorText(settlement.result, '未知错误')}`;
};

const isSettled = (draft) =>
  ['succeeded', 'failed', 'cancelled'].includes(draft.settlement?.status);

const shouldContinueAfterDrafts = (drafts) =>
  drafts.length > 0 &&
  drafts.every(isSettled) &&
  drafts.some((draft) => draft.settlement.status === 'succeeded');

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
  if (!response.ok) return;
  const related = feed
    .filter((entry) => entry.type === 'drafts')
    .flatMap((entry) => entry.drafts)
    .filter((item) => item.messageId === draft.messageId);
  if (shouldContinueAfterDrafts(related)) {
    await send('请根据刚才草案的实际处理结果，说明完成了哪些操作、当前状态和可选的下一步。');
  }
};

const DRAFT_FIELD_SOURCE_LABELS = { default: '默认', inferred: '推断' };

const formatDraftFieldValue = (value) => {
  if (Array.isArray(value)) return value.map(formatDraftFieldValue).join('、');
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
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

const usedActionsNode = (usedActions) => {
  const details = el('details', 'chat-used-actions');
  details.append(
    el('summary', null, `本轮动作：${usedActions.map((action) => action.tool).join('、')}`),
  );
  details.append(
    el(
      'ul',
      null,
      usedActions.map((action) =>
        el(
          'li',
          null,
          `${action.tool} — ${
            action.status === 'running'
              ? '处理中…'
              : action.ok
                ? action.draft
                  ? '草案已生成'
                  : '成功'
                : '失败'
          }`,
        ),
      ),
    ),
  );
  return details;
};

const renderEntry = (entry) => {
  if (entry.type === 'msg') {
    const node = el('div', `chat-msg ${entry.role}`, entry.content);
    if (entry.cancelled === true) node.append(el('span', 'chat-cancelled-mark', '已取消'));
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
  const suggestions = [
    '检查我的持仓、可用资金与集中度风险',
    '帮我登记一笔入金，先核对账户和金额',
    '研究 300857 的机会、风险和反证',
    '创建一个观察清单，并设置价格提醒',
  ];
  const chips = suggestions.map((text) => {
    const button = el('button', 'chat-suggestion', text);
    button.type = 'button';
    button.addEventListener('click', () => {
      const input = $('#chat-input');
      if (input !== null) {
        input.value = text;
        input.focus();
      }
    });
    return button;
  });
  return el('div', 'chat-empty-state', [
    el('div', 'chat-empty-mark', '◇'),
    el('span', 'section-kicker', 'LOCAL ADVISOR'),
    el('h2', null, '用对话管理你的投资'),
    el(
      'p',
      null,
      '查询持仓、整理研究、管理资金与盯盘。助手先核对事实，修改经你确认后执行，再说明实际结果。',
    ),
    el('div', 'chat-suggestions', chips),
  ]);
};

const renderChat = () => {
  const log = $('#chat-log');
  if (log === null) return;
  mount(log, feed.length === 0 ? emptyState() : feed.map(renderEntry));
  log.scrollTop = log.scrollHeight;
  const sendButton = $('#chat-send');
  if (sendButton !== null) sendButton.disabled = sending || settling;
  const newButton = $('#chat-new-session');
  if (newButton !== null) newButton.disabled = sending || settling;
  log.setAttribute('aria-busy', String(sending || settling));
};

const formatSessionTime = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
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
    message: `删除会话「${session.title}」及全部消息？`,
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
    feed.splice(0);
  }
  await refreshSessions();
  const next = sessions[0];
  if (next !== undefined) await selectSession(next.id);
  else renderChat();
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
            el('span', 'chat-session-time', formatSessionTime(session.updatedAt)),
          ]);
          open.type = 'button';
          open.addEventListener('click', () => void selectSession(session.id));
          const rename = el('button', 'chat-session-action', '✎');
          rename.type = 'button';
          rename.title = '重命名';
          rename.addEventListener('click', () => void renameSession(session));
          const remove = el('button', 'chat-session-action danger', '×');
          remove.type = 'button';
          remove.title = '删除';
          remove.addEventListener('click', () => void deleteSession(session));
          return el('div', `chat-session-item${session.id === activeSessionId ? ' active' : ''}`, [
            open,
            el('div', 'chat-session-actions', [rename, remove]),
          ]);
        }),
  );
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
    if (visibleText.trim().length > 0 || cancelled) {
      result.push({
        type: 'msg',
        role: message.role,
        content: visibleText,
        ...(cancelled ? { cancelled: true } : {}),
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
      if (part.type === 'data-luoome-usage') result.push({ type: 'usage', metadata: part.data });
      if (part.type === 'data-luoome-stream-error') {
        result.push({ type: 'note', text: String(part.data?.message ?? 'AI 响应失败，请重试') });
      }
      if (typeof part.type !== 'string' || !part.type.startsWith('tool-')) continue;
      const output = part.output;
      actions.push({
        toolCallId: part.toolCallId,
        tool: part.type.slice(5),
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
  return result;
};

const selectSession = async (sessionId) => {
  if (sending || settling || sessionId === activeSessionId) return;
  const version = viewVersion;
  const accountId = activeAccountId ?? getAccountId();
  const result = await callApi(`/api/chat/sessions/${encodeURIComponent(sessionId)}`);
  if (version !== viewVersion) return;
  if (!result.ok) {
    await alertDialog('读取会话失败', resultErrorText(result, '未知错误'));
    return;
  }
  activeSessionId = sessionId;
  feed.splice(
    0,
    feed.length,
    ...persistedFeed(result.data.messages ?? [], {
      sessionId,
      accountId,
    }),
  );
  renderSessions();
  renderChat();
  $('#chat-input')?.focus();
};

const refreshSessions = async () => {
  const version = viewVersion;
  const result = await callApi('/api/chat/sessions');
  if (version !== viewVersion) return false;
  if (!result.ok) {
    sessions = [];
    renderSessions();
    return false;
  }
  sessions = Array.isArray(result.data?.sessions) ? result.data.sessions : [];
  renderSessions();
  return true;
};

const createSession = async () => {
  const version = viewVersion;
  const result = await callApi('/api/chat/sessions', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  if (version !== viewVersion) return null;
  if (!result.ok) {
    await alertDialog('创建会话失败', resultErrorText(result, '无法创建会话'));
    return null;
  }
  const session = result.data.session;
  sessions = [session, ...sessions.filter((item) => item.id !== session.id)];
  activeSessionId = session.id;
  feed.splice(0);
  renderSessions();
  renderChat();
  $('#chat-input')?.focus();
  return session;
};

const pushMsg = (role, content) => {
  feed.push({ type: 'msg', role, content });
  renderChat();
};

const removeEntry = (target) => {
  const index = feed.indexOf(target);
  if (index >= 0) feed.splice(index, 1);
};

const send = async (requestedText) => {
  const input = $('#chat-input');
  if (input === null || sending || settling) return;
  const text = (requestedText ?? input.value).trim();
  if (text.length === 0) return;
  sending = true;
  const sendBtn = $('#chat-send');
  if (sendBtn !== null) sendBtn.disabled = true;
  const controller = new AbortController();
  activeController = controller;
  const version = viewVersion;
  const accountId = getAccountId();
  // 流式期间显示「取消」：abort 会断流，服务端透传 request.signal 中断 runtime。
  const cancelBtn = el('button', 'btn btn-outline btn-sm', '取消');
  cancelBtn.type = 'button';
  cancelBtn.id = 'chat-cancel';
  cancelBtn.addEventListener('click', () => controller.abort());
  $('#chat-form')?.append(cancelBtn);
  let assistantEntry = null;
  let sessionId = null;
  let assistantMessageId = null;

  try {
    if (activeSessionId === null && (await createSession()) === null) return;
    sessionId = activeSessionId;
    if (sessionId === null) return;
    if (requestedText === undefined) input.value = '';
    pushMsg('user', text);
    const statusEntry = { type: 'status', text: '正在连接模型…' };
    const actionsEntry = { type: 'actions', usedActions: [] };
    // catch 块需要引用：取消时给这条消息打「已取消」标注
    assistantEntry = { type: 'msg', role: 'assistant', content: '', cancelled: false };
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
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        sessionId,
        messages: [
          {
            id: `user_${crypto.randomUUID()}`,
            role: 'user',
            parts: [{ type: 'text', text }],
          },
        ],
      }),
    });
    if (version !== viewVersion) return;
    const route = parseChatRouteHeader(response.headers.get('x-luoome-chat-route'));
    if (route !== null) feed.push({ type: 'plan', route });
    await consumeUIMessageStream(response, (part) => {
      if (version !== viewVersion) return;
      if (part.type === 'start') {
        if (typeof part.messageId === 'string') assistantMessageId = part.messageId;
      } else if (part.type === 'start-step') {
        statusEntry.text = '模型正在推理…';
      } else if (part.type === 'tool-input-available') {
        statusEntry.text = `正在处理 ${toolLabel(part.toolName)}…`;
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
        }
      } else if (part.type === 'finish' && part.messageMetadata?.usage !== undefined) {
        feed.push({ type: 'usage', metadata: part.messageMetadata });
      } else if (part.type === 'data-luoome-usage') {
        feed.push({ type: 'usage', metadata: part.data });
      } else if (part.type === 'abort') {
        controller.abort();
        throw new DOMException('响应已停止', 'AbortError');
      } else if (part.type === 'text-start') {
        statusEntry.text = '正在生成回答…';
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
    if (assistantEntry.content.trim().length === 0 && toolCalls.size === 0) {
      assistantEntry.content = '模型没有返回内容，请重试。';
      ensureAssistant();
    }
    renderChat();
    await refreshSessions();
  } catch (error) {
    if (version !== viewVersion) return;
    const status = feed.findLast((entry) => entry.type === 'status');
    if (status !== undefined) removeEntry(status);
    if (controller.signal.aborted) {
      // 主动取消：保留已接收的文本与工具轨迹，标注「已取消」，不伪造完整回答。
      if (assistantEntry !== null) {
        assistantEntry.cancelled = true;
        if (!feed.includes(assistantEntry)) feed.push(assistantEntry);
        renderChat();
        await refreshSessions();
      }
    } else {
      // TypeError 来自 fetch/reader 的连接级失败（服务重启、空闲掐线等），原始 message 对用户无意义。
      const reason =
        error instanceof TypeError
          ? '连接中断，请重试；已生成的部分内容会保留在会话中'
          : error instanceof Error
            ? error.message
            : '未知错误';
      pushMsg('assistant', `请求失败：${reason}`);
    }
  } finally {
    cancelBtn.remove();
    if (activeController === controller) {
      sending = false;
      activeController = null;
      if (sendBtn !== null) sendBtn.disabled = false;
      renderChat();
      input.focus();
    }
  }
};

const initChat = () => {
  if (initialized) return;
  initialized = true;
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
  viewVersion += 1;
  activeController?.abort();
  activeController = null;
  sending = false;
  settling = false;
  activeAccountId = accountId;
  activeSessionId = null;
  feed.splice(0);
  if (!(await refreshSessions())) {
    renderChat();
    return;
  }
  const first = sessions[0];
  if (first !== undefined) await selectSession(first.id);
  else renderChat();
};

export {
  draftDecisionPath,
  draftEditPrefill,
  draftFromPart,
  formatDraftFieldValue,
  initChat,
  parseChatRouteHeader,
  persistedFeed,
  planCardLines,
  refreshChat,
  renderChat,
  settlementText,
  shouldContinueAfterDrafts,
  trimLeadingChatWhitespace,
  usageText,
};
