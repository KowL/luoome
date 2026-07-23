/* apps/web/public/js/chat.js —— 对话路由（docs/web-chat-design.md §5）。
 *
 * - history 存 sessionStorage（关 tab 即清，与「服务端无 session」一致）；
 *   只持久化 user/assistant 文本轮，draft 卡片与系统消息是会话内瞬态 UI，不落 storage。
 * - draft 确认卡片：「确认」→ POST /api/tools/:tool/call（body {input}），
 *   结果作为系统消息回插对话流；「取消」丢弃。
 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import { $, el, mount } from './ui.js';

/** sessionStorage key（仅存 {role, content} 文本轮）。 */
const HISTORY_KEY = 'luoome.chat.history';

/** 内存 feed：msg（持久化）+ drafts / actions / note（瞬态）。 */
const feed = [];
let history = [];
let sending = false;

/* ============ history 持久化 ============ */

const loadHistory = () => {
  try {
    const raw = sessionStorage.getItem(HISTORY_KEY);
    const parsed = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t) =>
        t !== null &&
        typeof t === 'object' &&
        (t.role === 'user' || t.role === 'assistant') &&
        typeof t.content === 'string',
    );
  } catch {
    return [];
  }
};

const saveHistory = () => {
  try {
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-50)));
  } catch {
    /* 忽略：隐私模式或 quota */
  }
};

/* ============ 渲染 ============ */

const TOOL_LABELS = {
  create_stock_group: '创建分组',
  update_stock_group: '更新分组',
  delete_stock_group: '删除分组',
  create_stock_pool: '创建盯盘池',
  update_stock_pool: '更新盯盘池',
  delete_stock_pool: '删除盯盘池',
};

const toolLabel = (tool) => TOOL_LABELS[tool] ?? tool;

/** draft 确认卡片：summary + 结构化字段 + 确认 / 取消。 */
const draftCard = (draft) => {
  const card = el('div', 'chat-draft');
  card.append(el('div', 'chat-draft-title', `草案 · ${toolLabel(draft.tool)}（${draft.tool}）`));
  card.append(el('p', 'chat-draft-summary', String(draft.summary ?? '')));
  card.append(el('pre', 'chat-draft-input', JSON.stringify(draft.input ?? {}, null, 2)));
  const confirmBtn = el('button', 'btn btn-primary btn-sm', '确认');
  confirmBtn.type = 'button';
  const cancelBtn = el('button', 'btn btn-outline btn-sm', '取消');
  cancelBtn.type = 'button';
  card.append(el('div', 'chat-draft-actions', [confirmBtn, cancelBtn]));

  const settle = (text, ok) => {
    card.replaceChildren(el('p', ok ? 'chat-draft-settled ok' : 'chat-draft-settled', text));
  };

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    const result = await callApi(`/api/tools/${draft.tool}/call`, {
      method: 'POST',
      body: JSON.stringify({ input: draft.input }),
    });
    if (result.ok) {
      settle(`已执行 ${toolLabel(draft.tool)}：成功`, true);
      pushNote(`已确认草案「${draft.summary}」，${toolLabel(draft.tool)} 执行成功。`);
    } else {
      const err = result.error ?? {};
      settle(`执行失败：${err.message ?? err.cause ?? '未知错误'}`, false);
      pushNote(`草案「${draft.summary}」执行失败：${err.message ?? err.cause ?? '未知错误'}`);
    }
  });
  cancelBtn.addEventListener('click', () => {
    settle('已取消该草案', false);
  });
  return card;
};

/** usedActions 折叠展示（「查询了 batch_quote、list_holdings」；rejected 标注拦截）。 */
const usedActionsNode = (usedActions) => {
  const names = usedActions.map((a) => (a.rejected ? `${a.tool}（已拦截）` : a.tool));
  const details = el('details', 'chat-used-actions');
  details.append(el('summary', null, `本轮动作：${names.join('、')}`));
  details.append(
    el(
      'ul',
      null,
      usedActions.map((a) =>
        el(
          'li',
          null,
          `${a.tool} — ${a.rejected ? '已拦截（不在对话可用范围）' : a.ok ? '成功' : '失败'}`,
        ),
      ),
    ),
  );
  return details;
};

const renderEntry = (entry) => {
  if (entry.type === 'msg') {
    return el('div', `chat-msg ${entry.role}`, entry.content);
  }
  if (entry.type === 'note') {
    return el('div', 'chat-msg system', entry.text);
  }
  if (entry.type === 'actions') {
    return usedActionsNode(entry.usedActions);
  }
  // drafts
  return el('div', 'chat-drafts', entry.drafts.map(draftCard));
};

const renderChat = () => {
  const log = $('#chat-log');
  if (log === null) return;
  mount(
    log,
    feed.length === 0
      ? el('p', 'placeholder', '问点什么，例如「我的持仓今天怎么样」「帮我建一个龙头分组」。')
      : feed.map(renderEntry),
  );
  log.scrollTop = log.scrollHeight;
};

/* ============ feed 操作 ============ */

const pushMsg = (role, content) => {
  feed.push({ type: 'msg', role, content });
  if (role === 'user' || role === 'assistant') {
    history.push({ role, content });
    saveHistory();
  }
  renderChat();
};

const pushNote = (text) => {
  feed.push({ type: 'note', text });
  renderChat();
};

/* ============ 发送 ============ */

const send = async () => {
  const input = $('#chat-input');
  if (input === null || sending) return;
  const message = input.value.trim();
  if (message.length === 0) return;
  sending = true;
  const sendBtn = $('#chat-send');
  if (sendBtn !== null) sendBtn.disabled = true;

  // history 快照不含本轮 message（端点把 message 与 history 分开传）
  const historySnapshot = history.slice(-10);
  input.value = '';
  pushMsg('user', message);
  pushNote('…');

  const result = await callApi('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ message, history: historySnapshot }),
  });

  // 移除「…」占位
  const idx = feed.findLastIndex((e) => e.type === 'note' && e.text === '…');
  if (idx >= 0) feed.splice(idx, 1);

  if (result.ok && result.data && typeof result.data === 'object') {
    const data = result.data;
    if (Array.isArray(data.usedActions) && data.usedActions.length > 0) {
      feed.push({ type: 'actions', usedActions: data.usedActions });
    }
    pushMsg('assistant', String(data.reply ?? ''));
    if (Array.isArray(data.drafts) && data.drafts.length > 0) {
      feed.push({ type: 'drafts', drafts: data.drafts });
      renderChat();
    }
  } else {
    const err = result.error ?? {};
    pushMsg('assistant', `请求失败：${err.message ?? err.cause ?? '未知错误'}，请稍后重试。`);
  }

  sending = false;
  if (sendBtn !== null) sendBtn.disabled = false;
  input.focus();
};

/* ============ 初始化 ============ */

let initialized = false;

const initChat = () => {
  if (initialized) return;
  initialized = true;
  history = loadHistory();
  for (const turn of history) feed.push({ type: 'msg', role: turn.role, content: turn.content });
  const form = $('#chat-form');
  if (form !== null) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void send();
    });
  }
  renderChat();
};

export { initChat, renderChat };
