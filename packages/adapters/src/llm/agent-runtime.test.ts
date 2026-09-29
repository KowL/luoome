import type { Logger } from '@luoome/core';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AISDKAgentRuntime } from './agent-runtime.js';
import type { ResolvedAIModelProfile } from './model-catalog.js';

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const usage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: 20,
    text: 20,
    reasoning: undefined,
  },
};

const toolCallResult = {
  content: [
    {
      type: 'tool-call' as const,
      toolCallId: 'call-1',
      toolName: 'lookup',
      input: '{"stockId":"002594.SZ"}',
    },
  ],
  finishReason: { unified: 'tool-calls' as const, raw: undefined },
  usage,
  warnings: [],
};

const agentRequest = {
  instructions: '只做查询',
  prompt: '查询股票',
  outputSchema: z.object({
    conclusion: z.string(),
    evidence: z.array(z.string()),
  }),
  tools: [
    {
      name: 'lookup',
      description: '查询',
      inputSchema: z.object({ stockId: z.string() }),
      execute: async (input: unknown) => ({
        ok: true,
        output: { input, price: 100 },
      }),
    },
  ],
};

const profile = (
  model: ResolvedAIModelProfile['model'],
  options: Partial<ResolvedAIModelProfile> = {},
): ResolvedAIModelProfile => ({
  name: 'agent',
  modelRef: 'test:model',
  providerName: 'test',
  providerType: 'anthropic',
  model,
  quirks: { injectSchemaIntoSystem: false, recoverMalformedText: false },
  timeoutMs: 1_000,
  maxRetries: 0,
  reasoningEffort: 'off',
  maxPromptChars: 16_000,
  maxSteps: 8,
  maxTotalTokens: 30_000,
  ...options,
});

