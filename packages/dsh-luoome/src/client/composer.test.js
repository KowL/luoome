// 会话输入框写入单测：DSH 官方 composer 是 Lexical contenteditable（不是 textarea），
// 只覆盖 textarea 会让「在对话中研究此策略」永远写不进草稿。这里锁住两条路径与失败语义。
import { describe, expect, it, vi } from 'vitest';
import { findComposer, sendStockAnalysis, writeComposer } from './composer.js';

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

describe('stock analysis conversation submission', () => {
  const setup = (prompt = vi.fn(async () => ({ ok: true, value: { accepted: true } }))) => {
    const events = [];
    const reference = {
      binding: {
        session: {
          prompt: async (...args) => {
            events.push('prompt');
            return await prompt(...args);
          },
        },
      },
    };
    const ctx = {
      sessions: {
        create: vi.fn(async () => {
          events.push('create');
          return 'stock-session';
        }),
        using: vi.fn(async (_id, _options, run) => {
          events.push('retain');
          try {
            return await run(reference);
          } finally {
            events.push('release');
          }
        }),
        scope: vi.fn(() => {
          throw new Error('cannot get conversation without inject');
        }),
      },
      uiWorkspace: { openSession: vi.fn(() => events.push('open')) },
    };
    return { ctx, prompt, events };
  };

  it('submits once through the retained public SessionFace and opens it after admission', async () => {
    const { ctx, prompt, events } = setup();
    await expect(sendStockAnalysis(ctx, { prompt: '分析贵州茅台（600519.SH）' })).resolves.toBe(
      'stock-session',
    );
    expect(prompt).toHaveBeenCalledExactlyOnceWith(
      [{ type: 'text', text: '分析贵州茅台（600519.SH）' }],
      'queue',
    );
    expect(ctx.sessions.using).toHaveBeenCalledWith(
      'stock-session',
      { source: 'workspaceOperation' },
      expect.any(Function),
    );
    expect(ctx.sessions.scope).not.toHaveBeenCalled();
    expect(events).toEqual(['create', 'retain', 'prompt', 'open', 'release']);
  });

  it('releases a transport failure without retrying or navigating away', async () => {
    const { ctx, prompt, events } = setup(
      vi.fn(async () => {
        throw new Error('admission failed');
      }),
    );
    await expect(sendStockAnalysis(ctx, { prompt: '分析股票' })).rejects.toThrow(
      'admission failed',
    );
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled();
    expect(events).toEqual(['create', 'retain', 'prompt', 'release']);
  });

  it('does not report a rejected host admission as a successful analysis', async () => {
    const { ctx, prompt } = setup(
      vi.fn(async () => ({ ok: false, error: { code: 'session/not-ready' } })),
    );
    await expect(sendStockAnalysis(ctx, { prompt: '分析股票' })).rejects.toMatchObject({
      code: 'session/not-ready',
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled();
  });

  it('does not send when session creation fails', async () => {
    const { ctx, prompt } = setup();
    ctx.sessions.create.mockRejectedValue(new Error('offline'));
    await expect(sendStockAnalysis(ctx, { prompt: '分析股票' })).rejects.toThrow('offline');
    expect(prompt).not.toHaveBeenCalled();
    expect(ctx.sessions.using).not.toHaveBeenCalled();
  });
});
