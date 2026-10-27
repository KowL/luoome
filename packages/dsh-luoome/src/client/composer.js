// 会话输入框写入：把「在对话中研究此策略」的提示草稿放进 DSH 官方 composer。
//
// DSH 官方 composer 是 Lexical 的 contenteditable，不是 textarea；只找 textarea 会永远落空，
// 用户仍要手工复制标识。contenteditable 只能走浏览器原生插入命令，编辑器才会真正收到文本。

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

/**
 * 把文本写入会话输入框；找不到可用输入框时返回 false，不伪造已写入。
 * 不自动提交：草稿仍由用户过目后手动发送。
 */
export const writeComposer = (text, doc = globalThis.document) => {
  const target = findComposer(doc);
  if (target === undefined) return false;
  const existing =
    target.tagName === 'TEXTAREA' ? target.value : (target.innerText ?? target.textContent);
  if (typeof existing === 'string' && existing.trim()) return existing === text;
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
    return doc.execCommand('insertText', false, text) === true;
  } catch {
    return false;
  }
};

const writeComposerAndVerify = (text, doc = globalThis.document) => {
  if (!writeComposer(text, doc)) return false;
  const target = findComposer(doc);
  if (target === undefined) return false;
  const value =
    target.tagName === 'TEXTAREA' ? target.value : (target.innerText ?? target.textContent);
  return typeof value === 'string' && value.includes(text);
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
    if (write(text)) return { createdSession: false, sessionId: null };
  }
  const selectedSession = () =>
    Object.values(ctx.sessions.list.getSnapshot().byId).find(
      (session) => (session.retainedBy.mainView ?? 0) > 0,
    )?.id ?? null;
  const previousSessionId = selectedSession();
  // 不带初始草稿的官方入口创建新会话并继承工作区，避免复用含有未发送草稿的空白会话。
  ctx.uiWorkspace.startSession();
  for (const delay of delays) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const sessionId = selectedSession();
    if (sessionId !== null && sessionId !== previousSessionId && write(text))
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
