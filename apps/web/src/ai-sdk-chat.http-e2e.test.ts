// 生产 createWebApp / POST /api/chat 的真实 HTTP + SSE 端到端回归。
// 模型侧是受控的本地 OpenAI-compatible 服务（不访问真实供应商），数据隔离在内存库与临时目录。
// server.ts 顶层 import @luoome/db（bun:sqlite），因此由 `bun run test:web` 执行。
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ToolContext } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { z } from 'zod';

import { AISettingsStore } from './ai-settings.js';
import { createWebApp } from './server.js';

type Frame = Record<string, unknown>;
type ModelRequest = {
  readonly model: string;
  readonly messages: readonly { readonly role: string; readonly content?: unknown }[];
  readonly tools?: readonly { readonly function?: { readonly name?: string } }[];
};

const MODEL_ORIGIN_MARKER = 'fixture-chat';

const frame = (model: string, delta: Frame, finishReason: string | null): Frame => ({
  id: 'chatcmpl-fixture',
  object: 'chat.completion.chunk',
  created: 1,
  model,
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});

const usage = { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 };

const textFrames = (model: string, text: string): Frame[] => [
  frame(model, { role: 'assistant', content: text }, null),
  { ...frame(model, {}, 'stop'), usage },
];

const toolFrames = (model: string, name: string, input: unknown, callId: string): Frame[] => [
  frame(
    model,
    {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: callId,
          type: 'function',
          function: { name, arguments: JSON.stringify(input) },
        },
      ],
    },
    null,
  ),
  { ...frame(model, {}, 'tool_calls'), usage },
];

const promptTextOf = (request: ModelRequest): string =>
  [...request.messages]
    .reverse()
    .filter((message) => message.role === 'user')
    .map((message) =>
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    )
    .join('\n');

const offeredToolNames = (request: ModelRequest): string[] =>
  (request.tools ?? []).flatMap((tool) => {
    const name = tool.function?.name;
    return typeof name === 'string' ? [name] : [];
  });

