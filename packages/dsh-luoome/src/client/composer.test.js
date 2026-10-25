// 会话输入框写入单测：DSH 官方 composer 是 Lexical contenteditable（不是 textarea），
// 只覆盖 textarea 会让「在对话中研究此策略」永远写不进草稿。这里锁住两条路径与失败语义。
import { describe, expect, it } from 'vitest';
import { findComposer, writeComposer } from './composer.js';

class FakeEditable {
  constructor({ tagName = 'DIV', width = 320, height = 40, slot = null } = {}) {
    this.tagName = tagName;
    this.width = width;
    this.height = height;
    this.slot = slot;
    this.focused = false;
  }
  getBoundingClientRect() {
    return { width: this.width, height: this.height };
  }
  closest(selector) {
    return this.slot !== null && selector.includes(this.slot) ? { slot: this.slot } : null;
  }
  focus() {
    this.focused = true;
  }
  dispatchEvent() {}
}

class FakeTextarea extends FakeEditable {
  #value = '';
  constructor(options = {}) {
    super({ ...options, tagName: 'TEXTAREA' });
  }
  get value() {
    return this.#value;
  }
  set value(next) {
    this.#value = next;
  }
}

const fakeDocument = ({ candidates = [], execResult = true } = {}) => {
  const inserted = [];
  const selection = { removeAllRanges: () => {}, addRange: () => {} };
  return {
    inserted,
    doc: {
      querySelectorAll: () => candidates,
      createRange: () => ({ selectNodeContents: () => {} }),
      execCommand: (command, _ui, text) => {
        inserted.push({ command, text });
        return execResult;
      },
      defaultView: { getSelection: () => selection },
    },
  };
};

describe('client composer writer', () => {
  it('prefers the official composer slot over other editable areas', () => {
    const elsewhere = new FakeEditable();
    const inSlot = new FakeEditable({ slot: 'conversation.composer' });
    const { doc } = fakeDocument({ candidates: [elsewhere, inSlot] });
    expect(findComposer(doc)).toBe(inSlot);
  });

  it('writes into a Lexical contenteditable through the native insert command', () => {
    const editor = new FakeEditable({ slot: 'conversation.composer' });
    const { doc, inserted } = fakeDocument({ candidates: [editor] });
    expect(writeComposer('研究策略 strategy-1', doc)).toBe(true);
    expect(inserted).toEqual([{ command: 'insertText', text: '研究策略 strategy-1' }]);
  });

  it('falls back to the textarea path when the composer is a textarea', () => {
    const area = new FakeTextarea({ slot: 'conversation.composer' });
    const { doc, inserted } = fakeDocument({ candidates: [area] });
    expect(writeComposer('草稿', doc)).toBe(true);
    expect(area.value).toBe('草稿');
    expect(inserted).toEqual([]);
  });

  it('reports failure instead of claiming a write when no composer is visible', () => {
    const hidden = new FakeEditable({ width: 0, height: 0, slot: 'conversation.composer' });
    const { doc } = fakeDocument({ candidates: [hidden] });
    expect(writeComposer('草稿', doc)).toBe(false);
  });

  it('reports failure when the native insert command is refused', () => {
    const editor = new FakeEditable({ slot: 'conversation.composer' });
    const { doc } = fakeDocument({ candidates: [editor], execResult: false });
    expect(writeComposer('草稿', doc)).toBe(false);
  });
});
