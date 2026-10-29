// 会话输入框写入：把「在对话中研究此策略」的提示草稿放进 DSH 官方 composer。
//
// DSH 官方 composer 是 Lexical 的 contenteditable，不是 textarea；只找 textarea 会永远落空，
// 用户仍要手工复制标识。contenteditable 只能走浏览器原生插入命令，编辑器才会真正收到文本。
// Lexical 会丢弃 insertText 里的换行，所以多行内容必须按行插入并显式插入换行命令；
// 命令返回值和提交时机都不可靠，写入结果一律以编辑器实际内容为准。

const isVisible = (element) => {
  const rect = element.getBoundingClientRect?.();
  return rect !== undefined && rect.width > 0 && rect.height > 0;
};

/** 找到当前会话输入框；官方 composer slot 内的输入框优先于页面上其它可编辑区域。 */
export const findComposer = (doc) => {
  if (doc === undefined || doc === null) return undefined;
  const candidates = [...doc.querySelectorAll('textarea, [contenteditable="true"]')].filter(
    (element) => {
      if (element.disabled === true || element.readOnly === true) return false;
      return isVisible(element);
    },
  );
  const inSlot = candidates.find((element) => {
    const slot = element.closest?.('[data-slot="conversation.composer"]');
    return slot !== null && slot !== undefined;
  });
  return inSlot ?? candidates[0];
};

const editorText = (target) =>
  target.tagName === 'TEXTAREA' ? target.value : (target.innerText ?? target.textContent ?? '');

/** contenteditable 用尾随换行表示块尾，只归一这一种浏览器产物，内部换行必须逐字一致。 */
const matchesContentEditable = (value, text) =>
  typeof value === 'string' && (value === text || value === `${text}\n`);

const matchesEditor = (target, value, text) =>
  target.tagName === 'TEXTAREA' ? value === text : matchesContentEditable(value, text);

/** 按行插入：空行只留换行命令，避免把多段内容拼成一行。 */
const insertLines = (doc, text) => {
  const lines = text.split('\n');
  let accepted = true;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]) {
      if (doc.execCommand('insertText', false, lines[index]) !== true) accepted = false;
    }
    if (index < lines.length - 1 && doc.execCommand('insertLineBreak') !== true) accepted = false;
  }
  return accepted;
};

/**
 * 把文本写入会话输入框；找不到可用输入框时返回 false，不伪造已写入。
 * 不自动提交：草稿仍由用户过目后手动发送。
 */
export const writeComposer = (text, doc = globalThis.document) => {
  const target = findComposer(doc);
  if (target === undefined) return false;
  const existing = editorText(target);
  if (typeof existing === 'string' && existing.trim()) return matchesEditor(target, existing, text);
  try {
    if (target.tagName === 'TEXTAREA') {
      const prototype =
        target.ownerDocument?.defaultView?.HTMLTextAreaElement?.prototype ??
        Object.getPrototypeOf(target);
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter === undefined) return false;
      setter.call(target, text);
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.focus();
      return true;
    }
    target.focus();
    const selection = doc.defaultView?.getSelection?.();
    if (selection === undefined || selection === null) return false;
    const range = doc.createRange();
    range.selectNodeContents(target);
    selection.removeAllRanges();
    selection.addRange(range);
    return insertLines(doc, text);
  } catch {
    return false;
  }
};

/**
 * 多行内容走粘贴事件：Lexical 的纯文本粘贴会按行建段落，换行不会像 insertText 那样被丢弃。
 * 浏览器不支持合成剪贴板时返回 false，由逐行插入兜底。
 */
const pasteLines = (target, doc, text) => {
  const view = doc.defaultView;
  if (view?.DataTransfer === undefined || view?.ClipboardEvent === undefined) return false;
  try {
    const data = new view.DataTransfer();
    data.setData('text/plain', text);
    const event = new view.ClipboardEvent('paste', {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(event);
    return true;
  } catch {
    return false;
  }
};

/**
 * 写入并核对：命令可能返回 false 却已插入，也可能在微任务后才提交，
 * 所以等一次提交再以编辑器实际内容判定，绝不把失败当成功。
 */
const writeComposerAndVerify = async (text, doc = globalThis.document) => {
  const target = findComposer(doc);
  if (target === undefined) return false;
  const existing = editorText(target);
  if (typeof existing === 'string' && existing.trim()) return matchesEditor(target, existing, text);
  if (target.tagName !== 'TEXTAREA' && text.includes('\n')) {
    target.focus();
    pasteLines(target, doc, text);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pasted = findComposer(doc);
    if (pasted !== undefined && matchesEditor(pasted, editorText(pasted), text)) return true;
  }
  writeComposer(text, doc);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const current = findComposer(doc);
  if (current === undefined) return false;
  return matchesEditor(current, editorText(current), text);
};

export const writeComposerWithSessionFallback = async (ctx, text, options = {}) => {
  const write = options.write ?? writeComposerAndVerify;
  const delays = options.delays ?? [80, 240, 600, 1200];
  try {
    ctx?.layout?.selectPanel?.('conversation');
  } catch {
    // 保留当前会话内容；后续失败时再创建新会话。
  }
  for (const delay of delays) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    if (await write(text)) return { createdSession: false, sessionId: null };
  }
  const selectedSession = () =>
    Object.values(ctx.sessions.list.getSnapshot().byId).find(
      (session) => (session.retainedBy.mainView ?? 0) > 0,
    )?.id ?? null;
  const previousSessionId = selectedSession();
  // 不带初始草稿的官方入口创建新会话并继承工作区，避免复用含有未发送草稿的空白会话。
  // 导航可能是异步的：必须等它完成后再写入，否则会写进旧会话或提前报失败。
  await ctx.uiWorkspace.startSession();
  for (const delay of delays) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const sessionId = selectedSession();
    if (sessionId !== null && sessionId !== previousSessionId && (await write(text)))
      return { createdSession: true, sessionId };
  }
  throw new Error('DSH composer unavailable');
};

export const sendStockAnalysis = async (ctx, request) => {
  const sessionId = await ctx.sessions.create();
  await ctx.sessions.using(sessionId, { source: 'workspaceOperation' }, async (reference) => {
    const result = await reference.binding.session.prompt(
      [{ type: 'text', text: request.prompt }],
      'queue',
    );
    if (!result.ok) {
      const error = new Error('DSH 未能接受本次分析请求');
      error.code = result.error.code;
      throw error;
    }
    ctx.uiWorkspace.openSession(sessionId);
  });
  return sessionId;
};
