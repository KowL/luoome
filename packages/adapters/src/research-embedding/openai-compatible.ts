import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ResearchEmbeddingAdapterLike, ResearchEmbeddingModelIdentity } from '@luoome/core';
import { z } from 'zod';

const modelName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);
const modelConfigSchema = z.object({
  provider: z.string().trim().min(1).max(100),
  baseURL: z.url(),
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  model: z.string().trim().min(1).max(200),
  dimensions: z.number().int().positive().max(65_536),
  version: z.string().trim().min(1).max(200),
  timeoutMs: z.number().int().positive().max(300_000).default(30_000),
  maxBatchSize: z.number().int().positive().max(2_048).default(64),
  inputCostPerMillionTokensUsd: z.number().nonnegative().optional(),
});
export const ResearchEmbeddingCatalogSchema = z.object({
  version: z.literal(1),
  defaultModel: modelName,
  models: z.record(modelName, modelConfigSchema),
});
export type ResearchEmbeddingCatalog = z.infer<typeof ResearchEmbeddingCatalogSchema>;

const responseSchema = z.object({
  data: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      embedding: z.array(z.number().finite()).min(1),
    }),
  ),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative().optional() }).optional(),
});

export class OpenAICompatibleResearchEmbeddingAdapter implements ResearchEmbeddingAdapterLike {
  readonly name = 'research-embedding-openai-compatible';
  readonly defaultModel: string;

  constructor(
    private readonly catalog: ResearchEmbeddingCatalog,
    private readonly env: Readonly<Record<string, string | undefined>>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: () => number = () => Date.now(),
  ) {
    if (catalog.models[catalog.defaultModel] === undefined) {
      throw new Error(`默认 embedding model 未在目录中注册: ${catalog.defaultModel}`);
    }
    this.defaultModel = catalog.defaultModel;
  }

  listModels() {
    return Object.entries(this.catalog.models).map(([name, model]) => ({
      name,
      identity: this.identity(model),
    }));
  }

  async embed(
    input: Parameters<ResearchEmbeddingAdapterLike['embed']>[0],
  ): ReturnType<ResearchEmbeddingAdapterLike['embed']> {
    const modelNameValue = input.model ?? this.defaultModel;
    const config = this.catalog.models[modelNameValue];
    if (config === undefined) throw new Error(`未注册 embedding model: ${modelNameValue}`);
    const apiKey = this.env[config.apiKeyEnv]?.trim();
    if (!apiKey) throw new Error(`embedding provider 缺少密钥环境变量 ${config.apiKeyEnv}`);
    if (input.texts.length === 0) {
      return {
        identity: this.identity(config),
        vectors: [],
        usage: { inputTokens: 0, estimatedCostUsd: 0, latencyMs: 0 },
      };
    }
    const startedAt = this.clock();
    const vectors: number[][] = [];
    let inputTokens: number | undefined = 0;
    for (let offset = 0; offset < input.texts.length; offset += config.maxBatchSize) {
      const texts = input.texts.slice(offset, offset + config.maxBatchSize);
      const response = await this.fetchImpl(`${config.baseURL.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          input: texts,
          dimensions: config.dimensions,
          encoding_format: 'float',
        }),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`embedding provider 返回 HTTP ${response.status}`);
      }
      const parsed = responseSchema.parse(await response.json());
      const ordered = [...parsed.data].sort((left, right) => left.index - right.index);
      if (ordered.length !== texts.length) throw new Error('embedding provider 返回数量不匹配');
      for (const item of ordered) {
        if (item.embedding.length !== config.dimensions) {
          throw new Error(
            `embedding 维度不匹配: expected=${config.dimensions}, actual=${item.embedding.length}`,
          );
        }
        vectors.push(item.embedding);
      }
      const batchTokens = parsed.usage?.prompt_tokens;
      inputTokens =
        inputTokens === undefined || batchTokens === undefined
          ? undefined
          : inputTokens + batchTokens;
    }
    const estimatedCostUsd =
      inputTokens === undefined || config.inputCostPerMillionTokensUsd === undefined
        ? undefined
        : (inputTokens / 1_000_000) * config.inputCostPerMillionTokensUsd;
    return {
      identity: this.identity(config),
      vectors,
      usage: {
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
        latencyMs: Math.max(0, this.clock() - startedAt),
      },
    };
  }

  private identity(config: z.infer<typeof modelConfigSchema>): ResearchEmbeddingModelIdentity {
    return {
      provider: config.provider,
      model: config.model,
      dimensions: config.dimensions,
      version: config.version,
    };
  }
}

export const resolveResearchEmbeddingCatalogPath = (
  env: Readonly<Record<string, string | undefined>>,
): string =>
  env.LUOOME_RESEARCH_EMBEDDING_CONFIG?.trim() ||
  join(env.LUOOME_HOME?.trim() || join(homedir(), '.luoome'), 'research-embeddings.json');

export const createResearchEmbeddingAdapterFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  options: {
    readonly fetchImpl?: typeof fetch;
    readonly readFile?: (path: string) => string;
    readonly clock?: () => number;
  } = {},
): ResearchEmbeddingAdapterLike | undefined => {
  if (env.LUOOME_RESEARCH_EMBEDDING_ENABLED !== 'true') return undefined;
  const path = resolveResearchEmbeddingCatalogPath(env);
  const readFile = options.readFile ?? ((target: string) => readFileSync(target, 'utf8'));
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(path));
  } catch (error) {
    throw new Error(`无法读取 Research embedding 模型目录 ${path}`, { cause: error });
  }
  const catalog = ResearchEmbeddingCatalogSchema.parse(parsed);
  return new OpenAICompatibleResearchEmbeddingAdapter(
    catalog,
    env,
    options.fetchImpl,
    options.clock,
  );
};
