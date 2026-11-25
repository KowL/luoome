import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentCallableTool } from '@luoome/core';
import { AGENT_SCENARIOS } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { z } from 'zod';
import {
  AiSdkChatRuntime,
  createAiSdkChatRuntimeFromStore,
  projectChatContext,
  resolveRunTimeoutMs,
} from './ai-sdk-chat-runtime.js';
import { AISettingsStore } from './ai-settings.js';
import { ChatRuntimeRejection } from './chat.js';

type MockStreamResult = Awaited<ReturnType<MockLanguageModelV3['doStream']>>;
type ProviderChunk = MockStreamResult['stream'] extends ReadableStream<infer T> ? T : never;

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

const textStream = (text: string, id = 'text-1'): MockStreamResult =>
  modelStream([
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id },
    { type: 'text-delta', id, delta: text },
    { type: 'text-end', id },
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

const modelWith = (...results: MockStreamResult[]) => {
  const queue = [...results];
  return new MockLanguageModelV3({
    doStream: async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error('unexpected extra model call');
      return next;
    },
  });
};

const runtimeWith = (
  model: MockLanguageModelV3,
  overrides: { readonly maxToolCalls?: number; readonly toolTimeoutMs?: number } = {},
) =>
  new AiSdkChatRuntime({
    model: {
      model,
      modelRef: 'fixture:model',
      timeoutMs: 5_000,
      maxOutputTokens: 512,
      maxSteps: 8,
      maxRetries: 0,
      maxTotalTokens: 100_000,
    },
    ...overrides,
  });

const callable = (name: string, execute: AgentCallableTool['execute']): AgentCallableTool => ({
  name,
  description: `${name} fixture`,
  inputSchema: z.record(z.string(), z.unknown()),
  execute,
});

interface FinishedMessage {
  readonly id: string;
  readonly parts: readonly Record<string, unknown>[];
  readonly cancelled: boolean;
  readonly executionStopped?: boolean;
}

const parseStream = (text: string): Record<string, unknown>[] =>
  text
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);

const run = async (
  runtime: AiSdkChatRuntime,
  input: {
    readonly uiMessages: readonly unknown[];
    readonly tools: readonly AgentCallableTool[];
    readonly instructions?: string;
    readonly abortSignal?: AbortSignal;
  },
): Promise<{ parts: Record<string, unknown>[]; finished: FinishedMessage }> => {
  let finished: FinishedMessage | undefined;
  const response = await runtime.createUIMessageStreamResponse({
    instructions: input.instructions ?? 'system',
    uiMessages: input.uiMessages,
    tools: input.tools,
    ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    onFinish: (message) => {
      finished = message;
    },
  });
  const parts = parseStream(await response.text());
  if (finished === undefined) throw new Error('onFinish was not called');
  return { parts, finished };
};

const userMessage = (text: string) => [
  { id: 'user-1', role: 'user', parts: [{ type: 'text', text }] },
];

