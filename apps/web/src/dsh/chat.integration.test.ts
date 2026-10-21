import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { createDshIntegrationFixture } from './integration-fixture.js';

const fixtures: Awaited<ReturnType<typeof createDshIntegrationFixture>>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});
const setup = async (options: Parameters<typeof createDshIntegrationFixture>[0] = {}) => {
  const fixture = await createDshIntegrationFixture(options);
  fixtures.push(fixture);
  return fixture;
};
const parse = (text: string) =>
  text
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('DSH Web + actual Node/Cordis/Gateway/hosted ledger (controlled providers)', () => {
  it('persists distinct business and native receipts when the provider reuses a tool call ID', async () => {
    const fixture = await setup({ reuseProviderCallId: true });
    const sessionId = await fixture.createSession();
    const chunks = parse(
      await (await fixture.chat(sessionId, '查 002594 行情并读取网页来源')).text(),
    );
    expect(chunks.filter((part) => part.type === 'error')).toEqual([]);
    const calls = chunks.filter((part) => part.type === 'tool-input-available');
    expect(calls.map((part) => part.toolName)).toEqual(['fetch_quote', 'web_fetch']);
    expect(new Set(calls.map((part) => part.toolCallId)).size).toBe(2);
    const messages = await fixture.context.repos.chat.listMessages(sessionId);
    const assistant = messages.find((message) => message.role === 'assistant');
    expect(assistant?.parts).toContainEqual(
      expect.objectContaining({
        type: 'tool-web_fetch',
        state: 'output-available',
        output: expect.objectContaining({
          url: 'https://research.example.test/facts',
          statusCode: 200,
        }),
      }),
    );
    expect(fixture.bodies).toHaveLength(3);
  }, 30_000);

  it('keeps the conversation busy until its assistant message has been persisted', async () => {
    const fixture = await setup();
    const sessionId = await fixture.createSession();
    const saving = deferred();
    const saveGate = deferred();
    let held = false;
    const save = fixture.context.repos.chat.insertMessageIfAbsent.bind(fixture.context.repos.chat);
    const spy = spyOn(fixture.context.repos.chat, 'insertMessageIfAbsent').mockImplementation(
      async (message) => {
        if (message.role === 'assistant' && !held) {
          held = true;
          saving.resolve();
          await saveGate.promise;
        }
        return save(message);
      },
    );
    const first = await fixture.chat(sessionId, '查 002594 行情');
    const firstBody = first.text();
    let following: Response | undefined;
    try {
      await saving.promise;
      following = await fixture.chat(sessionId, '继续刚才的研究');
      expect(following.status).toBe(409);
      expect(fixture.bodies).toHaveLength(3);
    } finally {
      saveGate.resolve();
      await Promise.all([firstBody, following?.text()]);
      spy.mockRestore();
    }
  }, 30_000);

  it('refuses an oversized trusted history explicitly before any model request', async () => {
    const fixture = await setup();
    const sessionId = await fixture.createSession();
    for (let index = 0; index < 20; index++)
      await fixture.context.repos.chat.saveMessage({
        id: `history-${index}`,
        sessionId,
        role: index % 2 === 0 ? 'user' : 'assistant',
        parts: [{ type: 'text', text: `可信历史 ${index}` }],
        createdAt: new Date(Date.UTC(2026, 9, 19, 0, index)),
      });
    const response = await fixture.chat(sessionId, '查 002594 行情');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { kind: 'llm_error', cause: expect.stringContaining('不能截断') },
    });
    expect(fixture.bodies).toHaveLength(0);
  }, 15_000);

  it('reports persistence failure and blocks continuation after actual execution has drained', async () => {
    const fixture = await setup();
    const sessionId = await fixture.createSession();
    const save = fixture.context.repos.chat.insertMessageIfAbsent.bind(fixture.context.repos.chat);
    const spy = spyOn(fixture.context.repos.chat, 'insertMessageIfAbsent').mockImplementation(
      async (message) => {
        if (message.role === 'assistant') throw new Error('private-persistence-detail');
        return save(message);
      },
    );
    let body: string;
    try {
      body = await (await fixture.chat(sessionId, '查 002594 行情')).text();
    } finally {
      spy.mockRestore();
    }
    expect(body).toContain('回答保存失败');
    expect(body).not.toContain('private-persistence-detail');
    expect(fixture.bodies).toHaveLength(3);
    const previousAttempts = fixture.bodies.length;
    const response = await fixture.chat(sessionId, '继续刚才的研究');
    expect(response.status).toBe(409);
    expect(fixture.bodies).toHaveLength(previousAttempts);
  }, 30_000);

  it('delivers real text before provider completion and completes quote + native webpage without duplicate full text', async () => {
    const gate = deferred();
    const fixture = await setup({ firstChunkGate: gate.promise });
    const sessionId = await fixture.createSession();
    const response = await fixture.chat(sessionId, '查 002594 行情并读取网页来源');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-luoome-chat-runtime')).toBe('dsh');
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('missing stream');
    const decoder = new TextDecoder();
    let text = '';
    try {
      while (!text.includes('"type":"text-delta"')) {
        const next = await reader.read();
        if (next.done) throw new Error(`missing real text delta: ${text}`);
        text += decoder.decode(next.value, { stream: true });
      }
      expect(fixture.completedProviders()).toBe(0);
    } finally {
      gate.resolve();
    }
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
    const chunks = parse(text);
    expect(chunks.filter((part) => part.type === 'error')).toEqual([]);
    expect(
      chunks.filter((part) => part.type === 'tool-input-available').map((part) => part.toolName),
    ).toEqual(['fetch_quote', 'web_fetch']);
    const visible = chunks
      .filter((part) => part.type === 'text-delta')
      .map((part) => part.delta)
      .join('');
    expect(visible.split('正在核对事实。')).toHaveLength(2);
    expect(visible).toContain('网页证据来源');
    const messages = await fixture.context.repos.chat.listMessages(sessionId);
    const assistant = messages.find((message) => message.role === 'assistant');
    expect(
      assistant?.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(''),
    ).toBe(visible);
    expect(assistant?.parts).toContainEqual(
      expect.objectContaining({
        type: 'data-luoome-run',
        data: expect.objectContaining({ status: 'completed', executionStopped: true }),
      }),
    );
    expect(fixture.bodies).toHaveLength(3);
    const costs = await fixture.platform.ctx.repos.llm.costs();
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({
      confirmedAttempts: 3,
      unknownAttempts: 0,
      inputTokens: 60,
      outputTokens: 30,
    });
  }, 30_000);

  it('keeps a draft pending, confirms only saved input once and supplies the authoritative receipt in the next rebuilt run', async () => {
    const fixture = await setup();
    const sessionId = await fixture.createSession();
    const before = await fixture.context.repos.watchlist.list();
    const response = await fixture.chat(sessionId, '创建一个观察清单草案');
    const body = await response.text();
    expect(parse(body).filter((part) => part.type === 'error')).toEqual([]);
    const messages = await fixture.context.repos.chat.listMessages(sessionId);
    const assistant = messages.find((message) => message.role === 'assistant');
    const part = assistant?.parts.find((part) => part.type === 'tool-create_watchlist');
    expect(part).toMatchObject({ state: 'output-available', output: { __luoomeDraft: true } });
    expect(await fixture.context.repos.watchlist.list()).toHaveLength(before.length);
    const path = `/api/chat/sessions/${sessionId}/drafts/${assistant?.id}/${String(part?.toolCallId)}`;
    const approve = () =>
      fixture.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      });
    expect((await approve()).status).toBe(200);
    await approve();
    expect(await fixture.context.repos.watchlist.list()).toHaveLength(before.length + 1);
    const next = await fixture.chat(
      sessionId,
      '请根据刚才草案的实际处理结果，说明完成了哪些操作、当前状态和可选的下一步。',
    );
    const nextText = await next.text();
    expect(parse(nextText).filter((part) => part.type === 'error')).toEqual([]);
    expect(parse(nextText).filter((part) => part.type === 'tool-input-available')).toEqual([]);
    expect(JSON.stringify(fixture.bodies.at(-1))).toContain('draftStatus');
    expect(JSON.stringify(fixture.bodies.at(-1))).toContain('succeeded');
    expect(await fixture.context.repos.watchlist.list()).toHaveLength(before.length + 1);
  }, 30_000);

  it('fails explicitly without switching runtime or replaying a rejected provider request', async () => {
    const fixture = await setup({ failProvider: true });
    const sessionId = await fixture.createSession();
    const response = await fixture.chat(sessionId, '查 002594 行情');
    const chunks = parse(await response.text());
    expect(chunks.some((part) => part.type === 'error')).toBe(true);
    expect(fixture.bodies).toHaveLength(1);
    const messages = await fixture.context.repos.chat.listMessages(sessionId);
    expect(messages.at(-1)?.parts).toContainEqual(
      expect.objectContaining({ type: 'data-luoome-stream-error' }),
    );
  }, 30_000);

  it('stops the actual execution and saves partial text while preserving unknown provider cost', async () => {
    const fixture = await setup({ slowProvider: true });
    const sessionId = await fixture.createSession();
    const abort = new AbortController();
    const response = await fixture.chat(sessionId, '慢速查 002594 行情', abort.signal);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('missing stream');
    const decoder = new TextDecoder();
    let body = '';
    while (!body.includes('"type":"text-delta"')) {
      const next = await reader.read();
      if (next.done) throw new Error(`missing partial text: ${body}`);
      body += decoder.decode(next.value, { stream: true });
    }
    abort.abort();
    try {
      while (!(await reader.read()).done) {}
    } catch {
      /* Actual client disconnect. */
    }
    const deadline = Date.now() + 15_000;
    let messages = await fixture.context.repos.chat.listMessages(sessionId);
    while (messages.length < 2 && Date.now() < deadline) {
      await Bun.sleep(25);
      messages = await fixture.context.repos.chat.listMessages(sessionId);
    }
    expect(messages.at(-1)?.parts).toContainEqual({
      type: 'data-luoome-cancelled',
      data: { cancelled: true },
    });
    expect(messages.at(-1)?.parts).toContainEqual(
      expect.objectContaining({
        type: 'data-luoome-run',
        data: expect.objectContaining({ status: 'cancelled', executionStopped: true }),
      }),
    );
    const costs = await fixture.platform.ctx.repos.llm.costs();
    expect(costs[0]).toMatchObject({ unknownAttempts: 1 });
    expect(fixture.bodies).toHaveLength(1);
  }, 30_000);
});
