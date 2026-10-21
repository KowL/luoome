import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostedAISettingsStore } from './hosted-ai-settings.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'luoome-admin-ai-'));
  roots.push(root);
  return { root, store: new HostedAISettingsStore(root, { HOSTED_AI_ENABLED: 'false' }) };
};

test('administrator settings survive restart, retain or clear keys and never expose them in views', () => {
  const { root, store } = setup();
  expect(store.snapshot()).toBeUndefined();
  const settings = { ...store.read().settings, enabled: true };
  const saved = store.save({ settings, apiKey: 'fixture-admin-key' });
  expect(saved.apiKeyConfigured).toBe(true);
  expect(JSON.stringify(saved)).not.toContain('fixture-admin-key');
  expect(JSON.stringify(saved)).not.toContain(root);
  expect(statSync(join(root, 'operator', 'ai-settings.json')).mode & 0o777).toBe(0o600);
  const restarted = new HostedAISettingsStore(root, { HOSTED_AI_ENABLED: 'false' });
  expect(restarted.snapshot()?.model).toBe('deepseek-flash');
  store.save({ settings: { ...settings, model: 'new-model' }, apiKey: '' });
  expect(restarted.snapshot()?.model).toBe('new-model');
  expect(restarted.snapshot()?.env.HOSTED_AI_API_KEY).toBe('fixture-admin-key');
  store.save({ settings: { ...settings, enabled: false }, clearApiKey: true });
  expect(restarted.read().apiKeyConfigured).toBe(false);
  expect(restarted.snapshot()).toBeUndefined();
});

test('invalid edits are atomic and changing provider address never reuses an old key', () => {
  const { root, store } = setup();
  const settings = { ...store.read().settings, enabled: true };
  store.save({ settings, apiKey: 'fixture-original-key' });
  const path = join(root, 'operator', 'ai-settings.json');
  const before = readFileSync(path, 'utf8');
  for (const change of [
    { baseURL: 'https://other.invalid/v1' },
    { baseURL: 'http://other.invalid/v1' },
    { baseURL: 'https://user:password@other.invalid/v1' },
    { baseURL: 'https://other.invalid/v1?api_key=secret' },
    { inputPrice: 0 },
    { callBudget: 100, periodBudget: 1 },
  ]) {
    expect(() => store.save({ settings: { ...settings, ...change } })).toThrow();
    expect(readFileSync(path, 'utf8')).toBe(before);
  }
  expect(() => store.save({ settings, clearApiKey: true })).toThrow();
  expect(() => store.save({ settings, apiKey: 'secret\nINJECTED=value' })).toThrow();
  store.save({
    settings: {
      ...settings,
      provider: 'kimi',
      model: 'kimi-k3',
      baseURL: 'https://api.moonshot.cn/v1/',
      inputPrice: 20,
      cachedInputPrice: 20,
      outputPrice: 100,
    },
    apiKey: 'fixture-new-key',
  });
  const snapshot = store.snapshot();
  expect(snapshot?.endpoint).toBe('https://api.moonshot.cn/v1/chat/completions');
  expect(snapshot?.env.HOSTED_AI_API_KEY).toBe('fixture-new-key');
  expect(snapshot?.pricing(new Date())).toMatchObject({
    provider: 'kimi',
    model: 'kimi-k3',
    inputMicroPerMillion: 20_000_000,
    outputMicroPerMillion: 100_000_000,
  });
});
