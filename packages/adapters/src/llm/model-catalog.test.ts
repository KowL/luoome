import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AISDKAdapter } from './ai-sdk-adapter.js';
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

  it.each([
    {
      provider: 'kimi',
      model: 'kimi-k3',
      baseURL: 'https://api.moonshot.cn/v1',
      apiKeyEnv: 'MOONSHOT_API_KEY',
      temperature: 1,
    },
    {
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      baseURL: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      temperature: 0.2,
    },
  ])('$provider 通过 OpenAI-compatible JSON Object 完成结构化生成', async (preset) => {
    let requestURL = '';
    let requestBody: Record<string, unknown> = {};
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requestURL = input instanceof Request ? input.url : String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 0,
          model: preset.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '{"decision":"hold"}' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const catalog = new AIModelCatalog(
      {
        version: 1,
        providers: {
          [preset.provider]: {
            type: 'openai-compatible',
            baseURL: preset.baseURL,
            apiKeyEnv: preset.apiKeyEnv,
            supportsStructuredOutputs: false,
            quirks: ['inject-schema', 'recover-malformed-text'],
          },
        },
        profiles: {
          generation: {
            model: `${preset.provider}:${preset.model}`,
            temperature: preset.temperature,
            reasoningEffort: 'high',
          },
          agent: { model: `${preset.provider}:${preset.model}`, temperature: preset.temperature },
        },
      },
      { [preset.apiKeyEnv]: 'test-key' },
      { fetchImpl },
    );
    const adapter = new AISDKAdapter(catalog.resolve('generation'));

    await expect(
      adapter.generate({
        system: 'system',
        data: { stockId: '000001.SZ' },
        schema: z.object({ decision: z.literal('hold') }),
      }),
    ).resolves.toMatchObject({ decision: 'hold' });
    expect(requestURL).toBe(`${preset.baseURL}/chat/completions`);
    expect(requestBody).toMatchObject({
      model: preset.model,
      temperature: preset.temperature,
      reasoning_effort: 'high',
      response_format: { type: 'json_object' },
    });
    expect(JSON.stringify(requestBody)).toContain('JSON Schema');
  });

  it('首次加载时生成默认模型目录，且文件不包含密钥', () => {
    const root = mkdtempSync(join(tmpdir(), 'luoome-model-catalog-'));
    const home = join(root, 'nested', '.luoome');
    const path = join(home, 'ai-models.json');
    try {
      const catalog = loadAIModelCatalog({
        LUOOME_HOME: home,
        MINIMAX_API_KEY: 'test-minimax',
      });

      expect(catalog.resolve('generation').modelRef).toBe('minimax:MiniMax-M3');
      const content = readFileSync(path, 'utf8');
      expect(JSON.parse(content)).toMatchObject({
        version: 1,
        providers: {
          kimi: {
            baseURL: 'https://api.moonshot.cn/v1',
            apiKeyEnv: 'MOONSHOT_API_KEY',
            supportsStructuredOutputs: false,
          },
          deepseek: {
            baseURL: 'https://api.deepseek.com',
            apiKeyEnv: 'DEEPSEEK_API_KEY',
            supportsStructuredOutputs: false,
          },
        },
        profiles: {
          generation: { model: 'minimax:MiniMax-M3' },
          agent: { model: 'minimax:MiniMax-M3' },
        },
      });
      expect(content).not.toContain('test-minimax');
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('已有模型目录无效时保留原文件并明确报错', () => {
    const home = mkdtempSync(join(tmpdir(), 'luoome-model-catalog-existing-'));
    const path = join(home, 'ai-models.json');
    try {
      writeFileSync(path, '{broken', 'utf8');

      expect(() => loadAIModelCatalog({ LUOOME_HOME: home })).toThrow(
        `AI 模型目录 ${path} 不是合法 JSON`,
      );
      expect(readFileSync(path, 'utf8')).toBe('{broken');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('显式模型目录缺失时保持报错，不在错误路径生成默认文件', () => {
    const root = mkdtempSync(join(tmpdir(), 'luoome-model-catalog-explicit-'));
    const path = join(root, 'missing', 'ai-models.json');
    try {
      expect(() =>
        loadAIModelCatalog({
          LUOOME_AI_CONFIG: path,
          MINIMAX_API_KEY: 'test-minimax',
        }),
      ).toThrow(`无法读取 AI 模型目录 ${path}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
