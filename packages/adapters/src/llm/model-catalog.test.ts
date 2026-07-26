import { describe, expect, it } from 'vitest';
import { AIModelCatalog, loadAIModelCatalog, resolveAIModelCatalogPath } from './model-catalog.js';

const config = {
  version: 1,
  providers: {
    minimax: {
      type: 'openai-compatible',
      baseURL: 'https://api.minimaxi.com/v1',
      apiKeyEnv: 'MINIMAX_API_KEY',
      quirks: ['inject-schema', 'recover-malformed-text'],
    },
    anthropic: {
      type: 'anthropic',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
    },
  },
  profiles: {
    generation: { model: 'minimax:MiniMax-M3', timeoutMs: 45_000 },
    agent: {
      model: 'anthropic:claude-haiku-4-5',
      maxSteps: 4,
      maxTotalTokens: 8_000,
    },
  },
} as const;

describe('llm/model-catalog', () => {
  it('通过 AI SDK registry 解析多 provider profile 和显式 quirks', () => {
    const catalog = new AIModelCatalog(config, {
      MINIMAX_API_KEY: 'test-minimax',
      ANTHROPIC_API_KEY: 'test-anthropic',
    });
    const generation = catalog.resolve('generation');
    const agent = catalog.resolve('agent');
    expect(generation).toMatchObject({
      modelRef: 'minimax:MiniMax-M3',
      providerType: 'openai-compatible',
      timeoutMs: 45_000,
      quirks: { injectSchemaIntoSystem: true, recoverMalformedText: true },
    });
    expect(agent).toMatchObject({
      modelRef: 'anthropic:claude-haiku-4-5',
      providerType: 'anthropic',
      maxSteps: 4,
      maxTotalTokens: 8_000,
    });
  });

  it('只从 apiKeyEnv 引用读取密钥，缺失时启动失败', () => {
    expect(() => new AIModelCatalog(config, { ANTHROPIC_API_KEY: 'test' })).toThrow(
      /MINIMAX_API_KEY/,
    );
    expect(() => new AIModelCatalog(config, { MINIMAX_API_KEY: 'test' })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });

  it('从 LUOOME_AI_CONFIG 加载 JSON，且不读取旧 LUOOME_LLM_*', () => {
    let receivedPath = '';
    const catalog = loadAIModelCatalog(
      {
        LUOOME_AI_CONFIG: '/tmp/catalog.json',
        LUOOME_LLM_API_KEY: 'old-key-must-be-ignored',
        MINIMAX_API_KEY: 'test-minimax',
        ANTHROPIC_API_KEY: 'test-anthropic',
      },
      {
        readFile: (path) => {
          receivedPath = path;
          return JSON.stringify(config);
        },
      },
    );
    expect(receivedPath).toBe('/tmp/catalog.json');
    expect(catalog.resolve('generation').modelRef).toBe('minimax:MiniMax-M3');
  });

  it('缺省目录为 LUOOME_HOME/ai-models.json', () => {
    expect(resolveAIModelCatalogPath({ LUOOME_HOME: '/var/lib/luoome' })).toBe(
      '/var/lib/luoome/ai-models.json',
    );
  });
});
