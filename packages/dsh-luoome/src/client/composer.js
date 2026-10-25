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
