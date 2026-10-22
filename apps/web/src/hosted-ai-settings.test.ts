import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

test('an existing Anthropic address remains readable and can be corrected with a new key', () => {
  const { root, store } = setup();
  const settings = {
    ...store.read().settings,
    enabled: true,
    provider: 'openai-compatible' as const,
    model: 'MiniMax-M3.1-Flash',
    baseURL: 'https://api.minimax.cn/v1',
  };
  store.save({ settings, apiKey: 'fixture-original-key' });
  const path = join(root, 'operator', 'ai-settings.json');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      settings: { ...settings, baseURL: 'https://api.minimaxi.com/anthropic' },
      apiKey: 'fixture-original-key',
    }),
  );
  const restarted = new HostedAISettingsStore(root, {});
  expect(restarted.read().apiKeyConfigured).toBe(true);
  expect(() => restarted.save({ settings })).toThrow('请重新填写 API 密钥');
  restarted.save({
    settings: { ...restarted.read().settings, enabled: false },
    clearApiKey: true,
  });
  expect(restarted.snapshot()).toBeUndefined();
  expect(restarted.read().apiKeyConfigured).toBe(false);
  restarted.save({ settings, apiKey: 'fixture-reentered-key' });
  expect(restarted.snapshot()?.endpoint).toBe('https://api.minimax.cn/v1/chat/completions');
  expect(restarted.snapshot()?.env.HOSTED_AI_API_KEY).toBe('fixture-reentered-key');
});

test('provider drafts preserve the active model, credentials and concurrent edits across restarts', () => {
  const { root, store } = setup();
  store.save({ settings: { ...store.read().settings, enabled: true }, apiKey: 'fixture-deepseek' });
  const initial = store.read();
  const model = {
    ...initial.providers[0]?.models[0],
    id: 'MiniMax-M3.1-Flash',
    name: 'MiniMax Flash',
  };
  const added = store.mutate({
    action: 'save-provider',
    revision: initial.revision,
    provider: {
      id: 'minimax',
      name: 'MiniMax',
      baseURL: 'https://api.minimax.cn/v1',
      models: [model],
    },
    apiKey: 'fixture-minimax',
  });
  expect(added.providers).toHaveLength(2);
  expect(store.snapshot()?.model).toBe('deepseek-flash');
  expect(JSON.stringify(added)).not.toContain('fixture-minimax');
  expect(() =>
    store.mutate({ action: 'remove-provider', revision: initial.revision, providerId: 'minimax' }),
  ).toThrow('其他页面');
  store.mutate({
    action: 'select-model',
    revision: added.revision,
    providerId: 'minimax',
    modelId: model.id,
    enabled: true,
    callBudget: 1,
    periodBudget: 20,
  });
  const restarted = new HostedAISettingsStore(root, {});
  expect(restarted.snapshot()?.model).toBe(model.id);
  expect(restarted.snapshot()?.env.HOSTED_AI_API_KEY).toBe('fixture-minimax');
  expect(restarted.read().providers).toHaveLength(2);
  expect(() =>
    restarted.mutate({
      action: 'remove-provider',
      revision: restarted.read().revision,
      providerId: 'minimax',
    }),
  ).toThrow('正在使用');
});

test('provider edits require a new key for a changed host and keep invalid writes atomic', () => {
  const { root, store } = setup();
  store.save({ settings: { ...store.read().settings, enabled: true }, apiKey: 'fixture-old-key' });
  const view = store.read();
  const first = view.providers[0];
  if (!first) throw new Error('Expected saved provider');
  const { apiKeyConfigured: _, ...provider } = first;
  const before = readFileSync(join(root, 'operator', 'ai-settings.json'), 'utf8');
  for (const edited of [
    { ...provider, baseURL: 'https://different.invalid/v1' },
    { ...provider, models: [...provider.models, provider.models[0]] },
    { ...provider, models: [] },
  ]) {
    expect(() =>
      store.mutate({ action: 'save-provider', revision: view.revision, provider: edited }),
    ).toThrow();
    expect(readFileSync(join(root, 'operator', 'ai-settings.json'), 'utf8')).toBe(before);
  }
  store.mutate({
    action: 'save-provider',
    revision: view.revision,
    provider: { ...provider, name: 'Renamed' },
  });
  expect(store.snapshot()?.env.HOSTED_AI_API_KEY).toBe('fixture-old-key');
});

test('model discovery uses the draft endpoint without saving and never forwards a stored key to another host', async () => {
  const { root } = setup();
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const store = new HostedAISettingsStore(root, {}, async (url, init) => {
    requests.push({ url, init });
    return Response.json({
      data: [{ id: 'model-a', name: 'Model A' }, { id: 'model-a' }, { id: 'model-b' }],
    });
  });
  store.save({
    settings: { ...store.read().settings, enabled: true },
    apiKey: 'fixture-discovery-key',
  });
  const revision = store.read().revision;
  expect(
    await store.discoverModels({ providerId: 'deepseek', baseURL: 'https://api.deepseek.com' }),
  ).toEqual({
    models: [
      { id: 'model-a', name: 'model-a' },
      { id: 'model-b', name: 'model-b' },
    ],
  });
  expect(requests[0]?.url).toBe('https://api.deepseek.com/models');
  expect(requests[0]?.init.redirect).toBe('error');
  expect(new Headers(requests[0]?.init.headers).get('authorization')).toBe(
    'Bearer fixture-discovery-key',
  );
  await expect(
    store.discoverModels({ providerId: 'deepseek', baseURL: 'https://other.invalid/v1' }),
  ).rejects.toThrow('当前 API 地址');
  expect(requests).toHaveLength(1);
  await store.discoverModels({ baseURL: 'https://other.invalid/v1', apiKey: 'fixture-draft-key' });
  expect(requests[1]?.url).toBe('https://other.invalid/v1/models');
  expect(store.read().revision).toBe(revision);
  expect(store.read().providers).toHaveLength(1);
});

test('discovery rejects oversized, malformed and secret-bearing responses without echoing provider data', async () => {
  const { root } = setup();
  for (const response of [
    () => Response.json({ data: [{ id: 'fixture-echo-key' }] }),
    () =>
      new Response(
        JSON.stringify({ data: [{ id: 'fixture-echo-key' }] }).replace('fixture', '\\u0066ixture'),
      ),
    () => new Response('fixture-echo-key', { status: 401 }),
    () => new Response('x'.repeat(1_048_577)),
    () => Response.json({ error: 'private upstream detail' }),
  ]) {
    const store = new HostedAISettingsStore(root, {}, async () => response());
    await expect(
      store.discoverModels({ baseURL: 'https://models.invalid/v1', apiKey: 'fixture-echo-key' }),
    ).rejects.not.toThrow('fixture-echo-key');
  }
});
