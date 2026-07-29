// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { consumeUIMessageStream } from './ai-ui-stream.js';
import { callApi, getToken } from './api.js';
import { $, el, mount } from './ui.js';

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
  run_strategy: '试跑 Strategy',
  create_watchlist: '创建 Watchlist',
  update_watchlist: '更新 Watchlist',
  archive_watchlist: '归档 Watchlist',
  add_watchlist_member: '添加 Watchlist 成员',
  update_watchlist_member: '更新 Watchlist 成员',
  archive_watchlist_member: '归档 Watchlist 成员',
  create_alert_plan: '创建 AlertPlan',
  update_alert_plan: '更新 AlertPlan',
  delete_alert_plan: '删除 AlertPlan',
};

const toolLabel = (tool) => TOOL_LABELS[tool] ?? tool;
const errorText = (result, fallback) => result?.error?.message ?? result?.error?.cause ?? fallback;
const trimLeadingChatWhitespace = (text) => text.trimStart();

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
  card.append(el('p', 'chat-draft-summary', String(draft.summary ?? '')));
  card.append(el('pre', 'chat-draft-input', JSON.stringify(draft.input ?? {}, null, 2)));
  const confirmBtn = el('button', 'btn btn-primary btn-sm', '确认执行');
  confirmBtn.type = 'button';
  const cancelBtn = el('button', 'btn btn-outline btn-sm', '取消');
  cancelBtn.type = 'button';
  card.append(el('div', 'chat-draft-actions', [confirmBtn, cancelBtn]));

  const settle = (text, ok) => {
    draft.settled = { text, ok };
    renderChat();
    void recordDraftSettlement(draft, text, ok);
  };
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    const result = await callApi(`/api/tools/${draft.tool}/call`, {
      method: 'POST',
      body: JSON.stringify({ input: draft.input }),
    });
    if (result.ok) {
      settle(`${toolLabel(draft.tool)}执行成功`, true);
    } else {
      settle(`执行失败：${errorText(result, '未知错误')}`, false);
    }
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
  if (entry.type === 'msg') return el('div', `chat-msg ${entry.role}`, entry.content);
  if (entry.type === 'note') return el('div', 'chat-msg system', entry.text);
  if (entry.type === 'status') {
    return el('div', 'chat-msg system chat-stream-status', entry.text);
  }
  if (entry.type === 'actions') return usedActionsNode(entry.usedActions);
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
  const title = window.prompt('重命名会话', session.title)?.trim();
  if (!title || title === session.title) return;
  const result = await callApi(`/api/chat/sessions/${encodeURIComponent(session.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
  if (!result.ok) {
    window.alert(`重命名失败：${errorText(result, '未知错误')}`);
    return;
  }
  await refreshSessions();
};

const deleteSession = async (session) => {
  if (sending || !window.confirm(`删除会话「${session.title}」及全部消息？`)) return;
  const result = await callApi(`/api/chat/sessions/${encodeURIComponent(session.id)}`, {
    method: 'DELETE',
  });
  if (!result.ok) {
    window.alert(`删除失败：${errorText(result, '未知错误')}`);
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
    if (visibleText.trim().length > 0) {
      result.push({ type: 'msg', role: message.role, content: visibleText });
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
    window.alert(`读取会话失败：${errorText(result, '未知错误')}`);
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
    window.alert(`创建会话失败：${errorText(result, '请先在设置页配置 Web token')}`);
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

  try {
    if (activeSessionId === null && (await createSession()) === null) return;
    const sessionId = activeSessionId;
    if (sessionId === null) return;
    input.value = '';
    pushMsg('user', text);
    const statusEntry = { type: 'status', text: '正在连接模型…' };
    const actionsEntry = { type: 'actions', usedActions: [] };
    const assistantEntry = { type: 'msg', role: 'assistant', content: '' };
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
    const token = getToken();
    if (token.length > 0) headers.set('authorization', `Bearer ${token}`);
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers,
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
    await consumeUIMessageStream(response, (part) => {
      if (part.type === 'start-step') {
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
    pushMsg('assistant', `请求失败：${error instanceof Error ? error.message : '未知错误'}`);
  } finally {
    sending = false;
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
  formatDraftSettlement,
  initChat,
  parseDraftSettlement,
  refreshChat,
  renderChat,
  trimLeadingChatWhitespace,
};
