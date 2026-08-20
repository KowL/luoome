import { describe, expect, it } from 'vitest';
import {
  createResearchEmbeddingAdapterFromEnv,
  OpenAICompatibleResearchEmbeddingAdapter,
  ResearchEmbeddingCatalogSchema,
} from './openai-compatible.js';

const catalog = ResearchEmbeddingCatalogSchema.parse({
  version: 1,
  defaultModel: 'small',
  models: {
    small: {
      provider: 'fixture',
      baseURL: 'https://embedding.invalid/v1',
      apiKeyEnv: 'FIXTURE_EMBEDDING_KEY',
      model: 'fixture-small',
      dimensions: 3,
      version: 'v1',
      maxBatchSize: 2,
      inputCostPerMillionTokensUsd: 0.1,
    },
    large: {
      provider: 'fixture',
      baseURL: 'https://embedding.invalid/v1',
      apiKeyEnv: 'FIXTURE_EMBEDDING_KEY',
      model: 'fixture-large',
      dimensions: 3,
      version: 'v2',
    },
  },
});

describe('OpenAICompatibleResearchEmbeddingAdapter', () => {
  it('默认 capability 关闭，不读取目录或密钥', () => {
    expect(
      createResearchEmbeddingAdapterFromEnv({}, { readFile: () => 'invalid' }),
    ).toBeUndefined();
  });

  it('批量请求并保留模型 identity、usage 和成本估算', async () => {
    let calls = 0;
    let now = 100;
    const adapter = new OpenAICompatibleResearchEmbeddingAdapter(
      catalog,
      { FIXTURE_EMBEDDING_KEY: 'secret' },
      (async (_url, init) => {
        calls++;
        expect(init?.headers).toMatchObject({ authorization: 'Bearer secret' });
        const body = JSON.parse(String(init?.body)) as { input: string[] };
        return Response.json({
          data: body.input.map((_text, index) => ({ index, embedding: [calls, index, 1] })),
          usage: { prompt_tokens: body.input.length * 5 },
        });
      }) as typeof fetch,
      () => (now += 10),
    );
    const result = await adapter.embed({
      model: 'small',
      purpose: 'evaluation',
      texts: ['a', 'b', 'c'],
    });
    expect(calls).toBe(2);
    expect(result.identity).toEqual({
      provider: 'fixture',
      model: 'fixture-small',
      dimensions: 3,
      version: 'v1',
    });
    expect(result.vectors).toHaveLength(3);
    expect(result.usage).toEqual({ inputTokens: 15, estimatedCostUsd: 0.0000015, latencyMs: 10 });
  });

  it('维度不匹配时拒绝结果，不落到调用方投影', async () => {
    const adapter = new OpenAICompatibleResearchEmbeddingAdapter(
      catalog,
      { FIXTURE_EMBEDDING_KEY: 'secret' },
      (async () =>
        Response.json({ data: [{ index: 0, embedding: [1, 2] }] })) as unknown as typeof fetch,
    );
    await expect(
      adapter.embed({ model: 'small', purpose: 'query', texts: ['query'] }),
    ).rejects.toThrow('embedding 维度不匹配');
  });
});
