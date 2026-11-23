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
const promptOf = (body: unknown) => {
  const messages = (body as { messages: { role: string; content: unknown }[] }).messages;
  // resume 之后 provider 请求会带上会话历史；本轮 prompt 是最后一条带 trustedHistory 的 user 消息。
  let prompt: {
    trustedHistory: { id: string; role: string; parts: unknown[] }[];
    settledDraftReceipts?: { toolCallId: string; tool: string; draftStatus: string }[];
  } = { trustedHistory: [] };
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user' || typeof message.content !== 'string') continue;
    try {
      const parsed = JSON.parse(message.content) as typeof prompt;
      if (Array.isArray(parsed.trustedHistory)) {
        prompt = parsed;
        break;
      }
    } catch {
      /* 运行时注入的非 prompt user 消息。 */
    }
  }
  return prompt;
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('DSH Web + actual Node/Cordis/Gateway (controlled providers)', () => {
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

  it('refuses an oversized trusted history and requires handoff before any model request', async () => {
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
    expect(response.headers.get('x-luoome-chat-handoff')).toBe('required');
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { kind: 'invalid_input', message: expect.stringContaining('新建关联会话') },
    });
    expect(fixture.bodies).toHaveLength(0);
  }, 15_000);

  it('bounds an oversized tool output in the rebuilt history, keeps running and tells the user', async () => {
    const fixture = await setup();
    const sessionId = await fixture.createSession();
    const largeOutput = { plans: 'x'.repeat(300_000) };
    await fixture.context.repos.chat.saveMessage({
      id: 'oversized-history-user',
      sessionId,
      role: 'user',
      parts: [{ type: 'text', text: '之前查过观察清单' }],
      createdAt: new Date('2026-10-19T00:00:00Z'),
    });
    await fixture.context.repos.chat.saveMessage({
      id: 'oversized-history-assistant',
      sessionId,
      role: 'assistant',
      parts: [
        { type: 'text', text: '这是之前查到的观察清单。' },
        {
          type: 'tool-list_watch_plans',
          toolCallId: 'oversized-history-call',
          state: 'output-available',
          output: largeOutput,
        },
      ],
      createdAt: new Date('2026-10-19T00:01:00Z'),
    });
    const response = await fixture.chat(sessionId, '查 002594 行情并读取网页来源');
    expect(response.status).toBe(200);
    const chunks = parse(await response.text());
    expect(chunks.filter((part) => part.type === 'error')).toEqual([]);
    const runtimePart = chunks.find((part) => part.type === 'data-luoome-runtime');
    expect(runtimePart?.data).toMatchObject({ notice: expect.stringContaining('已截断 1 条') });
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'data-luoome-run',
        data: expect.objectContaining({ status: 'completed' }),
      }),
    );
    const prompt = JSON.stringify(fixture.bodies[0]);
    expect(prompt).toContain('truncated');
    expect(prompt).not.toContain('x'.repeat(1_000));
    const messages = await fixture.context.repos.chat.listMessages(sessionId);
    const assistant = messages.findLast((message) => message.role === 'assistant');
    expect(assistant?.parts).toContainEqual(
      expect.objectContaining({
        type: 'data-luoome-runtime',
        data: expect.objectContaining({ notice: expect.stringContaining('已截断 1 条') }),
      }),
    );
  }, 30_000);

  it('retries one transient 5xx or transport timeout and completes without an error part', async () => {
    for (const options of [
      { transientProviderFailures: 1 },
      { transientProviderTimeouts: 1 },
    ] as const) {
      const fixture = await setup({ ...options, maxRetries: 1 });
      const sessionId = await fixture.createSession();
      const chunks = parse(
        await (await fixture.chat(sessionId, '查 002594 行情并读取网页来源')).text(),
      );
      expect(chunks.filter((part) => part.type === 'error')).toEqual([]);
      expect(chunks).toContainEqual(
        expect.objectContaining({
          type: 'data-luoome-run',
          data: expect.objectContaining({ status: 'completed' }),
        }),
      );
      expect(fixture.completedProviders()).toBe(3);
      expect(fixture.bodies).toHaveLength(4);
    }
  }, 60_000);

  it('shows the failure after retries are exhausted and keeps the same session usable', async () => {
    const fixture = await setup({ transientProviderFailures: 2, maxRetries: 1 });
    const sessionId = await fixture.createSession();
    const first = parse(await (await fixture.chat(sessionId, '查 002594 行情')).text());
    const firstError = first.find((part) => part.type === 'error');
    expect(firstError).toBeDefined();
    expect(String(firstError?.errorText)).toContain('未完成');
    expect(String(firstError?.errorText)).toContain('重试');
    expect(fixture.bodies).toHaveLength(2);
    const second = await fixture.chat(sessionId, '继续刚才的研究');
    expect(second.status).toBe(200);
    const chunks = parse(await second.text());
    expect(chunks.filter((part) => part.type === 'error')).toEqual([]);
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'data-luoome-run',
        data: expect.objectContaining({ status: 'completed' }),
      }),
    );
    expect(fixture.bodies).toHaveLength(5);
  }, 60_000);

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
  }, 30_000);

  it('keeps a draft pending, confirms only saved input once and supplies the authoritative receipt in the next incremental run', async () => {
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

  it('cancels a pending draft without writing, and a later confirmation stays cancelled', async () => {
    const fixture = await setup();
    const sessionId = await fixture.createSession();
    const before = await fixture.context.repos.watchlist.list();
    const draftBody = parse(await (await fixture.chat(sessionId, '创建一个观察清单草案')).text());
    expect(draftBody.filter((part) => part.type === 'error')).toEqual([]);
    const messages = await fixture.context.repos.chat.listMessages(sessionId);
    const assistant = messages.find((message) => message.role === 'assistant');
    const part = assistant?.parts.find((part) => part.type === 'tool-create_watchlist');
    const path = `/api/chat/sessions/${sessionId}/drafts/${assistant?.id}/${String(part?.toolCallId)}`;
    const settle = (approved: boolean) =>
      fixture.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved }),
      });
    const cancelled = await (await settle(false)).json();
    expect(cancelled).toMatchObject({ ok: true, data: { status: 'cancelled' } });
    expect(await fixture.context.repos.watchlist.list()).toHaveLength(before.length);
    expect(await (await settle(false)).json()).toMatchObject({
      ok: true,
      data: { status: 'cancelled' },
    });
    expect(await (await settle(true)).json()).toMatchObject({
      ok: true,
      data: { status: 'cancelled' },
    });
    expect(await fixture.context.repos.watchlist.list()).toHaveLength(before.length);
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
    expect(fixture.bodies).toHaveLength(1);
  }, 30_000);

  it('delivers only the post-cursor increment on later turns and reuses the runtime session identity', async () => {
    const fixture = await setup();
    const sessionId = await fixture.createSession();
    await (await fixture.chat(sessionId, '创建一个观察清单草案')).text();
    const first = await fixture.context.repos.agentSessionBinding.findByConversation(sessionId);
    expect(first).toMatchObject({ status: 'active', contextMode: 'rebuilt-history' });
    expect(first?.dshSessionId).toBeTruthy();
    expect(first?.lastSyncedMessageId).toBeTruthy();

    const second = await fixture.chat(sessionId, '继续刚才的研究');
    expect(second.status).toBe(200);
    await second.text();
    const prompt = promptOf(fixture.bodies.at(-1));
    expect(prompt.trustedHistory).toHaveLength(1);
    expect(prompt.trustedHistory[0]).toMatchObject({ role: 'user' });
    expect(prompt.settledDraftReceipts).toBeUndefined();
    const binding = await fixture.context.repos.agentSessionBinding.findByConversation(sessionId);
    expect(binding?.dshSessionId).toBe(first?.dshSessionId);
    expect(binding?.lastSyncedMessageId).not.toBe(first?.lastSyncedMessageId);
  }, 30_000);

  it('injects a settled receipt exactly once and not again after a restart on the same database', async () => {
    const fixture = await setup();
    const sessionId = await fixture.createSession();
    await (await fixture.chat(sessionId, '创建一个观察清单草案')).text();
    const messages = await fixture.context.repos.chat.listMessages(sessionId);
    const assistant = messages.find((message) => message.role === 'assistant');
    const part = assistant?.parts.find((part) => part.type === 'tool-create_watchlist');
    const path = `/api/chat/sessions/${sessionId}/drafts/${assistant?.id}/${String(part?.toolCallId)}`;
    await fixture.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    });
    await fixture.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    });

    const confirmed = await fixture.chat(
      sessionId,
      '请根据刚才草案的实际处理结果，说明完成了哪些操作、当前状态和可选的下一步。',
    );
    const confirmedBody = parse(await confirmed.text());
    expect(confirmedBody.filter((part) => part.type === 'tool-input-available')).toEqual([]);
    const firstPrompt = promptOf(fixture.bodies.at(-1));
    expect(firstPrompt.settledDraftReceipts).toHaveLength(1);
    expect(firstPrompt.settledDraftReceipts?.[0]).toMatchObject({
      draftStatus: 'succeeded',
      tool: 'create_watchlist',
    });
    expect(JSON.stringify(firstPrompt).split(String(part?.toolCallId)).length - 1).toBe(1);
    expect(firstPrompt.trustedHistory).toHaveLength(1);

    // 模拟服务重启（新 runtime/client 实例、同一数据库）。
    const restarted = fixture.restart();
    const next = await restarted.chat(
      sessionId,
      '请根据刚才草案的实际处理结果，说明当前状态，不要重复已确认的操作。',
    );
    expect(next.status).toBe(200);
    const nextBody = parse(await next.text());
    expect(nextBody.filter((part) => part.type === 'error')).toEqual([]);
    expect(nextBody.filter((part) => part.type === 'tool-input-available')).toEqual([]);
    const nextPrompt = promptOf(fixture.bodies.at(-1));
    expect(nextPrompt.settledDraftReceipts).toBeUndefined();
    expect(nextPrompt.trustedHistory).toHaveLength(1);
    expect(JSON.stringify(nextPrompt)).not.toContain(String(part?.toolCallId));
  }, 60_000);

  it('invalidates the binding and rebuilds trusted history when the model config changes', async () => {
    const fixture = await setup();
    const sessionId = await fixture.createSession();
    await (await fixture.chat(sessionId, '创建一个观察清单草案')).text();
    const first = await fixture.context.repos.agentSessionBinding.findByConversation(sessionId);
    expect(first?.configHash).toBeTruthy();

    const restarted = fixture.restart({ maxTokens: 2048 });
    const response = await restarted.chat(sessionId, '继续刚才的研究');
    expect(response.status).toBe(200);
    const chunks = parse(await response.text());
    expect(chunks.filter((part) => part.type === 'error')).toEqual([]);
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'data-luoome-runtime',
        data: expect.objectContaining({
          contextMode: 'rebuilt-history',
          recovered: true,
        }),
      }),
    );
    const prompt = promptOf(fixture.bodies.at(-1));
    expect(prompt.trustedHistory).toHaveLength(3);
    const binding = await fixture.context.repos.agentSessionBinding.findByConversation(sessionId);
    expect(binding?.configHash).not.toBe(first?.configHash);
    expect(binding?.status).toBe('active');
    expect(binding?.dshSessionId).not.toBe(first?.dshSessionId);
  }, 30_000);

  it('reconciles a saved receipt whose cursor was not advanced without injecting it twice', async () => {
    const fixture = await setup();
    const sessionId = await fixture.createSession();
    await (await fixture.chat(sessionId, '创建一个观察清单草案')).text();
    const messages = await fixture.context.repos.chat.listMessages(sessionId);
    const assistant = messages.find((message) => message.role === 'assistant');
    const part = assistant?.parts.find((part) => part.type === 'tool-create_watchlist');
    await fixture.request(
      `/api/chat/sessions/${sessionId}/drafts/${assistant?.id}/${String(part?.toolCallId)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      },
    );
    const beforeCrash =
      await fixture.context.repos.agentSessionBinding.findByConversation(sessionId);
    const confirmed = await fixture.chat(
      sessionId,
      '请根据刚才草案的实际处理结果，说明完成了哪些操作、当前状态和可选的下一步。',
    );
    await confirmed.text();
    const confirmedPrompt = promptOf(fixture.bodies.at(-1));
    expect(confirmedPrompt.settledDraftReceipts).toHaveLength(1);
    const afterConfirm =
      await fixture.context.repos.agentSessionBinding.findByConversation(sessionId);

    // 模拟崩溃窗口：答案已保存，但游标更新丢失（仍停在确认回执之前）。
    const crashed = {
      ...(beforeCrash as NonNullable<typeof beforeCrash>),
      pendingRunId: 'crashed-run',
      pendingAssistantMessageId: afterConfirm?.lastSyncedMessageId ?? '',
      pendingMessageId: afterConfirm?.lastSyncedMessageId ?? null,
      pendingReceiptsCursor: afterConfirm?.settledDraftReceiptsCursor ?? null,
      pendingClaimedAt: new Date(),
      updatedAt: new Date(),
    };
    await fixture.context.repos.agentSessionBinding.save({
      ...crashed,
      pendingRunId: null,
      pendingAssistantMessageId: null,
      pendingMessageId: null,
      pendingReceiptsCursor: null,
      pendingClaimedAt: null,
    });
    expect(await fixture.context.repos.agentSessionBinding.claim(crashed)).toBe(true);

    const next = await fixture.chat(sessionId, '继续研究，不要重复已确认的操作');
    expect(next.status).toBe(200);
    const nextBody = parse(await next.text());
    expect(nextBody.filter((part) => part.type === 'error')).toEqual([]);
    const nextPrompt = promptOf(fixture.bodies.at(-1));
    expect(nextPrompt.settledDraftReceipts).toBeUndefined();
    expect(nextPrompt.trustedHistory).toHaveLength(1);
    const reconciled =
      await fixture.context.repos.agentSessionBinding.findByConversation(sessionId);
    expect(reconciled?.settledDraftReceiptsCursor).toBe(afterConfirm?.settledDraftReceiptsCursor);
    expect(reconciled?.dshSessionId).toBe(beforeCrash?.dshSessionId);
  }, 60_000);
});
