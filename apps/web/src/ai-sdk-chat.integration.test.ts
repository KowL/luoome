import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ToolContext } from '@luoome/core';
import { AGENT_SCENARIOS, discoverExternalMcpTools } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { z } from 'zod';
import { AiSdkChatRuntime } from './ai-sdk-chat-runtime.js';
import { ChatRuntimeRejection } from './chat.js';
import { McpSettingsStore } from './mcp-settings.js';
import { createWebApp } from './server.js';

const ORIGIN = 'http://127.0.0.1:5187';

type MockStreamResult = Awaited<ReturnType<MockLanguageModelV3['doStream']>>;
type ProviderChunk = MockStreamResult['stream'] extends ReadableStream<infer T> ? T : never;
type CallOptions = Parameters<MockLanguageModelV3['doStream']>[0];
type PromptMessage = CallOptions['prompt'][number];

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
} satisfies Extract<ProviderChunk, { type: 'finish' }>['usage'];

const finish = (unified: 'stop' | 'tool-calls'): ProviderChunk => ({
  type: 'finish',
  finishReason: { unified, raw: unified },
  usage,
});

const modelStream = (chunks: ProviderChunk[]): MockStreamResult => ({
  stream: simulateReadableStream({ chunks, chunkDelayInMs: null }),
});

const textStream = (text: string): MockStreamResult =>
  modelStream([
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: text },
    { type: 'text-end', id: 'text-1' },
    finish('stop'),
  ]);

const toolStream = (toolName: string, input: unknown, id = 'call-1'): MockStreamResult =>
  modelStream([
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id, toolName },
    { type: 'tool-input-delta', id, delta: JSON.stringify(input) },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) },
    finish('tool-calls'),
  ]);

const textOf = (message: PromptMessage): string =>
  typeof message.content === 'string'
    ? message.content
    : message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');

const lastUserText = (options: CallOptions): string => {
  for (let index = options.prompt.length - 1; index >= 0; index -= 1) {
    const message = options.prompt[index];
    if (message?.role === 'user') return textOf(message);
  }
  return '';
};

const offeredTools = (options: CallOptions): string[] =>
  (options.tools ?? []).flatMap((tool) => ('name' in tool ? [tool.name] : []));

const lastRole = (options: CallOptions): string | undefined => options.prompt.at(-1)?.role;

const parseChunks = (text: string): Record<string, unknown>[] =>
  text
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);

interface FixtureOptions {
  readonly externalMcpConfig?: string;
  /** 首次模型调用前的副作用；用于验证已宣告工具的实时撤权。 */
  readonly beforeFirstStream?: () => void;
}