/** 受控 OpenAI-compatible SSE 模型服务：按最后一条 user 文本与本轮是否已有工具结果决定输出。 */
const startModelServer = (): {
  readonly origin: string;
  readonly requests: ModelRequest[];
  stop(): void;
} => {
  const requests: ModelRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== '/v1/chat/completions')
        return new Response('not found', { status: 404 });
      const body = (await request.json()) as ModelRequest;
      requests.push(body);
      const userText = promptTextOf(body);
      const afterTool = body.messages.at(-1)?.role === 'tool';
      const frames = ((): Frame[] => {
        if (userText.includes('MCP 文档'))
          return afterTool
            ? textFrames(body.model, 'MCP 文档证据已核对完成。')
            : toolFrames(body.model, 'mcp_docs__search_docs', { query: 'Watchlist' }, 'mcp-1');
        if (userText.includes('刚才草案'))
          return textFrames(body.model, '已依据确认回执继续解释。');
        if (userText.includes('草案'))
          return afterTool
            ? textFrames(body.model, '草案已生成，确认前不会创建观察清单。')
            : toolFrames(
                body.model,
                'create_watchlist',
                { name: '端到端待确认清单', kind: 'personal', membershipPolicy: 'manual' },
                'draft-1',
              );
        if (userText.includes('行情'))
          return afterTool
            ? textFrames(body.model, '行情已核对完成；仅技术研究，不构成投资建议。')
            : toolFrames(body.model, 'fetch_quote', { stockId: '002594.SZ' }, 'quote-1');
        return textFrames(body.model, '通用回答。');
      })();
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const item of frames) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(item)}\n\n`));
            await Bun.sleep(1);
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => void server.stop(true),
  };
};

interface Harness {
  readonly ctx: ToolContext;
  readonly requests: ModelRequest[];
  readonly root: string;
  readonly appOrigin: string;
  readonly modelOrigin: string;
  createSession(): Promise<string>;
  chat(sessionId: string, text: string): Promise<Response>;
  post(path: string, body: unknown): Promise<Response>;
  stop(): void;
}

const roots: string[] = [];

const writeModelConfig = (path: string, baseURL: string, model = MODEL_ORIGIN_MARKER): void => {
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      providers: {
        fixture: { type: 'openai-compatible', baseURL, apiKeyEnv: 'FIXTURE_API_KEY' },
      },
      profiles: {
        generation: { model: `fixture:${MODEL_ORIGIN_MARKER}` },
        agent: { model: `fixture:${model}`, maxSteps: 8, maxTotalTokens: 30_000 },
      },
    }),
  );
};

const writeDocsMcpConfig = (path: string): void => {
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      services: {
        docs: {
          enabled: true,
          command: process.execPath,
          args: [
            '--no-env-file',
            fileURLToPath(new URL('../../../packages/mcp/src/docs-server.ts', import.meta.url)),
          ],
          tools: ['search_docs'],
          scenarios: ['research'],
        },
      },
    }),
  );
};

const createHarness = async (
  options: { readonly externalMcp?: boolean } = {},
): Promise<Harness> => {
  const model = startModelServer();
  const root = mkdtempSync(join(tmpdir(), 'luoome-ai-sdk-http-'));
  roots.push(root);
  const configPath = join(root, 'ai-models.json');
  writeModelConfig(configPath, `${model.origin}/v1`);
  const mcpConfigPath = join(root, 'mcp-servers.json');
  if (options.externalMcp === true) writeDocsMcpConfig(mcpConfigPath);
  const env = {
    LUOOME_HOME: root,
    LUOOME_AI_CONFIG: configPath,
    FIXTURE_API_KEY: 'fixture-only-key',
    ...(options.externalMcp === true
      ? { LUOOME_EXPOSE_EXTERNAL: 'true', LUOOME_MCP_CONFIG: mcpConfigPath }
      : {}),
  };
  const store = new AISettingsStore(env, { configPath, secretPath: join(root, '.env') });
  const ctx = await buildTestContext({ clock: () => new Date('2026-11-25T01:00:00Z') });
  // 生产装配路径：不注入 chatStreamRuntime，由 createWebApp 自己按持久化设置构造运行时。
  const app = createWebApp(ctx, {
    exposeWrite: true,
    exposeExternal: true,
    aiSettingsStore: store,
  });
  const server = Bun.serve({
    port: 0,
    fetch: app.fetch,
    idleTimeout: 60,
  });
  const appOrigin = `http://127.0.0.1:${server.port}`;
  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${appOrigin}${path}`, {
      method: 'POST',
      headers: { origin: appOrigin, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const createSession = async (): Promise<string> => {
    const response = await post('/api/chat/sessions', { title: 'AI SDK HTTP 端到端' });
    const parsed = z
      .object({ data: z.object({ session: z.object({ id: z.string() }) }) })
      .parse(await response.json());
    return parsed.data.session.id;
  };
  const chat = (sessionId: string, text: string): Promise<Response> =>
    post('/api/chat', {
      sessionId,
      messages: [
        { id: `user-${crypto.randomUUID()}`, role: 'user', parts: [{ type: 'text', text }] },
      ],
    });
  return {
    ctx,
    requests: model.requests,
    root,
    appOrigin,
    modelOrigin: model.origin,
    createSession,
    chat,
    post,
    stop: () => {
      server.stop(true);
      model.stop();
    },
  };
};

const parseChunks = (text: string): Frame[] =>
  text
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Frame);

const textOf = (chunks: readonly Frame[]): string =>
  chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => String(chunk.delta))
    .join('');

const harnesses: Harness[] = [];

const harness = async (options: { readonly externalMcp?: boolean } = {}): Promise<Harness> => {
  const created = await createHarness(options);
  harnesses.push(created);
  return created;
};

afterEach(() => {
  for (const created of harnesses.splice(0)) created.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('POST /api/chat 真实 HTTP + UI Message Stream（生产装配 + 受控本地模型）', () => {
  it('文本回答：标准 UI Message Stream，持久化为可续接的助手消息', async () => {
    const fixture = await harness();
    const sessionId = await fixture.createSession();
    const response = await fixture.chat(sessionId, '你好');

    expect(response.status).toBe(200);
    expect(response.headers.get('x-luoome-chat-runtime')).toBe('ai-sdk');
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    const chunks = parseChunks(await response.text());
    expect(chunks.filter((chunk) => chunk.type === 'error')).toEqual([]);
    expect(textOf(chunks)).toBe('通用回答。');
    expect(chunks.map((chunk) => chunk.type)).toContain('finish');
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]?.model).toBe(MODEL_ORIGIN_MARKER);

    const messages = await fixture.ctx.repos.chat.listMessages(sessionId);
    const assistant = messages.findLast((message) => message.role === 'assistant');
    expect(assistant?.parts).toContainEqual(
      expect.objectContaining({ type: 'text', text: '通用回答。' }),
    );
    expect(assistant?.parts).toContainEqual(expect.objectContaining({ type: 'data-luoome-usage' }));
  }, 30_000);

  it('一次本地 Tool 后回答：工具在同一进程执行，结果回传模型并持久化', async () => {
    const fixture = await harness();
    const sessionId = await fixture.createSession();
    const chunks = parseChunks(await (await fixture.chat(sessionId, '查 002594 行情')).text());

    expect(chunks.filter((chunk) => chunk.type === 'error')).toEqual([]);
    expect(
      chunks
        .filter((chunk) => chunk.type === 'tool-input-available')
        .map((chunk) => chunk.toolName),
    ).toEqual(['fetch_quote']);
    const quoteOutput = chunks.find((chunk) => chunk.type === 'tool-output-available')?.output;
    expect(quoteOutput).toMatchObject({ quote: expect.objectContaining({ stockId: '002594.SZ' }) });
    expect(quoteOutput).not.toMatchObject({ error: expect.anything() });
    expect(textOf(chunks)).toContain('行情已核对完成');
    expect(fixture.requests).toHaveLength(2);
    // 第二轮模型请求带本轮工具结果，且不再重复执行工具。
    expect(JSON.stringify(fixture.requests[1]?.messages)).toContain('002594.SZ');
    const messages = await fixture.ctx.repos.chat.listMessages(sessionId);
    expect(messages.findLast((message) => message.role === 'assistant')?.parts).toContainEqual(
      expect.objectContaining({ type: 'tool-fetch_quote', state: 'output-available' }),
    );
  }, 30_000);

  it('草案只落库待确认；专用确认端点执行真实 ToolResult，下一轮带权威回执', async () => {
    const fixture = await harness();
    const sessionId = await fixture.createSession();
    const chunks = parseChunks(
      await (await fixture.chat(sessionId, '帮我生成一个观察清单草案')).text(),
    );

    expect(chunks.filter((chunk) => chunk.type === 'error')).toEqual([]);
    expect(await fixture.ctx.repos.watchlist.list()).toEqual([]);
    const messageId = z.string().parse(chunks.find((chunk) => chunk.type === 'start')?.messageId);
    const call = chunks.find((chunk) => chunk.type === 'tool-input-available');
    const toolCallId = z.string().parse(call?.toolCallId);
    expect(
      JSON.stringify(chunks.find((chunk) => chunk.type === 'tool-output-available')?.output),
    ).toContain('__luoomeDraft');
    expect(await fixture.ctx.repos.watchlist.list()).toEqual([]);

    const settled = await fixture.post(
      `/api/chat/sessions/${sessionId}/drafts/${messageId}/${toolCallId}`,
      { approved: true },
    );
    expect(settled.status).toBe(200);
    const settlement = z
      .object({
        ok: z.boolean(),
        data: z.object({ status: z.string(), result: z.object({ ok: z.boolean() }) }).passthrough(),
      })
      .parse(await settled.json());
    expect(settlement.ok).toBe(true);
    expect(settlement.data.status).toBe('succeeded');
    expect(settlement.data.result.ok).toBe(true);
    expect(await fixture.ctx.repos.watchlist.list()).toHaveLength(1);

    const followUp = parseChunks(
      await (await fixture.chat(sessionId, '请解释刚才草案的确认结果')).text(),
    );
    expect(followUp.filter((chunk) => chunk.type === 'error')).toEqual([]);
    const followUpPrompt = JSON.stringify(fixture.requests.at(-1)?.messages);
    expect(followUpPrompt).toContain('draftStatus');
    expect(followUpPrompt).toContain('succeeded');
    expect(textOf(followUp)).toContain('已依据确认回执继续解释');
  }, 30_000);

  it('外部只读 MCP 每轮发现并调用；未开启 external 时不出现在模型工具表', async () => {
    const disabled = await harness();
    await (await disabled.chat(await disabled.createSession(), '研究 MCP 文档中的策略')).text();
    expect(offeredToolNames(disabled.requests[0] as ModelRequest)).not.toContain(
      'mcp_docs__search_docs',
    );

    const fixture = await harness({ externalMcp: true });
    const sessionId = await fixture.createSession();
    const chunks = parseChunks(
      await (await fixture.chat(sessionId, '研究 MCP 文档中的策略')).text(),
    );
    expect(chunks.filter((chunk) => chunk.type === 'error')).toEqual([]);
    expect(offeredToolNames(fixture.requests[0] as ModelRequest)).toContain(
      'mcp_docs__search_docs',
    );
    const output = chunks.find((chunk) => chunk.type === 'tool-output-available')?.output;
    expect(JSON.stringify(output)).toContain('CONTEXT.md');
    expect(textOf(chunks)).toContain('MCP 文档证据已核对完成');
    const messages = await fixture.ctx.repos.chat.listMessages(sessionId);
    expect(messages.findLast((message) => message.role === 'assistant')?.parts).toContainEqual(
      expect.objectContaining({ type: 'tool-mcp_docs__search_docs', state: 'output-available' }),
    );
  }, 60_000);

  it('助手消息保存失败时流以错误收尾，不发送 finish', async () => {
    const fixture = await harness();
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
    expect(chunks.filter((chunk) => chunk.type === 'error')).toContainEqual(
      expect.objectContaining({ errorText: expect.stringContaining('助手回答保存失败') }),
    );
    expect(chunks.filter((chunk) => chunk.type === 'finish')).toEqual([]);
    expect(body).not.toContain('private-persistence-detail');
  }, 30_000);

  it('AI 设置热更新后下一轮对话使用新模型，无需重启进程', async () => {
    const fixture = await harness();
    const sessionId = await fixture.createSession();
    await (await fixture.chat(sessionId, '你好')).text();
    expect(fixture.requests[0]?.model).toBe(MODEL_ORIGIN_MARKER);

    const saved = await fixture.post('/api/settings/ai', {
      provider: 'openai-compatible',
      model: 'hot-reloaded-model',
      baseURL: `${fixture.modelOrigin}/v1`,
      apiKey: 'hot-key',
      temperature: 0.2,
      timeoutSeconds: 30,
      maxRetries: 0,
      reasoningEffort: 'off',
    });
    expect(saved.status).toBe(200);
    expect(z.object({ ok: z.boolean() }).parse(await saved.json()).ok).toBe(true);

    await (await fixture.chat(await fixture.createSession(), '你好')).text();
    expect(fixture.requests.at(-1)?.model).toBe('hot-reloaded-model');
  }, 30_000);
});
