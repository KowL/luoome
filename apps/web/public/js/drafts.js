// apps/web/public/js/drafts.js —— 待确认草案：渲染、确认与取消。
//
// 模型推理与对话已随 DSH 改造退役（推理在 DSH 侧完成），luoome 只保留不依赖模型的
// 「起草 → 明确确认 → 原子执行」这条链路：草案由服务端写入会话消息，确认请求只提交
// 服务端已保存的标识，不携带客户端输入。

import { apiHeaders, callApi, getAccountId } from './api.js';
import { adviceCard, el, mount, resultErrorText } from './ui.js';

const TOOL_LABELS = {
  fetch_quote: '读取行情',
  web_fetch: '读取网页',
  research_investment_directions: '参与方向研究',
  save_investment_consensus: '保存参与共识',
  set_investment_tracking: '调整方向跟踪',
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

const draftFromPart = (part, context) => {
  if (part.output?.__luoomeDraft !== true || part.output.draft === undefined) return null;
  return { ...part.output.draft, ...context, toolCallId: part.toolCallId };
};

const settlementText = (settlement) => {
  if (settlement.status === 'cancelled') return '已取消，未执行';
  if (settlement.status === 'executing')
    return '执行中；若页面或进程曾中断，请核对实际账本后可取消该草案';
  if (settlement.status === 'succeeded') {
    const data = settlement.result?.ok ? settlement.result.data : null;
    if (settlement.tool === 'research_investment_directions' && data?.research) {
      const research = data.research;
      if (research.status === 'complete') return '方向研究已完成；保存共识与开启跟踪需分别确认。';
      return `${research.status === 'unavailable' ? '事实不足，未生成方向' : '研究未完成，未生成可用方向'}。${research.limitations.at(-1) ?? '请核对数据与模型状态后重新研究。'}`;
    }
    if (settlement.tool === 'save_investment_consensus' && data?.consensus)
      return data.consensus.status === 'revoked'
        ? `共识 v${data.consensus.version} 已撤销。`
        : `共识 v${data.consensus.version} 已保存；方向跟踪需另行确认。`;
    if (settlement.tool === 'set_investment_tracking' && data?.tracking)
      return {
        starting: '跟踪启动尚未完成，请核对实际状态。',
        tracking: '候选同步已连接；后台运行与手机送达仍需核对。',
        partial: '候选同步部分可用，请核对未连接方向及调度状态。',
        failed: '方向跟踪启动失败，已保存的共识仍保留。',
        paused: '方向新候选同步已暂停；持仓风险监控不受此操作影响。',
      }[data.tracking.status];
    return `${toolLabel(settlement.tool)}执行成功`;
  }
  const reason = resultErrorText(settlement.result, '未知错误');
  if (reason.includes('consensus_version_conflict'))
    return '共识已被其它页面更新。请回首页核对最新版本，再重新提出草案。';
  return `执行失败：${reason}`;
};

const isSettled = (draft) =>
  ['succeeded', 'failed', 'cancelled'].includes(draft.settlement?.status);

const draftDecisionPath = (draft) =>
  `/api/chat/sessions/${encodeURIComponent(draft.sessionId)}/drafts/${encodeURIComponent(draft.messageId)}/${encodeURIComponent(draft.toolCallId)}`;

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

/** 从会话消息里取出草案；同一消息内按调用标识分别恢复结算状态。 */
const sessionDrafts = (messages, context = {}) => {
  const drafts = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const settlements = new Map(
      message.parts
        .filter((part) => part.type === 'data-luoome-draft-settlement')
        .map((part) => [part.data?.toolCallId, part.data]),
    );
    for (const part of message.parts) {
      if (typeof part.type !== 'string' || !part.type.startsWith('tool-')) continue;
      const draft = draftFromPart(part, { ...context, messageId: message.id });
      if (draft === null) continue;
      const settlement = settlements.get(part.toolCallId);
      if (settlement !== undefined) draft.settlement = settlement;
      drafts.push(draft);
    }
  }
  return drafts;
};

let settling = false;

/** 确认或取消草案；只提交服务端已保存的标识。 */
const settleDraft = async (draft, approved, onChanged) => {
  if (settling || isSettled(draft)) return;
  settling = true;
  draft.error = null;
  onChanged?.();
  const response = await callApi(draftDecisionPath(draft), {
    method: 'POST',
    headers: apiHeaders(undefined, draft.accountId),
    body: JSON.stringify({ approved }),
  });
  settling = false;
  if (response.ok) draft.settlement = response.data;
  else draft.error = resultErrorText(response, '请求未完成，请刷新会话后重试');
  onChanged?.();
  if (response.ok) document.dispatchEvent(new Event('luoome:workspace-updated'));
};

