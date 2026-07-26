import type { Logger } from '@luoome/core';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
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