describe('AiSdkChatRuntime', () => {
  it('streams plain text and persists text, step boundary and usage', async () => {
    const model = modelWith(textStream('你好'));
    const { parts, finished } = await run(runtimeWith(model), {
      uiMessages: userMessage('在吗'),
      tools: [],
    });

    expect(parts.map((part) => part.type)).toContain('start');
    expect(parts.map((part) => part.type)).toContain('start-step');
    expect(parts).toContainEqual(expect.objectContaining({ type: 'text-delta', delta: '你好' }));
    expect(parts.map((part) => part.type)).toContain('finish');
    expect(finished.cancelled).toBe(false);
    expect(finished.parts).toContainEqual({ type: 'step-start' });
    expect(finished.parts).toContainEqual(expect.objectContaining({ type: 'text', text: '你好' }));
    expect(finished.parts).toContainEqual({
      type: 'data-luoome-usage',
      data: { usage: expect.objectContaining({ inputTokens: 10, outputTokens: 5, steps: 1 }) },
    });
    expect(finished.parts.filter((part) => part.type === 'data-luoome-usage')).toHaveLength(1);
    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt);
    expect(prompt).toContain('system');
    expect(prompt).toContain('在吗');
  });

  it('runs one tool, sends its output back to the model, then answers', async () => {
    const model = modelWith(
      toolStream('fetch_quote', { stockId: '002594.SZ' }),
      textStream('价格 42'),
    );
    let executed: unknown;
    const quote = callable('fetch_quote', async (input) => {
      executed = input;
      return { ok: true, output: { price: 42 } };
    });
    const { finished } = await run(runtimeWith(model), {
      uiMessages: userMessage('查 002594 行情'),
      tools: [quote],
    });

    expect(executed).toEqual({ stockId: '002594.SZ' });
    expect(finished.parts).toContainEqual(
      expect.objectContaining({
        type: 'tool-fetch_quote',
        state: 'output-available',
        output: { price: 42 },
      }),
    );
    expect(finished.parts).toContainEqual(
      expect.objectContaining({ type: 'text', text: '价格 42' }),
    );
    expect(model.doStreamCalls).toHaveLength(2);
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('"price":42');
    expect(finished.parts).toContainEqual({
      type: 'data-luoome-usage',
      data: {
        usage: expect.objectContaining({
          modelRef: 'fixture:model',
          steps: 2,
          toolCalls: 1,
          tokensKnown: true,
          durationMs: expect.any(Number),
        }),
      },
    });
  });

  it('keeps a tool execution error as tool output and does not fail the turn', async () => {
    const model = modelWith(toolStream('boom', {}), textStream('继续核对'));
    const boom = callable('boom', async () => {
      throw new Error('private-tool-detail');
    });
    const { finished } = await run(runtimeWith(model), {
      uiMessages: userMessage('试一下工具失败'),
      tools: [boom],
    });

    expect(finished.parts).toContainEqual(
      expect.objectContaining({
        type: 'tool-boom',
        state: 'output-error',
        errorText: '工具未完成，请核对实际结果。',
      }),
    );
    expect(finished.parts.some((part) => part.type === 'data-luoome-stream-error')).toBe(false);
    expect(JSON.stringify(finished.parts)).not.toContain('private-tool-detail');
    expect(finished.parts).toContainEqual(
      expect.objectContaining({ type: 'text', text: '继续核对' }),
    );
  });

  it('supports multiple tool steps before the final answer', async () => {
    const model = modelWith(
      toolStream('fetch_quote', { stockId: '002594.SZ' }, 'call-quote'),
      toolStream('list_watchlists', {}, 'call-watchlists'),
      textStream('核对完成'),
    );
    const order: string[] = [];
    const quote = callable('fetch_quote', async () => {
      order.push('quote');
      return { ok: true, output: { price: 42 } };
    });
    const watchlists = callable('list_watchlists', async () => {
      order.push('watchlists');
      return { ok: true, output: { items: [] } };
    });
    const { finished } = await run(runtimeWith(model), {
      uiMessages: userMessage('查行情和观察清单'),
      tools: [quote, watchlists],
    });

    expect(order).toEqual(['quote', 'watchlists']);
    expect(finished.parts).toContainEqual(
      expect.objectContaining({ type: 'tool-fetch_quote', state: 'output-available' }),
    );
    expect(finished.parts).toContainEqual(
      expect.objectContaining({ type: 'tool-list_watchlists', state: 'output-available' }),
    );
    expect(model.doStreamCalls).toHaveLength(3);
  });

  it('keeps a draft tool as an ordinary callable and never treats the draft as executed', async () => {
    const model = modelWith(
      toolStream('create_watchlist', {
        name: '待确认清单',
        kind: 'personal',
        membershipPolicy: 'manual',
      }),
      textStream('已生成待确认草案'),
    );
    let executions = 0;
    const draft = callable('create_watchlist', async () => {
      executions += 1;
      return {
        ok: true,
        output: {
          __luoomeDraft: true,
          draft: {
            kind: 'write',
            tool: 'create_watchlist',
            input: { name: '待确认清单' },
            summary: '创建观察清单',
          },
        },
      };
    });
    const { finished } = await run(runtimeWith(model), {
      uiMessages: userMessage('帮我建一个观察清单'),
      tools: [draft],
    });

    expect(executions).toBe(1);
    expect(finished.parts).toContainEqual(
      expect.objectContaining({
        type: 'tool-create_watchlist',
        state: 'output-available',
        output: expect.objectContaining({ __luoomeDraft: true }),
      }),
    );
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('__luoomeDraft');
  });

  it('rebuilds prior tool results and step boundaries without re-executing tools', async () => {
    const model = modelWith(textStream('继续回答'));
    let executions = 0;
    const quote = callable('fetch_quote', async () => {
      executions += 1;
      return { ok: true, output: { price: 99 } };
    });
    const { finished } = await run(runtimeWith(model), {
      uiMessages: [
        { id: 'user-1', role: 'user', parts: [{ type: 'text', text: '之前的问题' }] },
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            { type: 'step-start' },
            { type: 'text', text: '之前回答' },
            {
              type: 'tool-fetch_quote',
              toolCallId: 'old-call',
              state: 'output-available',
              input: { stockId: '002594.SZ' },
              output: { price: 41 },
            },
          ],
        },
        {
          id: 'user-2',
          role: 'user',
          parts: [
            { type: 'text', text: '继续' },
            { type: 'data-luoome-subjects', data: { labels: ['比亚迪'] } },
          ],
        },
      ],
      tools: [quote],
    });

    expect(executions).toBe(0);
    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt);
    expect(prompt).toContain('"price":41');
    expect(prompt).toContain('之前回答');
    expect(prompt).not.toContain('data-luoome-subjects');
    expect(finished.parts).toContainEqual(
      expect.objectContaining({ type: 'text', text: '继续回答' }),
    );
  });

  it('surfaces a model error in the stream and persists a retryable error part', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => {
        throw new Error('provider down');
      },
    });
    const { parts, finished } = await run(runtimeWith(model), {
      uiMessages: userMessage('会失败吗'),
      tools: [],
    });

    expect(parts).toContainEqual(
      expect.objectContaining({
        type: 'error',
        errorText: expect.stringContaining('模型未完成回答'),
      }),
    );
    expect(finished.cancelled).toBe(false);
    expect(finished.parts).toContainEqual({
      type: 'data-luoome-stream-error',
      data: { message: expect.stringContaining('模型未完成回答') },
    });
    expect(finished.parts.filter((part) => part.type === 'data-luoome-stream-error')).toHaveLength(
      1,
    );
  });

  it('marks a client abort as cancelled and keeps the partial parts', async () => {
    const model = new MockLanguageModelV3({
      doStream: async (options) => ({
        stream: new ReadableStream<ProviderChunk>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'text-1' });
            controller.enqueue({ type: 'text-delta', id: 'text-1', delta: '部分' });
            const abort = () =>
              controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            if (options.abortSignal?.aborted) abort();
            else options.abortSignal?.addEventListener('abort', abort, { once: true });
          },
        }),
      }),
    });
    const controller = new AbortController();
    let finished: FinishedMessage | undefined;
    const response = await runtimeWith(model).createUIMessageStreamResponse({
      instructions: 'system',
      uiMessages: userMessage('慢一点'),
      tools: [],
      abortSignal: controller.signal,
      onFinish: (message) => {
        finished = message;
      },
    });
    const reading = response.text();
    await Bun.sleep(30);
    controller.abort();
    const parts = parseStream(await reading);

    expect(parts.map((part) => part.type)).toContain('abort');
    expect(finished?.cancelled).toBe(true);
    expect(finished?.executionStopped).toBe(true);
    expect(finished?.parts).toContainEqual(expect.objectContaining({ type: 'text', text: '部分' }));
    expect(finished?.parts.some((part) => part.type === 'data-luoome-stream-error')).toBe(false);
  });

  it('turns a model timeout into an error instead of a user cancel', async () => {
    const model = new MockLanguageModelV3({
      doStream: async (options) => ({
        stream: new ReadableStream<ProviderChunk>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'text-1' });
            controller.enqueue({ type: 'text-delta', id: 'text-1', delta: '部分' });
            const fail = () =>
              controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            if (options.abortSignal?.aborted) fail();
            else options.abortSignal?.addEventListener('abort', fail, { once: true });
          },
        }),
      }),
    });
    const runtime = new AiSdkChatRuntime({
      model: {
        model,
        modelRef: 'fixture:model',
        timeoutMs: 20,
        maxOutputTokens: 512,
        maxSteps: 8,
        maxRetries: 0,
        maxTotalTokens: 100_000,
      },
    });
    const { parts, finished } = await run(runtime, {
      uiMessages: userMessage('慢慢来'),
      tools: [],
    });

    expect(parts).toContainEqual(
      expect.objectContaining({ type: 'error', errorText: expect.stringContaining('超时') }),
    );
    expect(parts.map((part) => part.type)).not.toContain('abort');
    expect(finished.cancelled).toBe(false);
    expect(finished.parts).toContainEqual({
      type: 'data-luoome-stream-error',
      data: { message: expect.stringContaining('超时') },
    });
    expect(finished.parts).toContainEqual(expect.objectContaining({ type: 'text', text: '部分' }));
  });

  it('keeps a timed-out tool as a tool error and reports the call as still running', async () => {
    const model = modelWith(toolStream('slow_tool', {}), textStream('工具超时后继续'));
    let releaseTool: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const slow = callable('slow_tool', async () => {
      await gate;
      return { ok: true, output: { done: true } };
    });
    const { finished } = await run(runtimeWith(model, { toolTimeoutMs: 10 }), {
      uiMessages: userMessage('试一下慢工具'),
      tools: [slow],
    });

    expect(finished.parts).toContainEqual(
      expect.objectContaining({
        type: 'tool-slow_tool',
        state: 'output-error',
        errorText: expect.stringContaining('超时'),
      }),
    );
    // 超时只结束等待，底层调用仍在执行，因此不能宣称工具已排空。
    expect(finished.executionStopped).toBe(false);
    expect(finished.parts).toContainEqual(
      expect.objectContaining({ type: 'text', text: '工具超时后继续' }),
    );
    releaseTool();
  });

  it('reuses onFinish parts as the next turn history', async () => {
    const firstModel = modelWith(
      toolStream('fetch_quote', { stockId: '002594.SZ' }),
      textStream('第一次回答'),
    );
    const quote = callable('fetch_quote', async () => ({
      ok: true,
      output: { price: 42 },
    }));
    const first = await run(runtimeWith(firstModel), {
      uiMessages: userMessage('查 002594 行情'),
      tools: [quote],
    });

    const secondModel = modelWith(textStream('第二次回答'));
    let executions = 0;
    const unusedQuote = callable('fetch_quote', async () => {
      executions += 1;
      return { ok: true, output: { price: 0 } };
    });
    const second = await run(runtimeWith(secondModel), {
      uiMessages: [
        ...userMessage('查 002594 行情'),
        { id: first.finished.id, role: 'assistant', parts: first.finished.parts },
        { id: 'user-2', role: 'user', parts: [{ type: 'text', text: '那现在呢' }] },
      ],
      tools: [unusedQuote],
    });

    expect(executions).toBe(0);
    const prompt = JSON.stringify(secondModel.doStreamCalls[0]?.prompt);
    expect(prompt).toContain('"price":42');
    expect(prompt).toContain('第一次回答');
    expect(second.finished.parts).toContainEqual(
      expect.objectContaining({ type: 'text', text: '第二次回答' }),
    );
  });

  it('caps tool calls per turn and reports the denial as a business error', async () => {
    const model = modelWith(
      toolStream('fetch_quote', { stockId: '002594.SZ' }, 'call-1'),
      textStream('达到上限'),
    );
    let executions = 0;
    const quote = callable('fetch_quote', async () => {
      executions += 1;
      return { ok: true, output: { price: 42 } };
    });
    const { finished } = await run(runtimeWith(model, { maxToolCalls: 0 }), {
      uiMessages: userMessage('查行情'),
      tools: [quote],
    });

    expect(executions).toBe(0);
    expect(finished.parts).toContainEqual(
      expect.objectContaining({
        type: 'tool-fetch_quote',
        state: 'output-available',
        output: expect.objectContaining({
          error: expect.objectContaining({ kind: 'permission_denied' }),
        }),
      }),
    );
  });
});

