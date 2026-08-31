// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { consumeUIMessageStream } from './ai-ui-stream.js';
import { callApi } from './api.js';
import { alertDialog, confirmDialog, promptDialog } from './modal.js';
import { $, adviceCard, el, mount } from './ui.js';

const feed = [];
let sessions = [];
let activeSessionId = null;
let sending = false;
let initialized = false;

const TOOL_LABELS = {
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
const errorText = (result, fallback) => result?.error?.message ?? result?.error?.cause ?? fallback;
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

// 草案确认/取消结果以该前缀作为 user 文本消息持久化到会话：
// 刷新后能把历史草案渲染为已结算，模型下一轮也能看到处理结果而不重复提议。
const DRAFT_SETTLED_PREFIX = '[草案处理记录]';

const formatDraftSettlement = (tool, ok, text) =>
  `${DRAFT_SETTLED_PREFIX} ${ok ? 'ok' : 'fail'} ${tool} ${text}`;

const parseDraftSettlement = (text) => {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(DRAFT_SETTLED_PREFIX)) return null;
  const rest = trimmed.slice(DRAFT_SETTLED_PREFIX.length).trimStart();
  const ok = rest.startsWith('ok ');
  if (!ok && !rest.startsWith('fail ')) return null;
  const body = rest.slice(ok ? 3 : 5);
  const splitAt = body.indexOf(' ');
  return {
    ok,
    tool: splitAt < 0 ? body : body.slice(0, splitAt),
    text: splitAt < 0 ? '' : body.slice(splitAt + 1),
  };
};

const recordDraftSettlement = async (draft, text, ok) => {
  if (activeSessionId === null) return;
  const result = await callApi('/api/tools/append_chat_message/call', {
    method: 'POST',
    body: JSON.stringify({
      input: {
        sessionId: activeSessionId,
        role: 'user',
        parts: [{ type: 'text', text: formatDraftSettlement(draft.tool, ok, text) }],
      },
    }),
  });
  if (!result.ok) console.warn('[chat] 草案处理记录写入失败', result.error);
};

// 取消消息的 parts：已收到文本（可为空）+ cancelled 标记，供前端兜底落库与历史还原。
const cancelledAssistantParts = (content) => [
  ...(content.trim().length > 0 ? [{ type: 'text', text: content }] : []),
  { type: 'data-luoome-cancelled', data: { cancelled: true } },
];

// 实测 Bun 下客户端断开后服务端 onFinish 不会回调（响应流被先行拆除），由前端把
// partial 助手消息落库；messageId 取自流的 start chunk，saveMessage 按 id upsert 幂等。
const persistCancelledAssistant = async (sessionId, messageId, content) => {
  const result = await callApi('/api/tools/append_chat_message/call', {
    method: 'POST',
    body: JSON.stringify({
      input: {
        sessionId,
        ...(messageId === null ? {} : { messageId }),
        role: 'assistant',
        parts: cancelledAssistantParts(content),
      },
    }),
  });
  if (!result.ok) console.warn('[chat] 取消消息落库失败', result.error);
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
  card.append(el('div', 'chat-draft-title', `草案 · ${toolLabel(draft.tool)}`));
  if (draft.settled !== undefined) {
    card.append(
      el(
        'p',
        draft.settled.ok ? 'chat-draft-settled ok' : 'chat-draft-settled',
        draft.settled.text,
      ),
    );
    return card;
  }
  if (draft.display !== undefined && draft.display !== null) {
    card.append(draftDisplayNode(draft.display));
  } else {
    card.append(el('p', 'chat-draft-summary', String(draft.summary ?? '')));
    card.append(el('pre', 'chat-draft-input', JSON.stringify(draft.input ?? {}, null, 2)));
  }
  const confirmBtn = el('button', 'btn btn-primary btn-sm', '确认执行');
  confirmBtn.type = 'button';
  const editBtn = el('button', 'btn btn-outline btn-sm', '编辑');
  editBtn.type = 'button';
  const cancelBtn = el('button', 'btn btn-outline btn-sm', '取消');
  cancelBtn.type = 'button';
  card.append(el('div', 'chat-draft-actions', [confirmBtn, editBtn, cancelBtn]));

  const settle = (text, ok) => {
    draft.settled = { text, ok };
    renderChat();
    void recordDraftSettlement(draft, text, ok);
  };
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    editBtn.disabled = true;
    cancelBtn.disabled = true;
    const result = await callApi(`/api/tools/${draft.tool}/call`, {
      method: 'POST',
      body: JSON.stringify({ input: draft.input }),
    });
    if (result.ok) {
      settle(`${toolLabel(draft.tool)}执行成功`, true);
      // advice 草案确认后返回正式 Advice，用 Advice 页同款卡片渲染进会话。
      const advice = result.data?.advice;
      if (draft.kind === 'advice' && advice !== undefined && advice !== null) {
        feed.push({ type: 'advice', advice });
        renderChat();
      }
    } else {
      settle(`执行失败：${errorText(result, '未知错误')}`, false);
    }
  });
  editBtn.addEventListener('click', () => {
    const input = $('#chat-input');
    if (input === null) return;
    input.value = draftEditPrefill(draft);
    input.focus();
  });
  cancelBtn.addEventListener('click', () => settle('已取消该草案', false));
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
            action.status === 'running' ? '执行中…' : action.ok ? '成功' : '失败'
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
  if (entry.type === 'advice') return adviceCard(entry.advice);
  return el('div', 'chat-drafts', entry.drafts.map(draftCard));
};

