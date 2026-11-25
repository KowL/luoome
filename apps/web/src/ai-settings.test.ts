import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AI_PROVIDER_PRESETS, AISettingsStore, SaveAISettingsSchema } from './ai-settings.js';

const temporaryDirectories: string[] = [];

const createStore = () => {
  const directory = mkdtempSync(join(tmpdir(), 'luoome-ai-settings-'));
  temporaryDirectories.push(directory);
  return {
    directory,
    store: new AISettingsStore(
      { LUOOME_HOME: directory },
      {
        configPath: join(directory, 'ai-models.json'),
        secretPath: join(directory, '.env'),
      },
    ),
  };
};

const settings = {
  profile: 'agent' as const,
  provider: 'minimax' as const,
  model: 'MiniMax-M3',
  baseURL: 'https://api.minimaxi.com/v1',
  apiKey: 'secret-test-key',
  clearApiKey: false,
  temperature: 0.1,
  timeoutSeconds: 120,
  maxRetries: 2,
  reasoningEffort: 'low' as const,
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('AISettingsStore', () => {
  it('提供 Kimi 与 DeepSeek 的官方推荐模型、端点和密钥变量', () => {
    expect(AI_PROVIDER_PRESETS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'kimi',
          defaultModel: 'kimi-k3',
          defaultBaseURL: 'https://api.moonshot.cn/v1',
          defaultTemperature: 1,
          fixedTemperature: 1,
          apiKeyEnv: 'MOONSHOT_API_KEY',
          supportsStructuredOutputs: false,
          supportedReasoningEfforts: ['off', 'low', 'high', 'max'],
        }),
        expect.objectContaining({
          id: 'deepseek',
          defaultModel: 'deepseek-v4-pro',
          defaultBaseURL: 'https://api.deepseek.com',
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          supportsStructuredOutputs: false,
          supportedReasoningEfforts: ['off', 'low', 'high', 'max'],
        }),
      ]),
    );
  });

  it('首次打开返回 MiniMax 推荐值，但不伪造已配置状态', () => {
    const { store } = createStore();
    expect(store.read()).toMatchObject({
      provider: 'minimax',
      model: 'MiniMax-M3',
      baseURL: 'https://api.minimaxi.com/v1',
      apiKeyConfigured: false,
      temperature: 0.2,
      timeoutSeconds: 120,
    });
  });

  it('配置与密钥分文件写入，读取 API 不回显密钥，并立即可构造 runtime env', () => {
    const { store } = createStore();
    const view = store.save(settings);
    const configText = readFileSync(store.configPath, 'utf8');
    const secretText = readFileSync(store.secretPath, 'utf8');
    expect(view).toMatchObject({
      provider: 'minimax',
      apiKeyConfigured: true,
      temperature: 0.1,
      maxRetries: 2,
      reasoningEffort: 'low',
    });
    expect(JSON.stringify(view)).not.toContain('secret-test-key');
    expect(configText).not.toContain('secret-test-key');
    expect(configText).toContain('"apiKeyEnv": "MINIMAX_API_KEY"');
    expect(secretText).toContain('MINIMAX_API_KEY=secret-test-key');
    expect(store.runtimeEnv().MINIMAX_API_KEY).toBe('secret-test-key');
    expect(statSync(store.configPath).mode & 0o777).toBe(0o600);
    expect(statSync(store.secretPath).mode & 0o777).toBe(0o600);
  });

  it('更新密钥保留 .env 其它变量，明确清除时只删除当前 provider 密钥', () => {
    const { store } = createStore();
    writeFileSync(store.secretPath, 'LUOOME_MARKET_PROVIDER=real\nMINIMAX_API_KEY=old\n');
    store.save(settings);
    expect(readFileSync(store.secretPath, 'utf8')).toBe(
      'LUOOME_MARKET_PROVIDER=real\nMINIMAX_API_KEY=secret-test-key\n',
    );
    store.save({ ...settings, apiKey: undefined, clearApiKey: true });
    expect(readFileSync(store.secretPath, 'utf8')).toBe('LUOOME_MARKET_PROVIDER=real\n');
    expect(store.read().apiKeyConfigured).toBe(false);
  });

  it('不支持统一推理强度的 provider 拒绝非 off 值', () => {
    expect(() =>
      SaveAISettingsSchema.parse({
        ...settings,
        provider: 'anthropic',
        reasoningEffort: 'high',
      }),
    ).toThrow(/Anthropic/);
  });

  it('Kimi K3 固定 temperature=1，Kimi 与 DeepSeek 拒绝不支持的 medium', () => {
    expect(() =>
      SaveAISettingsSchema.parse({
        ...settings,
        provider: 'kimi',
        model: 'kimi-k3',
        temperature: 0.2,
        reasoningEffort: 'high',
      }),
    ).toThrow(/temperature 必须为 1/);
    for (const provider of ['kimi', 'deepseek'] as const) {
      expect(() =>
        SaveAISettingsSchema.parse({
          ...settings,
          provider,
          model: provider === 'kimi' ? 'kimi-k3' : 'deepseek-v4-pro',
          temperature: provider === 'kimi' ? 1 : 0.2,
          reasoningEffort: 'medium',
        }),
      ).toThrow(/不支持推理强度 medium/);
    }
  });

  it.each([
    {
      provider: 'kimi' as const,
      model: 'kimi-k3',
      baseURL: 'https://api.moonshot.cn/v1',
      apiKeyEnv: 'MOONSHOT_API_KEY',
      temperature: 1,
    },
    {
      provider: 'deepseek' as const,
      model: 'deepseek-v4-pro',
      baseURL: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      temperature: 0.2,
    },
  ])('保存 $provider preset 后可按同一 provider 读回并立即生效', (preset) => {
    const { store } = createStore();
    const view = store.save({
      ...settings,
      provider: preset.provider,
      model: preset.model,
      baseURL: preset.baseURL,
      temperature: preset.temperature,
      reasoningEffort: 'max',
    });
    const config = JSON.parse(readFileSync(store.configPath, 'utf8'));

    expect(view).toMatchObject({
      provider: preset.provider,
      model: preset.model,
      baseURL: preset.baseURL,
      apiKeyConfigured: true,
      reasoningEffort: 'max',
    });
    expect(config.providers[preset.provider]).toMatchObject({
      type: 'openai-compatible',
      baseURL: preset.baseURL,
      apiKeyEnv: preset.apiKeyEnv,
      supportsStructuredOutputs: false,
      quirks: ['inject-schema', 'recover-malformed-text'],
    });
    expect(config.profiles.agent.model).toBe(`${preset.provider}:${preset.model}`);
    expect(store.runtimeEnv()[preset.apiKeyEnv]).toBe('secret-test-key');
  });

  it('自定义 provider 读回自己的 apiKeyEnv，不用 preset 的默认变量判定密钥', () => {
    const directory = mkdtempSync(join(tmpdir(), 'luoome-ai-settings-'));
    temporaryDirectories.push(directory);
    const configPath = join(directory, 'ai-models.json');
    const secretPath = join(directory, '.env');
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        providers: {
          'opencode-go': {
            type: 'openai-compatible',
            baseURL: 'https://opencode.example/v1',
            apiKeyEnv: 'OPENCODE_GO_API_KEY',
          },
        },
        profiles: {
          generation: { model: 'opencode-go:open-model' },
          agent: { model: 'opencode-go:open-model' },
        },
      }),
    );
    const store = new AISettingsStore(
      { LUOOME_HOME: directory, OPENAI_API_KEY: 'preset-key' },
      { configPath, secretPath },
    );

    expect(store.read()).toMatchObject({
      provider: 'openai-compatible',
      model: 'open-model',
      baseURL: 'https://opencode.example/v1',
      apiKeyEnv: 'OPENCODE_GO_API_KEY',
      apiKeyConfigured: false,
    });
    writeFileSync(secretPath, 'OPENCODE_GO_API_KEY=custom-key\n');
    expect(store.read()).toMatchObject({
      apiKeyEnv: 'OPENCODE_GO_API_KEY',
      apiKeyConfigured: true,
    });
  });

  it('generation 与 agent profile 独立保存：互不覆盖密钥、provider 与自定义配置', () => {
    const { store } = createStore();
    store.save({
      ...settings,
      profile: 'generation',
      provider: 'kimi',
      model: 'kimi-k3',
      baseURL: 'https://api.moonshot.cn/v1',
      temperature: 1,
      reasoningEffort: 'high',
    });
    store.save({
      ...settings,
      profile: 'agent',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      baseURL: 'https://api.deepseek.com',
      reasoningEffort: 'low',
    });
    const config = JSON.parse(readFileSync(store.configPath, 'utf8'));
    expect(config.profiles.generation.model).toBe('kimi:kimi-k3');
    expect(config.profiles.generation.reasoningEffort).toBe('high');
    expect(config.profiles.agent.model).toBe('deepseek:deepseek-v4-pro');
    expect(config.providers.kimi.apiKeyEnv).toBe('MOONSHOT_API_KEY');
    expect(config.providers.deepseek.apiKeyEnv).toBe('DEEPSEEK_API_KEY');

    const view = store.read();
    expect(view.profiles.generation).toMatchObject({
      profile: 'generation',
      provider: 'kimi',
      model: 'kimi-k3',
      apiKeyConfigured: true,
    });
    expect(view.profiles.agent).toMatchObject({
      profile: 'agent',
      provider: 'deepseek',
      apiKeyConfigured: true,
    });
    expect(view).toMatchObject({ provider: 'deepseek', model: 'deepseek-v4-pro' });
  });

  it('保存另一个 profile 不覆盖自定义 provider 及其引用的 profile', () => {
    const directory = mkdtempSync(join(tmpdir(), 'luoome-ai-settings-'));
    temporaryDirectories.push(directory);
    const configPath = join(directory, 'ai-models.json');
    const secretPath = join(directory, '.env');
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        providers: {
          'opencode-go': {
            type: 'openai-compatible',
            baseURL: 'https://opencode.example/v1',
            apiKeyEnv: 'OPENCODE_GO_API_KEY',
            maxOutputTokens: 12_000,
          },
        },
        profiles: {
          generation: { model: 'opencode-go:open-model', maxSteps: 3 },
          agent: { model: 'opencode-go:open-model' },
        },
      }),
    );
    const store = new AISettingsStore({ LUOOME_HOME: directory }, { configPath, secretPath });
    store.save({ ...settings, profile: 'agent', provider: 'minimax' });
    const config = JSON.parse(readFileSync(configPath, 'utf8'));

    expect(config.providers['opencode-go']).toMatchObject({
      baseURL: 'https://opencode.example/v1',
      apiKeyEnv: 'OPENCODE_GO_API_KEY',
    });
    expect(config.providers.minimax.apiKeyEnv).toBe('MINIMAX_API_KEY');
    expect(config.profiles.generation).toMatchObject({
      model: 'opencode-go:open-model',
      maxSteps: 3,
    });
    expect(config.profiles.agent.model).toBe('minimax:MiniMax-M3');
  });

  it('推理开启时保存的输出上限不低于安全下限，显式更高值保留', () => {
    const { store } = createStore();
    store.save({ ...settings, reasoningEffort: 'high' });
    let config = JSON.parse(readFileSync(store.configPath, 'utf8'));
    expect(config.profiles.agent.maxOutputTokens).toBe(8_192);
    expect(store.read().maxOutputTokens).toBe(8_192);

    store.save({ ...settings, reasoningEffort: 'high', maxOutputTokens: 16_384 });
    config = JSON.parse(readFileSync(store.configPath, 'utf8'));
    expect(config.profiles.agent.maxOutputTokens).toBe(16_384);

    store.save({ ...settings, reasoningEffort: 'off', maxOutputTokens: 1_024 });
    config = JSON.parse(readFileSync(store.configPath, 'utf8'));
    expect(config.profiles.agent.maxOutputTokens).toBe(1_024);
  });

  it('损坏的模型目录仍返回可编辑推荐值，保存后修复并补齐两个 profile', () => {
    const { store } = createStore();
    writeFileSync(store.configPath, '{broken');
    expect(store.read()).toMatchObject({
      provider: 'minimax',
      configError: expect.any(String),
    });
    expect(store.save(settings).configError).toBeUndefined();
    const config = JSON.parse(readFileSync(store.configPath, 'utf8'));
    expect(config.profiles.generation.model).toBe('minimax:MiniMax-M3');
    expect(config.profiles.agent.model).toBe('minimax:MiniMax-M3');
    for (const profile of ['generation', 'agent'] as const) {
      const providerName = String(config.profiles[profile].model).split(':')[0] ?? '';
      expect(config.providers[providerName]).toBeDefined();
    }
  });
});
