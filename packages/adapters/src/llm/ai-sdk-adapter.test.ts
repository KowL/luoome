import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AISDKAdapter } from './ai-sdk-adapter.js';
import type { ResolvedAIModelProfile } from './model-catalog.js';

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

describe('llm/ai-sdk-adapter', () => {
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
});
