import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AISettingsStore, SaveAISettingsSchema } from './ai-settings.js';

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

  it('损坏的模型目录仍返回可编辑推荐值，保存后可修复', () => {
    const { store } = createStore();
    writeFileSync(store.configPath, '{broken');
    expect(store.read()).toMatchObject({
      provider: 'minimax',
      configError: expect.any(String),
    });
    expect(store.save(settings).configError).toBeUndefined();
  });
});