const createFixture = async (options: FixtureOptions = {}) => {
  const ctx: ToolContext = await buildTestContext({
    clock: () => new Date('2026-11-25T01:00:00Z'),
  });
  const calls: CallOptions[] = [];
  let first = true;
  const model = new MockLanguageModelV3({
    doStream: async (callOptions) => {
      calls.push(callOptions);
      if (first) {
        first = false;
        options.beforeFirstStream?.();
      }
      const userText = lastUserText(callOptions);
      const tools = offeredTools(callOptions);
      const afterTool = lastRole(callOptions) === 'tool';
      if (userText.includes('慢速')) {
        return {
          stream: new ReadableStream<ProviderChunk>({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({ type: 'text-start', id: 'text-1' });
              controller.enqueue({ type: 'text-delta', id: 'text-1', delta: '部分' });
              const fail = () =>
                controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              if (callOptions.abortSignal?.aborted) fail();
              else callOptions.abortSignal?.addEventListener('abort', fail, { once: true });
            },
          }),
        };
      }
      if (userText.includes('MCP 文档')) {
        if (tools.includes('mcp_docs__search_docs') && !afterTool)
          return toolStream('mcp_docs__search_docs', { query: 'Watchlist' }, 'mcp-call-1');
        return tools.includes('mcp_docs__search_docs')
          ? textStream('MCP 文档证据已核对完成。')
          : textStream('MCP 文档工具未启用。');
      }
      if (userText.includes('刚才草案'))
        return textStream('已依据确认回执继续解释，未再次执行写入。');
      if (userText.includes('草案')) {
        if (!afterTool)
          return toolStream(
            'create_watchlist',
            { name: 'AI SDK 待确认观察清单', kind: 'personal', membershipPolicy: 'manual' },
            'draft-call-1',
          );
        return textStream('草案已生成，确认前不会创建观察清单。');
      }
      if (userText.includes('行情')) {
        if (!afterTool) return toolStream('fetch_quote', { stockId: '002594.SZ' }, 'quote-call-1');
        return textStream('行情已核对完成。这是受控模拟研究，不构成投资建议。');
      }
      return textStream('通用回答。');
    },
  });

  const runtime = new AiSdkChatRuntime({
    model: {
      model,
      modelRef: 'fixture:chat-model',
      timeoutMs: 5_000,
      maxOutputTokens: 512,
      maxSteps: 8,
      maxRetries: 0,
      maxTotalTokens: 100_000,
    },
    ...(options.externalMcpConfig === undefined
      ? {}
      : {
          externalMcp: (context: ToolContext, scenario: string) =>
            discoverExternalMcpTools(options.externalMcpConfig as string, context, scenario),
        }),
  });

  const app = createWebApp(ctx, {
    exposeWrite: true,
    exposeExternal: true,
    chatStreamRuntime: runtime,
    ...(options.externalMcpConfig === undefined
      ? {}
      : {
          mcpSettingsStore: new McpSettingsStore({
            LUOOME_MCP_CONFIG: options.externalMcpConfig,
          }),
        }),
  });

  const request = (path: string, init: RequestInit = {}) =>
    Promise.resolve(
      app.fetch(
        new Request(`${ORIGIN}${path}`, {
          ...init,
          headers: {
            origin: ORIGIN,
            'content-type': 'application/json',
            ...Object.fromEntries(new Headers(init.headers)),
          },
        }),
      ),
    );

  const createSession = async (): Promise<string> => {
    const response = await request('/api/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: 'AI SDK 模拟研究' }),
    });
    const result = z
      .object({ data: z.object({ session: z.object({ id: z.string() }) }) })
      .parse(await response.json());
    return result.data.session.id;
  };

  const chat = (sessionId: string, text: string, signal?: AbortSignal) =>
    request('/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        sessionId,
        messages: [
          { id: `user-${crypto.randomUUID()}`, role: 'user', parts: [{ type: 'text', text }] },
        ],
      }),
      ...(signal === undefined ? {} : { signal }),
    });

  return { ctx, calls, createSession, chat, request };
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const mcpConfigFile = (enabled: boolean, scenarios = ['research']) => {
  const root = mkdtempSync(join(tmpdir(), 'luoome-mcp-chat-'));
  roots.push(root);
  const config = join(root, 'mcp-servers.json');
  const save = (isEnabled: boolean, serviceScenarios = scenarios) =>
    writeFileSync(
      config,
      JSON.stringify({
        version: 1,
        services: {
          docs: {
            enabled: isEnabled,
            command: process.execPath,
            args: [
              '--no-env-file',
              fileURLToPath(new URL('../../../packages/mcp/src/docs-server.ts', import.meta.url)),
            ],
            tools: ['search_docs'],
            scenarios: serviceScenarios,
          },
        },
      }),
    );
  save(enabled);
  return { config, save };
};

