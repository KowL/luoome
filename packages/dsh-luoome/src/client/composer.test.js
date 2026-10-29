// 会话输入框写入单测：DSH 官方 composer 是 Lexical contenteditable（不是 textarea），
// 只覆盖 textarea 会让「在对话中研究此策略」永远写不进草稿。这里锁住两条路径与失败语义。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findComposer,
  sendStockAnalysis,
  writeComposer,
  writeComposerWithSessionFallback,
} from './composer.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

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

const fakeDocument = ({ candidates = [], execResult = true, onInsert = () => {} } = {}) => {
  const inserted = [];
  const selection = { removeAllRanges: () => {}, addRange: () => {} };
  return {
    inserted,
    doc: {
      querySelectorAll: () => candidates,
      createRange: () => ({ selectNodeContents: () => {} }),
      execCommand: (command, _ui, text) => {
        inserted.push({ command, text });
        onInsert(text, command);
        return execResult;
      },
      defaultView: { getSelection: () => selection },
    },
  };
};

const fakeLexicalDocument = ({ editor, deferred = false } = {}) => {
  let pending = '';
  return fakeDocument({
    candidates: [editor],
    onInsert: (text, command) => {
      if (command === 'insertText') pending += text.replaceAll('\n', '');
      if (command === 'insertLineBreak') pending += '\n';
      const commit = () => {
        editor.innerText = `${pending}\n`;
      };
      if (deferred) queueMicrotask(commit);
      else commit();
    },
  });
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

  it('preserves internal and blank lines with native line-break commands', () => {
    const editor = new FakeEditable({ slot: 'conversation.composer' });
    const prompt = '管理关注列表\n\n保留策略来源\n不启动交易';
    const { doc, inserted } = fakeLexicalDocument({ editor });
    expect(writeComposer(prompt, doc)).toBe(true);
    expect(editor.innerText).toBe(`${prompt}\n`);
    expect(
      inserted.filter((item) => item.command === 'insertText').map((item) => item.text),
    ).toEqual(['管理关注列表', '保留策略来源', '不启动交易']);
    expect(inserted.filter((item) => item.command === 'insertLineBreak')).toHaveLength(3);
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

  it('accepts only browser trailing newlines when the multiline contenteditable already matches', () => {
    const editor = new FakeEditable({ slot: 'conversation.composer' });
    const prompt = '第一段管理意图\n第二段操作边界\n第三段保留来源';
    editor.innerText = `${prompt}\n`;
    const { doc, inserted } = fakeDocument({ candidates: [editor] });
    expect(writeComposer(prompt, doc)).toBe(true);
    expect(inserted).toEqual([]);
    editor.innerText = '第一段管理意图 第二段操作边界\n第三段保留来源';
    expect(writeComposer(prompt, doc)).toBe(false);
    expect(inserted).toEqual([]);
    editor.innerText = ` ${prompt}`;
    expect(writeComposer(prompt, doc)).toBe(false);
    expect(inserted).toEqual([]);
  });

  it('preserves exact trailing newlines in textarea drafts', () => {
    const area = new FakeTextarea({ slot: 'conversation.composer' });
    area.value = '原草稿\n';
    const { doc } = fakeDocument({ candidates: [area] });
    expect(writeComposer('原草稿', doc)).toBe(false);
    expect(area.value).toBe('原草稿\n');
  });

  it('preserves an existing conversation draft and allows the session fallback to take over', () => {
    const area = new FakeTextarea({ slot: 'conversation.composer' });
    area.value = '我尚未发送的问题';
    const { doc } = fakeDocument({ candidates: [area] });
    expect(writeComposer('新的策略研究', doc)).toBe(false);
    expect(area.value).toBe('我尚未发送的问题');
    expect(writeComposer('我尚未发送的问题', doc)).toBe(true);
  });
});

describe('composer session fallback', () => {
  it('uses workspace navigation to create a fresh editable session after a read-only session', async () => {
    let selected = 'read-only-session';
    const ctx = {
      layout: { selectPanel: vi.fn() },
      sessions: {
        create: vi.fn(async () => 'unbound-session'),
        list: {
          getSnapshot: () => ({
            byId: { [selected]: { id: selected, retainedBy: { mainView: 1 } } },
          }),
        },
      },
      uiWorkspace: {
        openSession: vi.fn((id) => {
          selected = id;
        }),
        startSession: vi.fn(() => {
          selected = 'workspace-draft-session';
        }),
      },
    };
    const result = await writeComposerWithSessionFallback(ctx, '请管理策略', {
      write: () => selected === 'workspace-draft-session',
      delays: [0],
    });
    expect(result).toEqual({ createdSession: true, sessionId: 'workspace-draft-session' });
    expect(ctx.uiWorkspace.startSession).toHaveBeenCalledExactlyOnceWith();
    expect(ctx.sessions.create).not.toHaveBeenCalled();
  });

  const setup = (write) => {
    let selected = 'current-session';
    return {
      ctx: {
        layout: { selectPanel: vi.fn() },
        sessions: {
          create: vi.fn(async () => 'unbound-session'),
          list: {
            getSnapshot: () => ({
              byId: { [selected]: { id: selected, retainedBy: { mainView: 1 } } },
            }),
          },
        },
        uiWorkspace: {
          startSession: vi.fn(() => {
            selected = 'draft-session';
          }),
        },
      },
      write,
    };
  };

  it('creates an editable draft session without sending a prompt when the current one is read-only', async () => {
    let editable = false;
    const { ctx, write } = setup(vi.fn(() => editable));
    const startSession = ctx.uiWorkspace.startSession.getMockImplementation();
    ctx.uiWorkspace.startSession.mockImplementation(() => {
      startSession();
      editable = true;
    });
    const result = await writeComposerWithSessionFallback(ctx, '请管理策略', {
      write,
      delays: [0],
    });
    expect(result).toEqual({ createdSession: true, sessionId: 'draft-session' });
    expect(ctx.sessions.create).not.toHaveBeenCalled();
    expect(ctx.uiWorkspace.startSession).toHaveBeenCalledExactlyOnceWith();
    expect(write).toHaveBeenCalledTimes(2);
    expect(ctx.sessions.prompt).toBeUndefined();
  });

  it('keeps the current session when the composer write succeeds', async () => {
    const { ctx, write } = setup(vi.fn(() => true));
    const result = await writeComposerWithSessionFallback(ctx, '研究策略', {
      write,
      delays: [0],
    });
    expect(result).toEqual({ createdSession: false, sessionId: null });
    expect(ctx.sessions.create).not.toHaveBeenCalled();
    expect(ctx.uiWorkspace.startSession).not.toHaveBeenCalled();
  });

  it('verifies inserted text even when the native command reports false', async () => {
    const editor = new FakeEditable({ slot: 'conversation.composer' });
    const prompt = '管理关注列表并保留策略与手动来源';
    const { doc } = fakeDocument({
      candidates: [editor],
      execResult: false,
      onInsert: (text) => {
        editor.innerText = `${text}\n`;
      },
    });
    vi.stubGlobal('document', doc);
    const { ctx } = setup();
    await expect(writeComposerWithSessionFallback(ctx, prompt, { delays: [0] })).resolves.toEqual({
      createdSession: false,
      sessionId: null,
    });
    expect(ctx.uiWorkspace.startSession).not.toHaveBeenCalled();
  });

  it('waits for the editor microtask commit before starting a fallback session', async () => {
    const editor = new FakeEditable({ slot: 'conversation.composer' });
    const prompt = '管理关注列表\n不覆盖已有草稿';
    const { doc, inserted } = fakeLexicalDocument({ editor, deferred: true });
    vi.stubGlobal('document', doc);
    const { ctx } = setup();
    await expect(writeComposerWithSessionFallback(ctx, prompt, { delays: [0] })).resolves.toEqual({
      createdSession: false,
      sessionId: null,
    });
    expect(inserted.map((item) => item.command)).toEqual([
      'insertText',
      'insertLineBreak',
      'insertText',
    ]);
    expect(editor.innerText).toBe(`${prompt}\n`);
    expect(ctx.uiWorkspace.startSession).not.toHaveBeenCalled();
  });

  it('rejects lost internal newlines instead of accepting flattened multiline text', async () => {
    const editor = new FakeEditable({ slot: 'conversation.composer' });
    const prompt = '管理关注列表\n保留策略来源';
    const flattened = prompt.replaceAll('\n', '');
    const { doc, inserted } = fakeDocument({
      candidates: [editor],
      onInsert: () => {
        editor.innerText = flattened;
      },
    });
    vi.stubGlobal('document', doc);
    const { ctx } = setup();
    await expect(writeComposerWithSessionFallback(ctx, prompt, { delays: [0] })).rejects.toThrow(
      'DSH composer unavailable',
    );
    expect(editor.innerText).toBe(flattened);
    expect(inserted.filter((item) => item.command === 'insertText')).toHaveLength(2);
    expect(inserted.filter((item) => item.command === 'insertLineBreak')).toHaveLength(1);
  });

  it('does not mistake a larger inserted draft containing the prompt for an exact match', async () => {
    const editor = new FakeEditable({ slot: 'conversation.composer' });
    const prompt = '管理关注列表\n保留策略来源';
    const { doc } = fakeDocument({
      candidates: [editor],
      onInsert: (text) => {
        editor.innerText = `其他内容${text}`;
      },
    });
    vi.stubGlobal('document', doc);
    const { ctx } = setup();
    await expect(writeComposerWithSessionFallback(ctx, prompt, { delays: [0] })).rejects.toThrow(
      'DSH composer unavailable',
    );
    expect(editor.innerText.startsWith('其他内容')).toBe(true);
    expect(editor.innerText).not.toBe(prompt);
  });

  it('awaits asynchronous session navigation before reporting the fallback outcome', async () => {
    let selected = 'current-session';
    let finishNavigation;
    const ctx = {
      layout: { selectPanel: vi.fn() },
      sessions: {
        list: {
          getSnapshot: () => ({
            byId: { [selected]: { id: selected, retainedBy: { mainView: 1 } } },
          }),
        },
      },
      uiWorkspace: {
        startSession: vi.fn(
          () =>
            new Promise((resolve) => {
              finishNavigation = () => {
                selected = 'draft-session';
                resolve();
              };
            }),
        ),
      },
    };
    const write = vi.fn(() => selected === 'draft-session');
    const result = writeComposerWithSessionFallback(ctx, '管理关注列表', { write, delays: [0] });
    const settled = vi.fn();
    void result.then(settled, settled);
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.uiWorkspace.startSession).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    finishNavigation();
    await expect(result).resolves.toEqual({ createdSession: true, sessionId: 'draft-session' });
  });

  it('does not claim success when the new composer is also unavailable', async () => {
    const { ctx, write } = setup(vi.fn(() => false));
    await expect(
      writeComposerWithSessionFallback(ctx, '研究策略', { write, delays: [0] }),
    ).rejects.toThrow('DSH composer unavailable');
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('propagates refused workspace navigation without claiming a draft', async () => {
    const { ctx, write } = setup(vi.fn(() => false));
    ctx.uiWorkspace.startSession.mockImplementation(() => {
      throw new Error('offline');
    });
    await expect(
      writeComposerWithSessionFallback(ctx, '研究策略', { write, delays: [0] }),
    ).rejects.toThrow('offline');
    expect(ctx.sessions.create).not.toHaveBeenCalled();
  });

  it('does not write into the old session while workspace navigation is pending', async () => {
    const { ctx, write } = setup(vi.fn(() => false));
    ctx.uiWorkspace.startSession.mockImplementation(() => {});
    await expect(
      writeComposerWithSessionFallback(ctx, '研究策略', { write, delays: [0] }),
    ).rejects.toThrow('DSH composer unavailable');
    expect(write).toHaveBeenCalledTimes(1);
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