const emptyState = () => {
  const suggestions = [
    '总结我的当前持仓',
    '查询 300857 的行情',
    '列出最近的研究笔记',
    '帮我创建一个观察 Watchlist',
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
    el('h2', null, '从一个问题开始'),
    el('p', null, '会话保存在当前项目数据库中。查询会调用真实工具，写操作只生成待确认草案。'),
    el('div', 'chat-suggestions', chips),
  ]);
};

const renderChat = () => {
  const log = $('#chat-log');
  if (log === null) return;
  mount(log, feed.length === 0 ? emptyState() : feed.map(renderEntry));
  log.scrollTop = log.scrollHeight;
};

const formatSessionTime = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
};

const renameSession = async (session) => {
  if (sending) return;
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
    await alertDialog('重命名失败', errorText(result, '未知错误'));
    return;
  }
  await refreshSessions();
};

const deleteSession = async (session) => {
  if (sending) return;
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
    await alertDialog('删除失败', errorText(result, '未知错误'));
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

const persistedFeed = (messages) => {
  const result = [];
  const pendingDrafts = [];
  for (const message of messages) {
    const text = message.parts
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
    const settlement = parseDraftSettlement(text);
    if (settlement !== null) {
      for (const draft of pendingDrafts) {
        if (draft.settled === undefined)
          draft.settled = { text: settlement.text, ok: settlement.ok };
      }
      pendingDrafts.length = 0;
      result.push({ type: 'note', text: settlement.text });
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
    const actions = [];
    const drafts = [];
    for (const part of message.parts) {
      if (typeof part.type !== 'string' || !part.type.startsWith('tool-')) continue;
      const output = part.output;
      actions.push({
        toolCallId: part.toolCallId,
        tool: part.type.slice(5),
        status: part.state === 'input-streaming' ? 'running' : 'finished',
        ok: part.state === 'output-available' && output?.error === undefined,
      });
      if (output?.__luoomeDraft === true && output.draft !== undefined) {
        drafts.push(output.draft);
        pendingDrafts.push(output.draft);
      }
    }
    if (actions.length > 0) result.push({ type: 'actions', usedActions: actions });
    if (drafts.length > 0) result.push({ type: 'drafts', drafts });
  }
  return result;
};

const selectSession = async (sessionId) => {
  if (sending || sessionId === activeSessionId) return;
  const result = await callApi(`/api/chat/sessions/${encodeURIComponent(sessionId)}`);
  if (!result.ok) {
    await alertDialog('读取会话失败', errorText(result, '未知错误'));
    return;
  }
  activeSessionId = sessionId;
  feed.splice(0, feed.length, ...persistedFeed(result.data.messages ?? []));
  renderSessions();
  renderChat();
  $('#chat-input')?.focus();
};

const refreshSessions = async () => {
  const result = await callApi('/api/chat/sessions');
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
  const result = await callApi('/api/chat/sessions', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  if (!result.ok) {
    await alertDialog('创建会话失败', errorText(result, '无法创建会话'));
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

const send = async () => {
  const input = $('#chat-input');
  if (input === null || sending) return;
  const text = input.value.trim();
  if (text.length === 0) return;
  sending = true;
  const sendBtn = $('#chat-send');
  if (sendBtn !== null) sendBtn.disabled = true;
  const controller = new AbortController();
  // 流式期间显示「取消」：abort 会断流，服务端透传 request.signal 中断 runtime。
  const cancelBtn = el('button', 'btn btn-outline btn-sm', '取消');
  cancelBtn.type = 'button';
  cancelBtn.id = 'chat-cancel';
  cancelBtn.addEventListener('click', () => controller.abort());
  $('#chat-form')?.append(cancelBtn);
  let assistantEntry = null;
  // catch 块需要引用：取消时把 partial 消息兜底落库（服务端 onFinish 此时不会回调）
  let sessionId = null;
  let assistantMessageId = null;
  let fetchSent = false;

  try {
    if (activeSessionId === null && (await createSession()) === null) return;
    sessionId = activeSessionId;
    if (sessionId === null) return;
    input.value = '';
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
    const headers = new Headers({ 'content-type': 'application/json' });
    fetchSent = true;
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
    const route = parseChatRouteHeader(response.headers.get('x-luoome-chat-route'));
    if (route !== null) feed.push({ type: 'plan', route });
    await consumeUIMessageStream(response, (part) => {
      if (part.type === 'start') {
        if (typeof part.messageId === 'string') assistantMessageId = part.messageId;
      } else if (part.type === 'start-step') {
        statusEntry.text = '模型正在推理…';
      } else if (part.type === 'tool-input-available') {
        statusEntry.text = `正在执行 ${part.toolName}…`;
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
        }
        if (part.output?.__luoomeDraft === true && part.output.draft !== undefined) {
          feed.push({ type: 'drafts', drafts: [part.output.draft] });
        }
      } else if (part.type === 'tool-output-error') {
        const action = toolCalls.get(part.toolCallId);
        if (action !== undefined) {
          action.status = 'finished';
          action.ok = false;
        }
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
    removeEntry(statusEntry);
    if (assistantEntry.content.trim().length === 0) {
      assistantEntry.content = '模型没有返回文本，请重试。';
      ensureAssistant();
    }
    renderChat();
    await refreshSessions();
  } catch (error) {
    const status = feed.findLast((entry) => entry.type === 'status');
    if (status !== undefined) removeEntry(status);
    if (controller.signal.aborted) {
      // 主动取消：保留已接收的文本与工具轨迹，标注「已取消」，不伪造完整回答。
      if (assistantEntry !== null) {
        assistantEntry.cancelled = true;
        if (!feed.includes(assistantEntry)) feed.push(assistantEntry);
        renderChat();
        // 客户端断开后服务端 onFinish 不会回调，前端兜底落库 partial + cancelled 标记。
        if (fetchSent && sessionId !== null) {
          await persistCancelledAssistant(sessionId, assistantMessageId, assistantEntry.content);
        }
        await refreshSessions();
      }
    } else {
      pushMsg('assistant', `请求失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  } finally {
    sending = false;
    cancelBtn.remove();
    if (sendBtn !== null) sendBtn.disabled = false;
    input.focus();
  }
};

const initChat = () => {
  if (initialized) return;
  initialized = true;
  $('#chat-new-session')?.addEventListener('click', () => void createSession());
  $('#chat-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void send();
  });
};

const refreshChat = async () => {
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
  cancelledAssistantParts,
  draftEditPrefill,
  formatDraftFieldValue,
  formatDraftSettlement,
  initChat,
  parseChatRouteHeader,
  parseDraftSettlement,
  persistedFeed,
  planCardLines,
  refreshChat,
  renderChat,
  trimLeadingChatWhitespace,
};
