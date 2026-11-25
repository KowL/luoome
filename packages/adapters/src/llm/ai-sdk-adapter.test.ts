import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AISDKAdapter, LLMPromptBudgetError, projectPromptData } from './ai-sdk-adapter.js';
import { AIModelCatalog, type ResolvedAIModelProfile } from './model-catalog.js';
import { LLMOutputBudgetError } from './types.js';

const TestSchema = z.object({
  decision: z.enum(['buy', 'sell', 'hold']),
  confidence: z.number().min(0).max(100),
});

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

const mockModel = (text: string) =>
  new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage,
      warnings: [],
    }),
  });

const profile = (
  model: ResolvedAIModelProfile['model'],
  options: Partial<ResolvedAIModelProfile> = {},
): ResolvedAIModelProfile => ({
  name: 'generation',
  modelRef: 'test:model',
  providerName: 'test',
  providerType: 'anthropic',
  supportsStructuredOutputs: true,
  model,
  quirks: { injectSchemaIntoSystem: false, recoverMalformedText: false },
  timeoutMs: 1_000,
  maxOutputTokens: 2_048,
  maxRetries: 0,
  reasoningEffort: 'off',
  maxPromptChars: 16_000,
  maxContextChars: 48_000,
  maxSteps: 8,
  maxTotalTokens: 30_000,
  ...options,
});

/** 从 AI SDK prompt 结构中取出实际发送的 user 文本。 */
const promptText = (prompt: unknown): string =>
  (prompt as { role: string; content: unknown }[])
    .filter((message) => message.role === 'user')
    .map((message) => {
      if (typeof message.content === 'string') return message.content;
      return (message.content as { type: string; text?: string }[])
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('');
    })
    .join('\n');