describe('运行时预算、上下文与 usage', () => {
  const runtimeWithBudget = (
    model: MockLanguageModelV3,
    overrides: {
      readonly timeoutMs?: number;
      readonly runTimeoutMs?: number;
      readonly maxContextChars?: number;
      readonly maxToolOutputBytes?: number;
      readonly maxSteps?: number;
      readonly toolTimeoutMs?: number;
    } = {},
  ) =>
    new AiSdkChatRuntime({
      model: {
        model,
        modelRef: 'fixture:budget-model',
        timeoutMs: overrides.timeoutMs ?? 5_000,
        maxOutputTokens: 512,
        maxSteps: overrides.maxSteps ?? 8,
        maxRetries: 0,
        maxTotalTokens: 1_000_000,
        ...(overrides.runTimeoutMs === undefined ? {} : { runTimeoutMs: overrides.runTimeoutMs }),
        ...(overrides.maxContextChars === undefined
          ? {}
          : { maxContextChars: overrides.maxContextChars }),
        ...(overrides.maxToolOutputBytes === undefined
          ? {}
          : { maxToolOutputBytes: overrides.maxToolOutputBytes }),
      },
      ...(overrides.toolTimeoutMs === undefined ? {} : { toolTimeoutMs: overrides.toolTimeoutMs }),
    });

  it('整轮 run 预算按步数派生并限制在 10 分钟内', () => {
    expect(
      resolveRunTimeoutMs({ timeoutMs: 120_000, maxSteps: 8, runTimeoutMs: undefined }, 15_000),
    ).toBe(600_000);
    expect(
      resolveRunTimeoutMs({ timeoutMs: 30_000, maxSteps: 8, runTimeoutMs: undefined }, 15_000),
    ).toBe(360_000);
    expect(
      resolveRunTimeoutMs({ timeoutMs: 120_000, maxSteps: 8, runTimeoutMs: 45_000 }, 15_000),
    ).toBe(45_000);
  });

  it('多步 Tool Calling 在默认预算内完整跑完，不被单次请求预算提前截断', async () => {
    const slow = (chunks: ProviderChunk[]) =>
      simulateReadableStream({ chunks, chunkDelayInMs: 10 });
    const model = new MockLanguageModelV3({
      doStream: async () => {
        calls += 1;
        if (calls === 1)
          return {
            stream: slow([
              { type: 'stream-start', warnings: [] },
              { type: 'tool-input-start', id: 'call-1', toolName: 'fetch_quote' },
              { type: 'tool-input-delta', id: 'call-1', delta: '{}' },
              { type: 'tool-input-end', id: 'call-1' },
              { type: 'tool-call', toolCallId: 'call-1', toolName: 'fetch_quote', input: '{}' },
              finish('tool-calls'),
            ]),
          };
        if (calls === 2)
          return {
            stream: slow([
              { type: 'stream-start', warnings: [] },
              { type: 'tool-input-start', id: 'call-2', toolName: 'list_watchlists' },
              { type: 'tool-input-delta', id: 'call-2', delta: '{}' },
              { type: 'tool-input-end', id: 'call-2' },
              { type: 'tool-call', toolCallId: 'call-2', toolName: 'list_watchlists', input: '{}' },
              finish('tool-calls'),
            ]),
          };
        return {
          stream: slow([
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: '多步完成' },
            { type: 'text-end', id: 'text-1' },
            finish('stop'),
          ]),
        };
      },
    });
    let calls = 0;
    const quote = callable('fetch_quote', async () => ({ ok: true, output: { price: 42 } }));
    const watchlists = callable('list_watchlists', async () => ({
      ok: true,
      output: { items: [] },
    }));
    const { finished } = await run(runtimeWithBudget(model, { timeoutMs: 1_500 }), {
      uiMessages: userMessage('查行情和观察清单'),
      tools: [quote, watchlists],
    });

    expect(calls).toBe(3);
    expect(finished.cancelled).toBe(false);
    expect(finished.parts).toContainEqual(
      expect.objectContaining({ type: 'text', text: '多步完成' }),
    );
  });

  it('整轮 run 预算超时按错误上报，不误标为用户取消', async () => {
    const model = new MockLanguageModelV3({
      doStream: async (options) => ({
        stream: new ReadableStream<ProviderChunk>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            const fail = () =>
              controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            if (options.abortSignal?.aborted) fail();
            else options.abortSignal?.addEventListener('abort', fail, { once: true });
          },
        }),
      }),
    });
    const runtime = runtimeWithBudget(model, { timeoutMs: 5_000, runTimeoutMs: 20 });
    const { parts, finished } = await run(runtime, {
      uiMessages: userMessage('长时间运行'),
      tools: [],
    });

    expect(parts).toContainEqual(
      expect.objectContaining({ type: 'error', errorText: expect.stringContaining('超时') }),
    );
    expect(parts.map((part) => part.type)).not.toContain('abort');
    expect(finished.cancelled).toBe(false);
    expect(finished.parts).toContainEqual({
      type: 'data-luoome-stream-error',
      data: { message: expect.stringContaining('超时') },
    });
  });

  it('本地 Tool 大输出按字节上限截断，并把分页提示回传模型', async () => {
    const model = modelWith(toolStream('fetch_big', {}), textStream('已截断'));
    const big = {
      items: Array.from({ length: 4_000 }, (_, index) => ({ id: index, note: 'x'.repeat(80) })),
    };
    const tool = callable('fetch_big', async () => ({ ok: true, output: big }));
    const { finished } = await run(runtimeWithBudget(model, { maxToolOutputBytes: 2_048 }), {
      uiMessages: userMessage('拉全量数据'),
      tools: [tool],
    });

    const toolPart = finished.parts.find((part) => part.type === 'tool-fetch_big') as
      | { output?: Record<string, unknown> }
      | undefined;
    expect(toolPart?.output).toMatchObject({
      outputTruncated: true,
      limitBytes: 2_048,
      totalBytes: expect.any(Number),
      hint: expect.stringContaining('截断'),
    });
    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(secondPrompt).toContain('outputTruncated');
    expect(secondPrompt.length).toBeLessThan(20_000);
  });

  it('请求前压缩旧 Tool 大输出并保留用户消息与最新回答', async () => {
    const model = modelWith(textStream('继续回答'));
    const big = {
      items: Array.from({ length: 6_000 }, (_, index) => ({ id: index, note: 'y'.repeat(80) })),
    };
    const { finished } = await run(runtimeWithBudget(model, { maxContextChars: 8_000 }), {
      uiMessages: [
        { id: 'user-1', role: 'user', parts: [{ type: 'text', text: '之前的问题' }] },
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            { type: 'step-start' },
            { type: 'text', text: '之前回答' },
            {
              type: 'tool-fetch_big',
              toolCallId: 'old-call',
              state: 'output-available',
              input: {},
              output: big,
            },
          ],
        },
        { id: 'user-2', role: 'user', parts: [{ type: 'text', text: '继续' }] },
      ],
      tools: [],
    });

    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt);
    expect(prompt).toContain('之前的问题');
    expect(prompt).toContain('之前回答');
    expect(prompt).toContain('继续');
    expect(prompt).toContain('outputTruncated');
    expect(prompt.length).toBeLessThan(20_000);
    expect(finished.parts).toContainEqual(
      expect.objectContaining({ type: 'text', text: '继续回答' }),
    );
  });

  it('压缩后仍超限时明确拒绝，而不是静默丢事实', async () => {
    const model = modelWith(textStream('不应被调用'));
    const hugeText = '证'.repeat(4_000);
    await expect(
      run(runtimeWithBudget(model, { maxContextChars: 3_000 }), {
        uiMessages: [
          { id: 'user-1', role: 'user', parts: [{ type: 'text', text: hugeText }] },
          { id: 'user-2', role: 'user', parts: [{ type: 'text', text: hugeText }] },
        ],
        tools: [],
      }),
    ).rejects.toBeInstanceOf(ChatRuntimeRejection);
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it('projectChatContext 保留最新草案回执，只压缩普通 Tool 输出', () => {
    const messages = [
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text: '建清单' }] },
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [
          { type: 'text', text: '草案已生成' },
          {
            type: 'tool-create_watchlist',
            toolCallId: 'draft-1',
            state: 'output-available',
            input: { name: '清单' },
            output: { __luoomeDraft: true, draft: { payload: 'd'.repeat(4_000) } },
          },
          {
            type: 'tool-fetch_big',
            toolCallId: 'call-2',
            state: 'output-available',
            input: {},
            output: { items: 'i'.repeat(4_000) },
          },
        ],
      },
    ];
    const projected = projectChatContext(messages as never, 6_000);
    const text = JSON.stringify(projected.messages);

    expect(projected.truncated).toBe(true);
    expect(text).toContain('__luoomeDraft');
    expect(text).toContain('草案已生成');
    expect(text).toContain('outputTruncated');
  });

  it('没有 usage 的供应商按 unknown 记录，不写成确定 0 成本', async () => {
    const unknownUsage: ProviderChunk = {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: {
          total: undefined,
          noCache: undefined,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: undefined, text: undefined, reasoning: undefined },
      },
    };
    const model = modelWith(
      modelStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: '回答' },
        { type: 'text-end', id: 'text-1' },
        unknownUsage,
      ]),
    );
    const { finished } = await run(runtimeWithBudget(model), {
      uiMessages: userMessage('会消耗多少'),
      tools: [],
    });

    const usagePart = finished.parts.find((part) => part.type === 'data-luoome-usage') as
      | { data: { usage: Record<string, unknown> } }
      | undefined;
    expect(usagePart?.data.usage).toMatchObject({
      modelRef: 'fixture:budget-model',
      steps: 1,
      toolCalls: 0,
      tokensKnown: false,
    });
    expect(usagePart?.data.usage.durationMs).toEqual(expect.any(Number));
    expect(usagePart?.data.usage).not.toHaveProperty('inputTokens');
    expect(usagePart?.data.usage).not.toHaveProperty('totalTokens');
  });
});