describe('AI SDK 聊天运行时 + 真实 Web 链（受控模型）', () => {
  it('每轮重新发现只读外部 MCP，只在场景白名单内暴露，并在撤权后拒绝执行', async () => {
    const { config, save } = mcpConfigFile(true);
    const fixture = await createFixture({
      externalMcpConfig: config,
      beforeFirstStream: () => save(false),
    });
    const first = await fixture.chat(await fixture.createSession(), '研究 MCP 文档中的 Watchlist');
    expect(first.status).toBe(200);
    const chunks = parseChunks(await first.text());
    expect(chunks.filter((part) => part.type === 'error')).toEqual([]);
    expect(
      chunks.filter((part) => part.type === 'tool-input-available').map((part) => part.toolName),
    ).toEqual(['mcp_docs__search_docs']);
    // 首个模型请求已经看到外部工具；执行前配置被关闭，工具按 permission_denied 返回错误。
    expect(JSON.stringify(fixture.calls[0]?.tools)).toContain('mcp_docs__search_docs');
    expect(chunks.find((part) => part.type === 'tool-output-available')?.output).toMatchObject({
      error: { kind: 'permission_denied', required: 'mcp:docs' },
    });
    expect(JSON.stringify(fixture.calls[0]?.prompt)).not.toContain('CONTEXT.md');

    save(true);
    const sessionId = await fixture.createSession();
    const enabled = parseChunks(
      await (await fixture.chat(sessionId, '研究 MCP 文档中的 Watchlist')).text(),
    );
    expect(enabled.filter((part) => part.type === 'error')).toEqual([]);
    const outputs = enabled.filter((part) => part.type === 'tool-output-available');
    expect(outputs).toHaveLength(1);
    expect(JSON.stringify(outputs[0]?.output)).toContain('CONTEXT.md');
    expect(
      enabled
        .filter((part) => part.type === 'text-delta')
        .map((part) => part.delta)
        .join(''),
    ).toContain('MCP 文档证据已核对完成');
    const messages = await fixture.ctx.repos.chat.listMessages(sessionId);
    expect(messages.findLast((message) => message.role === 'assistant')?.parts).toContainEqual(
      expect.objectContaining({ type: 'tool-mcp_docs__search_docs', state: 'output-available' }),
    );

    save(true, ['review']);
    const other = parseChunks(
      await (
        await fixture.chat(await fixture.createSession(), '研究 MCP 文档中的 Watchlist')
      ).text(),
    );
    expect(other.filter((part) => part.type === 'tool-input-available')).toEqual([]);
  }, 30_000);

  it('续接历史时把上一轮工具结果与文本交给模型，但不重放工具', async () => {
    const fixture = await createFixture();
    const sessionId = await fixture.createSession();
    await (await fixture.chat(sessionId, '查 002594 行情')).text();
    const second = await fixture.chat(sessionId, '继续刚才的研究');
    expect(second.status).toBe(200);
    const chunks = parseChunks(await second.text());
    expect(chunks.filter((part) => part.type === 'error')).toEqual([]);
    const prompt = JSON.stringify(fixture.calls.at(-1)?.prompt);
    expect(prompt).toContain('行情已核对完成');
    expect(prompt).toContain('002594.SZ');
    // 第二轮只发生一次模型调用：历史工具结果来自 ChatRepository，不重新执行。
    expect(fixture.calls).toHaveLength(3);
  }, 20_000);

  it('取消时保存已收到的部分文本并标记 cancelled，不写 stream-error', async () => {
    const fixture = await createFixture();
    const sessionId = await fixture.createSession();
    const controller = new AbortController();
    const response = await fixture.chat(sessionId, '慢速核对一下', controller.signal);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('missing chat stream');
    const decoder = new TextDecoder();
    let body = '';
    while (!body.includes('"type":"text-delta"')) {
      const next = await reader.read();
      if (next.done) throw new Error('missing first delta');
      body += decoder.decode(next.value, { stream: true });
    }
    controller.abort();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      body += decoder.decode(next.value, { stream: true });
    }
    const chunks = parseChunks(body);
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'abort' }));
    expect(chunks.filter((part) => part.type === 'data-luoome-stream-error')).toEqual([]);
    const messages = await fixture.ctx.repos.chat.listMessages(sessionId);
    const assistant = messages.findLast((message) => message.role === 'assistant');
    expect(assistant?.parts).toContainEqual({
      type: 'data-luoome-cancelled',
      data: { cancelled: true },
    });
    expect(assistant?.parts).toContainEqual(
      expect.objectContaining({ type: 'text', text: '部分' }),
    );
    expect(assistant?.parts.some((part) => part.type === 'data-luoome-stream-error')).toBe(false);
  }, 20_000);

  it('草案只落库为待确认记录；用户确认后才真正执行写入，下一轮带权威回执', async () => {
    const fixture = await createFixture();
    const sessionId = await fixture.createSession();
    const chunks = parseChunks(
      await (await fixture.chat(sessionId, '帮我生成一个观察清单草案')).text(),
    );
    expect(chunks.filter((part) => part.type === 'error')).toEqual([]);
    expect(await fixture.ctx.repos.watchlist.list()).toEqual([]);
    const messageId = z.string().parse(chunks.find((part) => part.type === 'start')?.messageId);
    const call = chunks.find((part) => part.type === 'tool-input-available');
    expect(call?.toolName).toBe('create_watchlist');
    const toolCallId = z.string().parse(call?.toolCallId);
    const assistant = (await fixture.ctx.repos.chat.listMessages(sessionId)).findLast(
      (message) => message.role === 'assistant',
    );
    expect(assistant?.parts).toContainEqual(
      expect.objectContaining({
        type: 'tool-create_watchlist',
        state: 'output-available',
        output: expect.objectContaining({ __luoomeDraft: true }),
      }),
    );

    const settled = await fixture.request(
      `/api/chat/sessions/${sessionId}/drafts/${messageId}/${toolCallId}`,
      { method: 'POST', body: JSON.stringify({ approved: true }) },
    );
    expect(settled.status).toBe(200);
    expect(await fixture.ctx.repos.watchlist.list()).toHaveLength(1);

    const followUp = parseChunks(
      await (await fixture.chat(sessionId, '请解释刚才草案的确认结果')).text(),
    );
    expect(followUp.filter((part) => part.type === 'error')).toEqual([]);
    expect(JSON.stringify(fixture.calls.at(-1)?.prompt)).toContain('"draftStatus":"succeeded"');
    expect(
      followUp
        .filter((part) => part.type === 'text-delta')
        .map((part) => part.delta)
        .join(''),
    ).toContain('已依据确认回执继续解释');
  }, 30_000);

  it('助手消息保存失败时让调用方看到错误，而不是静默完成', async () => {
    const fixture = await createFixture();
    const sessionId = await fixture.createSession();
    const save = fixture.ctx.repos.chat.insertMessageIfAbsent.bind(fixture.ctx.repos.chat);
    const spy = spyOn(fixture.ctx.repos.chat, 'insertMessageIfAbsent').mockImplementation(
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
    const chunks = parseChunks(body);
    expect(chunks.filter((part) => part.type === 'error')).toContainEqual(
      expect.objectContaining({ errorText: expect.stringContaining('助手回答保存失败') }),
    );
    expect(chunks.filter((part) => part.type === 'finish')).toEqual([]);
    expect(body).not.toContain('private-persistence-detail');
  }, 20_000);

  it('历史超限在模型调用前明确拒绝，不静默截断', async () => {
    const fixture = await createFixture();
    const model = new MockLanguageModelV3({ doStream: async () => textStream('不应发生') });
    const runtime = new AiSdkChatRuntime({
      model: {
        model,
        modelRef: 'fixture:model',
        timeoutMs: 5_000,
        maxOutputTokens: 512,
        maxSteps: 8,
        maxRetries: 0,
        maxTotalTokens: 100_000,
      },
    });
    await expect(
      runtime.createUIMessageStreamResponse({
        instructions: 'system',
        uiMessages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: '继续' }] }],
        tools: [],
        execution: {
          context: fixture.ctx,
          runId: 'run-1',
          conversationId: 'history-limit',
          scenario: AGENT_SCENARIOS.general,
          historyTruncated: true,
        },
      }),
    ).rejects.toThrow(ChatRuntimeRejection);
    expect(model.doStreamCalls).toHaveLength(0);
  }, 20_000);
});