const draftCard = (draft, onChanged) => {
  const card = el('div', 'chat-draft');
  card.append(el('div', 'chat-draft-title', `待确认 · ${toolLabel(draft.tool)}`));
  if (draft.display !== undefined && draft.display !== null) {
    card.append(draftDisplayNode(draft.display));
  } else {
    card.append(el('p', 'chat-draft-summary', String(draft.summary ?? '')));
    card.append(el('pre', 'chat-draft-input', JSON.stringify(draft.input ?? {}, null, 2)));
  }
  if (draft.settlement !== undefined) {
    const data = draft.settlement.result?.ok ? draft.settlement.result.data : null;
    const incomplete =
      (draft.tool === 'research_investment_directions' &&
        data?.research &&
        data.research.status !== 'complete') ||
      (draft.tool === 'set_investment_tracking' &&
        data?.tracking &&
        ['starting', 'partial', 'failed'].includes(data.tracking.status));
    card.append(
      el(
        'p',
        draft.settlement.status === 'succeeded' && !incomplete
          ? 'chat-draft-settled ok'
          : 'chat-draft-settled',
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
    card.append(el('p', 'chat-draft-warn', '该历史草案缺少执行标识，请在工作台重新发起。'));
    return card;
  }
  if (draft.error) card.append(el('p', 'chat-draft-warn', draft.error));
  const executing = draft.settlement?.status === 'executing';
  const buttons = [];
  if (executing) {
    // executing 不会自行推进：核对账本后可显式取消（终态），再在工作台重新发起草案。
    const cancelExecutingBtn = el('button', 'btn btn-outline btn-sm', '取消该草案');
    cancelExecutingBtn.type = 'button';
    cancelExecutingBtn.disabled = settling;
    cancelExecutingBtn.addEventListener('click', () => void settleDraft(draft, false, onChanged));
    buttons.push(cancelExecutingBtn);
  } else {
    const confirmBtn = el('button', 'btn btn-primary btn-sm', '确认执行');
    confirmBtn.type = 'button';
    confirmBtn.disabled = settling;
    confirmBtn.addEventListener('click', () => void settleDraft(draft, true, onChanged));
    buttons.push(confirmBtn);
    const cancelBtn = el('button', 'btn btn-outline btn-sm', '取消');
    cancelBtn.type = 'button';
    cancelBtn.disabled = settling;
    cancelBtn.addEventListener('click', () => void settleDraft(draft, false, onChanged));
    buttons.push(cancelBtn);
  }
  card.append(el('div', 'chat-draft-actions', buttons));
  return card;
};

/**
 * 渲染待确认草案面板：读取会话消息，展示草案与讨论文字。
 * 面板只呈现「用户起草 → 明确确认 → 原子执行」这条链路，不再承载模型对话。
 */
export const renderDraftPanel = async (host, sessionId) => {
  if (host === null) return [];
  if (sessionId === null || sessionId === undefined) {
    mount(host, el('p', 'muted', '当前没有待确认草案。'));
    return [];
  }
  const result = await callApi(`/api/chat/sessions/${encodeURIComponent(sessionId)}`);
  if (!result.ok) {
    mount(host, el('p', 'muted', '草案读取失败；其它已有事实仍可查看，刷新后再核对。'));
    return [];
  }
  const messages = Array.isArray(result.data?.messages) ? result.data.messages : [];
  const context = { sessionId, accountId: getAccountId() };
  const drafts = sessionDrafts(messages, context);
  const notes = messages
    .filter((message) => message.role === 'user')
    .flatMap((message) =>
      message.parts
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text.trim())
        .filter((text) => text.length > 0),
    );
  const render = () => {
    const children = [];
    for (const note of notes) children.push(el('p', 'chat-note', note));
    if (drafts.length === 0) {
      children.push(el('p', 'muted', '当前没有待确认草案。'));
    } else {
      for (const draft of drafts) children.push(draftCard(draft, render));
    }
    mount(host, children);
  };
  render();
  return drafts;
};

export {
  draftDecisionPath,
  draftDisplayNode,
  draftFromPart,
  formatDraftFieldValue,
  isSettled,
  sessionDrafts,
  settlementText,
};