describe('llm/agent-runtime', () => {
  it('历史工具的领域 Date 值序列化为标准 JSON 后可以继续对话', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start' as const, id: 'answer' },
            { type: 'text-delta' as const, id: 'answer', delta: '已核对执行结果' },
            { type: 'text-end' as const, id: 'answer' },
            {
              type: 'finish' as const,
              finishReason: { unified: 'stop' as const, raw: undefined },
              usage,
            },
          ],
        }),
      }),
    });
    const runtime = new AISDKAgentRuntime(profile(model), { logger: silentLogger });
    const response = await runtime.createUIMessageStreamResponse({
      instructions: '根据真实结果回答',
      tools: [
        {
          name: 'record',
          description: '登记',
          inputSchema: z.object({ at: z.coerce.date() }),
          execute: async () => ({ ok: true, output: {} }),
        },
      ],
      uiMessages: [
        { id: 'user1', role: 'user', parts: [{ type: 'text', text: '登记' }] },
        {
          id: 'assistant1',
          role: 'assistant',
          parts: [
            { type: 'step-start' },
            {
              type: 'tool-record',
              toolCallId: 'call',
              state: 'output-available',
              input: { at: new Date('2026-09-29T00:00:00Z') },
              output: {
                draftStatus: 'succeeded',
                result: { ok: true, data: { at: new Date('2026-09-29T00:00:00Z') } },
              },
            },
          ],
        },
        { id: 'user2', role: 'user', parts: [{ type: 'text', text: '继续总结' }] },
      ],
    });
    expect(await response.text()).toContain('已核对执行结果');
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it('把 agent 文本流转换成 AI SDK UI Message SSE', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start' as const, id: 'text-1' },
            { type: 'text-delta' as const, id: 'text-1', delta: '<thi' },
            { type: 'text-delta' as const, id: 'text-1', delta: 'nk>内部推理</th' },
            { type: 'text-delta' as const, id: 'text-1', delta: 'ink>\n你好' },
            { type: 'text-end' as const, id: 'text-1' },
            {
              type: 'finish' as const,
              finishReason: { unified: 'stop' as const, raw: undefined },
              logprobs: undefined,
              usage,
            },
          ],
        }),
      }),
    });
    const runtime = new AISDKAgentRuntime(
      profile(model, {
        providerType: 'openai-compatible',
        quirks: { injectSchemaIntoSystem: true, recoverMalformedText: true },
      }),
      { logger: silentLogger },
    );
    const response = await runtime.createUIMessageStreamResponse({
      instructions: '使用中文回答',
      uiMessages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: '你是谁' }] }],
      tools: [],
    });
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    const body = await response.text();
    expect(body).toContain('"type":"text-delta"');
    expect(body).toContain('你好');
    expect(body).not.toContain('内部推理');
    expect(body).not.toContain('<think>');
  });

  it('流式工具循环保留历史工具结果并传回累计用量', async () => {
    let streamCall = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        streamCall += 1;
        if (streamCall === 1)
          return {
            stream: simulateReadableStream({
              chunks: [
                {
                  type: 'tool-call' as const,
                  toolCallId: 'call-2',
                  toolName: 'lookup',
                  input: '{"stockId":"002594.SZ"}',
                },
                {
                  type: 'finish' as const,
                  finishReason: { unified: 'tool-calls' as const, raw: undefined },
                  usage,
                },
              ],
            }),
          };
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start' as const, id: 'answer' },
              { type: 'text-delta' as const, id: 'answer', delta: '查询完成' },
              { type: 'text-end' as const, id: 'answer' },
              {
                type: 'finish' as const,
                finishReason: { unified: 'stop' as const, raw: undefined },
                usage,
              },
            ],
          }),
        };
      },
    });
    const finished = vi.fn();
    const runtime = new AISDKAgentRuntime(profile(model), { logger: silentLogger });
    const response = await runtime.createUIMessageStreamResponse({
      instructions: '使用工具核实',
      uiMessages: [
        { id: 'user-1', role: 'user', parts: [{ type: 'text', text: '先查询' }] },
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-lookup',
              toolCallId: 'call-1',
              state: 'output-available',
              input: { stockId: '000001.SZ' },
              output: { price: 50 },
            },
          ],
        },
        { id: 'user-2', role: 'user', parts: [{ type: 'text', text: '再查询比亚迪' }] },
      ],
      tools: agentRequest.tools,
      onFinish: finished,
    });
    const body = await response.text();

    expect(model.doStreamCalls).toHaveLength(2);
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain('"price":50');
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('"price":100');
    expect(body).toContain('"type":"tool-output-available"');
    expect(body).toContain(
      '"messageMetadata":{"usage":{"inputTokens":20,"outputTokens":40,"totalTokens":60},"finishReason":"stop"}',
    );
    expect(finished).toHaveBeenCalledTimes(1);
    const start = body
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)) as { type: string; messageId?: string })
      .find((part) => part.type === 'start');
    expect(start?.messageId).toMatch(/^assistant_[a-z0-9-]+$/);
    expect(finished.mock.calls[0]?.[0].id).toBe(start?.messageId);
    expect(finished.mock.calls[0]?.[0]).toMatchObject({
      cancelled: false,
      parts: expect.arrayContaining([
        {
          type: 'data-luoome-usage',
          data: {
            usage: { inputTokens: 20, outputTokens: 40, totalTokens: 60 },
            finishReason: 'stop',
          },
        },
      ]),
    });
  });

  it('客户端断开并取消后仍保存已接收部分且停止模型流', async () => {
    const abort = new AbortController();
    let providerAborted = false;
    const model = new MockLanguageModelV3({
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'text-start', id: 'partial' });
            controller.enqueue({ type: 'text-delta', id: 'partial', delta: '已完成部分' });
            abortSignal?.addEventListener(
              'abort',
              () => {
                providerAborted = true;
                controller.error(abortSignal.reason);
              },
              { once: true },
            );
          },
        }),
      }),
    });
    const finished = vi.fn();
    let finish: (() => void) | undefined;
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const runtime = new AISDKAgentRuntime(profile(model), { logger: silentLogger });
    const response = await runtime.createUIMessageStreamResponse({
      instructions: '回答',
      uiMessages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: '继续' }] }],
      tools: [],
      abortSignal: abort.signal,
      onFinish: (message) => {
        finished(message);
        finish?.();
      },
    });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('missing response body');
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('stream closed before partial text');
      if (decoder.decode(chunk.value).includes('已完成部分')) break;
    }
    const cancelled = reader.cancel();
    abort.abort();
    await Promise.all([cancelled, completion]);

    expect(providerAborted).toBe(true);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(finished).toHaveBeenCalledTimes(1);
    expect(finished.mock.calls[0]?.[0]).toMatchObject({
      cancelled: true,
      parts: expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: '已完成部分' }),
        expect.objectContaining({
          type: 'data-luoome-usage',
          data: expect.objectContaining({ finishReason: 'abort' }),
        }),
      ]),
    });
  });

  it('provider 错误响应不泄漏到 SSE 或 SDK 日志', async () => {
    const secret = 'https://private.example?api_key=sk-test-secret private response body';
    const model = new MockLanguageModelV3({
      doStream: async () => {
        throw new Error(secret);
      },
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const runtime = new AISDKAgentRuntime(profile(model), { logger: silentLogger });
      const response = await runtime.createUIMessageStreamResponse({
        instructions: '回答',
        uiMessages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: '你好' }] }],
        tools: [],
      });
      const body = await response.text();
      expect(body).toContain('AI 响应失败，请检查模型配置后重试。');
      expect(body).not.toContain(secret);
      expect(logged.mock.calls.flat().map(String).join(' ')).not.toContain(secret);
    } finally {
      logged.mockRestore();
    }
  });

  it('保留末尾非 think 标记文本并屏蔽独立 reasoning parts', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'reasoning-start' as const, id: 'reasoning' },
            { type: 'reasoning-delta' as const, id: 'reasoning', delta: '隐藏推理' },
            { type: 'reasoning-end' as const, id: 'reasoning' },
            { type: 'text-start' as const, id: 'answer' },
            { type: 'text-delta' as const, id: 'answer', delta: '符号 <' },
            { type: 'text-end' as const, id: 'answer' },
            {
              type: 'finish' as const,
              finishReason: { unified: 'stop' as const, raw: undefined },
              usage,
            },
          ],
        }),
      }),
    });
    const runtime = new AISDKAgentRuntime(
      profile(model, {
        quirks: { injectSchemaIntoSystem: false, recoverMalformedText: true },
      }),
      { logger: silentLogger },
    );
    const finished = vi.fn();
    const response = await runtime.createUIMessageStreamResponse({
      instructions: '回答',
      uiMessages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: '你好' }] }],
      tools: [],
      onFinish: finished,
    });
    expect(await response.text()).not.toContain('隐藏推理');
    expect(finished.mock.calls[0]?.[0].parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'text', text: '符号 <' })]),
    );
  });

  it('执行 tool loop 并从实际 trace 派生 usedTools/usage', async () => {
    let generateCall = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        generateCall += 1;
        if (generateCall === 1) {
          return toolCallResult;
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                conclusion: '查询完成',
                evidence: ['工具返回成功'],
              }),
            },
          ],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage,
          warnings: [],
        };
      },
    });
    const runtime = new AISDKAgentRuntime(profile(model), {
      logger: silentLogger,
      config: { maxSteps: 8, maxTotalTokens: 30_000, timeoutMs: 1_000 },
    });
    const result = await runtime.run(agentRequest);
    expect(result.output).toEqual({
      conclusion: '查询完成',
      evidence: ['工具返回成功'],
    });
    expect(result.usedTools).toEqual(['lookup']);
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]).toMatchObject({
      toolName: 'lookup',
      input: { stockId: '002594.SZ' },
      output: { type: 'object', keys: ['input', 'price'] },
      ok: true,
    });
    expect(JSON.stringify(result.trace[0]?.output)).not.toContain('002594.SZ');
    expect(result.totalUsage).toEqual({
      inputTokens: 20,
      outputTokens: 40,
      totalTokens: 60,
    });
    expect(generateCall).toBe(2);
  });

  it.each([
    {
      name: '最大步数',
      config: { maxSteps: 1, maxTotalTokens: 30_000, timeoutMs: 1_000 },
    },
    {
      name: '累计 token 软预算',
      config: { maxSteps: 8, maxTotalTokens: 20, timeoutMs: 1_000 },
    },
  ])('$name 达到后不再发起下一次模型请求', async ({ config }) => {
    let generateCall = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        generateCall += 1;
        return toolCallResult;
      },
    });
    const runtime = new AISDKAgentRuntime(profile(model), { logger: silentLogger, config });
    await expect(runtime.run(agentRequest)).rejects.toThrow();
    expect(generateCall).toBe(1);
  });

  it('总超时的 abort signal 会终止模型调用', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async ({ abortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          if (abortSignal === undefined) {
            reject(new Error('missing abort signal'));
            return;
          }
          abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
        }),
    });
    const runtime = new AISDKAgentRuntime(profile(model), {
      logger: silentLogger,
      config: { maxSteps: 8, maxTotalTokens: 30_000, timeoutMs: 10 },
    });
    await expect(runtime.run(agentRequest)).rejects.toThrow();
  });

  it('MiniMax 最终输出带 think 块时通过 quirks 恢复并继续做 Zod 校验', async () => {
    let generateCall = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        generateCall += 1;
        if (generateCall === 1) return toolCallResult;
        return {
          content: [
            {
              type: 'text' as const,
              text:
                '<think>internal</think>\n' +
                '{"conclusion":"查询完成","evidence":["结构化输出已恢复"]}',
            },
          ],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage,
          warnings: [],
        };
      },
    });
    const runtime = new AISDKAgentRuntime(
      profile(model, {
        providerType: 'openai-compatible',
        quirks: { injectSchemaIntoSystem: true, recoverMalformedText: true },
      }),
      {
        logger: silentLogger,
        config: { maxSteps: 8, maxTotalTokens: 30_000, timeoutMs: 1_000 },
      },
    );
    const result = await runtime.run(agentRequest);
    expect(result.output).toEqual({
      conclusion: '查询完成',
      evidence: ['结构化输出已恢复'],
    });
    expect(result.totalUsage).toEqual({
      inputTokens: 20,
      outputTokens: 40,
      totalTokens: 60,
    });
    expect(result.usedTools).toEqual(['lookup']);
    expect(result.trace).toHaveLength(1);
  });
});