describe('createAiSdkChatRuntimeFromStore', () => {
  it('builds a runtime from the persisted agent profile and degrades without settings', () => {
    expect(createAiSdkChatRuntimeFromStore(undefined)).toBeUndefined();
    const root = mkdtempSync(join(tmpdir(), 'luoome-ai-sdk-chat-'));
    try {
      const configPath = join(root, 'ai-models.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          version: 1,
          providers: {
            fixture: {
              type: 'openai-compatible',
              baseURL: 'https://fixture.invalid/v1',
              apiKeyEnv: 'FIXTURE_API_KEY',
            },
          },
          profiles: {
            generation: { model: 'fixture:generation-model' },
            agent: { model: 'fixture:agent-model', maxSteps: 4, maxTotalTokens: 12_000 },
          },
        }),
      );
      const store = new AISettingsStore(
        { LUOOME_HOME: root, FIXTURE_API_KEY: 'fixture-key' },
        { configPath, secretPath: join(root, '.env') },
      );
      expect(createAiSdkChatRuntimeFromStore(store)).toBeInstanceOf(AiSdkChatRuntime);

      const missingKey = new AISettingsStore(
        { LUOOME_HOME: root },
        { configPath, secretPath: join(root, '.env') },
      );
      expect(createAiSdkChatRuntimeFromStore(missingKey)).toBeUndefined();
      expect(
        createAiSdkChatRuntimeFromStore(missingKey, {
          LUOOME_HOME: root,
          FIXTURE_API_KEY: 'fixture-key',
        }),
      ).toBeInstanceOf(AiSdkChatRuntime);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('agent profile 可用而 generation 缺密钥时仍能构造聊天运行时', () => {
    const root = mkdtempSync(join(tmpdir(), 'luoome-ai-sdk-agent-only-'));
    try {
      const configPath = join(root, 'ai-models.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          version: 1,
          providers: {
            fixture: {
              type: 'openai-compatible',
              baseURL: 'https://fixture.invalid/v1',
              apiKeyEnv: 'FIXTURE_API_KEY',
            },
            kimi: {
              type: 'openai-compatible',
              baseURL: 'https://api.moonshot.cn/v1',
              apiKeyEnv: 'MOONSHOT_API_KEY',
            },
          },
          profiles: {
            generation: { model: 'kimi:kimi-k3' },
            agent: { model: 'fixture:agent-model' },
          },
        }),
      );
      const store = new AISettingsStore(
        { LUOOME_HOME: root, FIXTURE_API_KEY: 'fixture-key' },
        { configPath, secretPath: join(root, '.env') },
      );
      expect(store.read().profiles.generation.apiKeyConfigured).toBe(false);
      expect(store.read().profiles.agent.apiKeyConfigured).toBe(true);
      expect(createAiSdkChatRuntimeFromStore(store)).toBeInstanceOf(AiSdkChatRuntime);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('生产工厂：目录 + 外部 MCP 接线', () => {
  it('从持久化设置构造真实运行时，按场景发现只读 MCP 并写入模型 tools', async () => {
    const root = mkdtempSync(join(tmpdir(), 'luoome-ai-sdk-factory-'));
    try {
      writeFileSync(
        join(root, 'ai-models.json'),
        JSON.stringify({
          version: 1,
          providers: {
            fixture: {
              type: 'openai-compatible',
              baseURL: 'https://fixture.invalid/v1',
              apiKeyEnv: 'FIXTURE_API_KEY',
              supportsStructuredOutputs: false,
            },
          },
          profiles: {
            generation: { model: 'fixture:generation-model' },
            agent: { model: 'fixture:agent-model' },
          },
        }),
      );
      writeFileSync(
        join(root, 'mcp-servers.json'),
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
      const bodies: Record<string, unknown>[] = [];
      const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          [
            'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"外部工具已核对"},"finish_reason":null}]}',
            'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":4,"total_tokens":12}}',
            'data: [DONE]',
            '',
          ].join('\n\n'),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }) as typeof fetch;
      const store = new AISettingsStore(
        {
          LUOOME_HOME: root,
          LUOOME_EXPOSE_EXTERNAL: 'true',
          FIXTURE_API_KEY: 'fixture-key',
        },
        { configPath: join(root, 'ai-models.json'), secretPath: join(root, '.env') },
      );
      const runtime = createAiSdkChatRuntimeFromStore(
        store,
        {
          LUOOME_HOME: root,
          LUOOME_EXPOSE_EXTERNAL: 'true',
          FIXTURE_API_KEY: 'fixture-key',
        },
        { fetchImpl },
      );
      expect(runtime).toBeInstanceOf(AiSdkChatRuntime);
      let finished: FinishedMessage | undefined;
      const response = await runtime?.createUIMessageStreamResponse({
        instructions: 'system',
        uiMessages: userMessage('研究 MCP 文档中的 Watchlist'),
        tools: [],
        execution: {
          context: await buildTestContext(),
          runId: 'run-1',
          conversationId: 'session-1',
          scenario: AGENT_SCENARIOS.research,
          historyTruncated: false,
        },
        onFinish: (message) => {
          finished = message;
        },
      });
      const parts = parseStream(await (response as Response).text());
      expect(parts.filter((part) => part.type === 'error')).toEqual([]);
      expect(parts).toContainEqual(
        expect.objectContaining({ type: 'text-delta', delta: '外部工具已核对' }),
      );
      expect(bodies).toHaveLength(1);
      expect(JSON.stringify(bodies[0]?.tools)).toContain('mcp_docs__search_docs');
      expect(finished?.cancelled).toBe(false);
      expect(finished?.parts).toContainEqual(
        expect.objectContaining({ type: 'text', text: '外部工具已核对' }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