describe('llm/ai-sdk-adapter', () => {
  it('对象联合向兼容 API 发送顶层 object，同时保留分支校验', async () => {
    const schema = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('parameter-tuning'), changeSummary: z.string() }),
      z.object({ kind: z.literal('new-strategy'), name: z.string() }),
    ]);
    let response = { kind: 'parameter-tuning', changeSummary: '收紧阈值' };
    const requests: Record<string, unknown>[] = [];
    const catalog = new AIModelCatalog(
      {
        version: 1,
        providers: {
          test: {
            type: 'openai-compatible',
            baseURL: 'https://provider.test/v1',
            apiKeyEnv: 'TEST_API_KEY',
          },
        },
        profiles: {
          generation: { model: 'test:model' },
          agent: { model: 'test:model' },
        },
      },
      { TEST_API_KEY: 'test-key' },
      {
        fetchImpl: (async (_url, init) => {
          requests.push(JSON.parse(String(init?.body)));
          return Response.json({
            id: 'completion-test',
            object: 'chat.completion',
            created: 0,
            model: 'model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: JSON.stringify(response) },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          });
        }) as typeof fetch,
      },
    );
    const adapter = new AISDKAdapter(catalog.resolve('generation'));
    await expect(adapter.generate({ system: 'proposal', schema, data: {} })).resolves.toMatchObject(
      response,
    );
    expect(requests[0]).toMatchObject({
      response_format: {
        type: 'json_schema',
        json_schema: {
          schema: { type: 'object', oneOf: expect.any(Array) },
        },
      },
    });

    response = { kind: 'new-strategy', changeSummary: '缺少必填 name' };
    await expect(adapter.generate({ system: 'proposal', schema, data: {} })).rejects.toThrow();
  });

  it('Output.object 解析并以原 Zod schema 校验', async () => {
    const adapter = new AISDKAdapter(profile(mockModel('{"decision":"hold","confidence":65}')));
    const out = await adapter.generate<z.infer<typeof TestSchema>>({
      system: 'advisor',
      schema: TestSchema,
      data: { stockId: 'X' },
    });
    expect(out).toMatchObject({ decision: 'hold', confidence: 65 });
    expect(JSON.parse(out.raw)).toMatchObject({
      text: '{"decision":"hold","confidence":65}',
    });
    // AI SDK v6 的嵌套 usage totals 必须结构化上报，供每日预算计量。
    expect(out.usage).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      reasoningTokens: 0,
      costUsd: 0,
    });
  });

  it('usage 上报 reasoning token（AI SDK v6 outputTokens.reasoning）', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text' as const, text: '{"decision":"hold","confidence":50}' }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: {
          inputTokens: { total: 120, noCache: 120, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 300, text: 100, reasoning: 200 },
        },
        warnings: [],
      }),
    });
    const out = await new AISDKAdapter(profile(model)).generate<z.infer<typeof TestSchema>>({
      system: 'advisor',
      schema: TestSchema,
      data: {},
    });
    expect(out.usage).toEqual({
      promptTokens: 120,
      completionTokens: 300,
      reasoningTokens: 200,
      costUsd: 0,
    });
  });

  it('非法结构化输出抛错，交由 manager 重试/fallback', async () => {
    const adapter = new AISDKAdapter(profile(mockModel('{"decision":"INVALID","confidence":65}')));
    await expect(
      adapter.generate({ system: 'advisor', schema: TestSchema, data: {} }),
    ).rejects.toThrow();
  });

  it('openai-compatible 从 NoObjectGeneratedError.text 恢复 think/fence 输出', async () => {
    const adapter = new AISDKAdapter(
      profile(
        mockModel('<think>internal</think>\n```json\n{"decision":"buy","confidence":80}\n```'),
        {
          providerType: 'openai-compatible',
          quirks: { injectSchemaIntoSystem: true, recoverMalformedText: true },
        },
      ),
    );
    const out = await adapter.generate<z.infer<typeof TestSchema>>({
      system: 'advisor',
      schema: TestSchema,
      data: {},
    });
    expect(out).toMatchObject({ decision: 'buy', confidence: 80 });
    expect(JSON.parse(out.raw)).toMatchObject({
      text: expect.stringContaining('<think>'),
    });
    // 恢复路径同样来自真实 HTTP 响应，usage 不能丢。
    expect(out.usage).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      reasoningTokens: 0,
      costUsd: 0,
    });
  });

  it('quirks 清洗后仍不符合 schema 时继续抛错', async () => {
    const adapter = new AISDKAdapter(
      profile(mockModel('<think>internal</think>```json\n{"decision":"INVALID"}\n```'), {
        providerType: 'openai-compatible',
        quirks: { injectSchemaIntoSystem: true, recoverMalformedText: true },
      }),
    );
    await expect(
      adapter.generate({ system: 'advisor', schema: TestSchema, data: {} }),
    ).rejects.toThrow();
  });

  it('supportsStructuredOutputs=false 时不发送 response_format，只注入 schema 并解析文本', async () => {
    const requests: Record<string, unknown>[] = [];
    const catalog = new AIModelCatalog(
      {
        version: 1,
        providers: {
          test: {
            type: 'openai-compatible',
            baseURL: 'https://provider.test/v1',
            apiKeyEnv: 'TEST_API_KEY',
            supportsStructuredOutputs: false,
            quirks: ['inject-schema', 'recover-malformed-text'],
          },
        },
        profiles: { generation: { model: 'test:model' }, agent: { model: 'test:model' } },
      },
      { TEST_API_KEY: 'test-key' },
      {
        fetchImpl: (async (_url, init) => {
          requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return Response.json({
            id: 'completion-test',
            object: 'chat.completion',
            created: 0,
            model: 'model',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: '```json\n{"decision":"buy","confidence":80}\n```',
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          });
        }) as typeof fetch,
      },
    );
    const out = await new AISDKAdapter(catalog.resolve('generation')).generate<
      z.infer<typeof TestSchema>
    >({ system: 'advisor', schema: TestSchema, data: {} });

    expect(out).toMatchObject({ decision: 'buy', confidence: 80 });
    expect(requests[0]).not.toHaveProperty('response_format');
    expect(JSON.stringify(requests[0])).toContain('JSON Schema');
    expect(out.usage).toEqual({
      promptTokens: 10,
      completionTokens: 10,
      reasoningTokens: 0,
      costUsd: 0,
    });
  });

  it('空输出且 finishReason=length 时抛出可诊断的预算错误', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text' as const, text: '' }],
        finishReason: { unified: 'length' as const, raw: undefined },
        usage,
        warnings: [],
      }),
    });
    const adapter = new AISDKAdapter(profile(model));
    await expect(
      adapter.generate({ system: 'advisor', schema: TestSchema, data: {} }),
    ).rejects.toThrow(LLMOutputBudgetError);
    await expect(
      adapter.generate({ system: 'advisor', schema: TestSchema, data: {} }),
    ).rejects.toThrow(/maxOutputTokens=2048/);
  });

  it('request.maxOutputTokens 覆盖 profile 预算并传给模型', async () => {
    const budgets: Array<number | undefined> = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        budgets.push(options.maxOutputTokens);
        return {
          content: [{ type: 'text' as const, text: '{"decision":"hold","confidence":50}' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage,
          warnings: [],
        };
      },
    });
    const adapter = new AISDKAdapter(profile(model));
    await adapter.generate({
      system: 'advisor',
      schema: TestSchema,
      data: {},
      maxOutputTokens: 8_192,
    });
    expect(budgets[0]).toBe(8_192);
  });

  it('缺 schema 时在发起模型请求前失败', async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls += 1;
        return {
          content: [{ type: 'text' as const, text: '{}' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage,
          warnings: [],
        };
      },
    });
    const adapter = new AISDKAdapter(profile(model, { providerType: 'openai-compatible' }));
    await expect(adapter.generate({ system: 'advisor', data: {} })).rejects.toThrow(/schema/);
    expect(calls).toBe(0);
  });

  it('提示词未超限时保持原始 JSON，raw 不带降级原因', async () => {
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        prompts.push(options.prompt);
        return {
          content: [{ type: 'text' as const, text: '{"decision":"hold","confidence":50}' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage,
          warnings: [],
        };
      },
    });
    const data = { stockId: 'X', quote: { close: 105.8 } };
    const out = await new AISDKAdapter(profile(model)).generate<z.infer<typeof TestSchema>>({
      system: 'advisor',
      schema: TestSchema,
      data,
    });
    expect(promptText(prompts[0])).toBe(JSON.stringify(data));
    expect(JSON.parse(out.raw)).not.toHaveProperty('promptProjection');
  });

  it('超过 maxPromptChars 时结构化裁剪：仍是完整 JSON、数字不变、降级原因可追踪', async () => {
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        prompts.push(options.prompt);
        return {
          content: [{ type: 'text' as const, text: '{"decision":"hold","confidence":50}' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage,
          warnings: [],
        };
      },
    });
    const data = {
      stockId: 'X',
      quote: { close: 105.8123456789, volume: 123456789 },
      bars: Array.from({ length: 200 }, (_, index) => ({
        date: `2026-01-${String((index % 28) + 1).padStart(2, '0')}`,
        close: 100 + index / 1000,
      })),
      news: [{ summary: 'x'.repeat(5_000) }],
    };
    const out = await new AISDKAdapter(profile(model, { maxPromptChars: 2_000 })).generate<
      z.infer<typeof TestSchema>
    >({ system: 'advisor', schema: TestSchema, data });

    const prompt = promptText(prompts[0]);
    expect(prompt.length).toBeLessThanOrEqual(2_000);
    const parsed = JSON.parse(prompt) as {
      promptBudget: { reason: string; trimmed: { path: string }[] };
      data: {
        quote: { close: number; volume: number };
        bars: unknown[];
        news: { summary: string }[];
      };
    };
    expect(parsed.promptBudget.reason).toBe('max_prompt_chars');
    expect(parsed.promptBudget.trimmed.map((item) => item.path)).toContain('data.bars');
    // 数字与字段结构不被截断：整段事实仍然可解析，数组只丢尾部。
    expect(parsed.data.quote.close).toBe(105.8123456789);
    expect(parsed.data.quote.volume).toBe(123456789);
    expect(parsed.data.bars.length).toBeLessThan(200);

    const raw = JSON.parse(out.raw) as {
      promptProjection: { reason: string; originalChars: number; projectedChars: number };
    };
    expect(raw.promptProjection.reason).toBe('max_prompt_chars');
    expect(raw.promptProjection.originalChars).toBeGreaterThan(raw.promptProjection.projectedChars);
  });

  it('结构化裁剪后仍超限 → 在发起请求前失败，不发送半截 JSON', async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls += 1;
        return {
          content: [{ type: 'text' as const, text: '{"decision":"hold","confidence":50}' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage,
          warnings: [],
        };
      },
    });
    const adapter = new AISDKAdapter(profile(model, { maxPromptChars: 120 }));
    await expect(
      adapter.generate({
        system: 'advisor',
        schema: TestSchema,
        data: { stockId: 'X', note: 'y'.repeat(1_000) },
      }),
    ).rejects.toThrow(LLMPromptBudgetError);
    expect(calls).toBe(0);
  });

  it('Date 字段投影为 ISO 字符串，不被裁剪丢失', () => {
    const projection = projectPromptData(
      {
        bars: [{ date: new Date('2026-11-24T07:00:00.000Z'), close: 10.5 }],
        notes: 'z'.repeat(200),
      },
      8_000,
    );
    expect(projection.degradation).toBeUndefined();
    expect(JSON.parse(projection.prompt)).toEqual({
      bars: [{ date: '2026-11-24T07:00:00.000Z', close: 10.5 }],
      notes: 'z'.repeat(200),
    });
  });
});
