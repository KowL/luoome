import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMarketAdapterFromEnv } from '@luoome/adapters';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMarketSettingsHandler,
  MarketSettingsStore,
  SaveMarketSettingsSchema,
} from './market-settings.js';

const roots: string[] = [];
const store = (env: Record<string, string> = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'luoome-market-settings-'));
  roots.push(root);
  const path = join(root, '.env');
  return { path, settings: new MarketSettingsStore(env, path) };
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const input = () =>
  SaveMarketSettingsSchema.parse({
    sources: ['fuyao', 'tencent'],
    fuyao: { baseUrl: 'https://fuyao.example.test/', apiKey: 'synthetic-fuyao-key' },
  });

describe('DSH market settings', () => {
  it('offers Xueqiu without credentials while preserving the default source order', async () => {
    const { settings } = store();
    const handler = createMarketSettingsHandler({
      read: () => settings.read(),
      save: (value) => settings.save(value, () => () => {}),
    });
    const response = await handler(new Request('https://dsh.test/api/luoome/settings/market'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: {
        activeOrder: ['eastmoney', 'tencent', 'sina'],
        sources: expect.arrayContaining([
          { id: 'xueqiu', label: '雪球（沪深报价 / 日线）', configured: true },
        ]),
      },
    });
  });

  it('saves and restores Xueqiu through the settings API and builds the configured capabilities', async () => {
    const baseEnv = { LUOOME_MARKET_PROVIDER: 'real' };
    const { settings, path } = store(baseEnv);
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    let market = createMarketAdapterFromEnv(settings.runtimeEnv(), { logger });
    const handler = createMarketSettingsHandler({
      read: () => settings.read(),
      save: (value) =>
        settings.save(value, (env) => {
          const next = createMarketAdapterFromEnv(env, { logger });
          return () => {
            market = next;
          };
        }),
    });
    const response = await handler(
      new Request('https://dsh.test/api/luoome/settings/market', {
        method: 'POST',
        headers: { origin: 'https://dsh.test', 'content-type': 'application/json' },
        body: JSON.stringify({
          sources: ['xueqiu', 'tencent'],
          fuyao: { baseUrl: settings.read().fuyao.baseUrl },
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: { activeOrder: ['xueqiu', 'tencent'], fuyao: { configured: false } },
    });
    expect(market.marketSourceStatus().slice(0, 2)).toEqual(
      ['quote', 'daily-bars'].map((dataset) => ({
        dataset,
        source: 'xueqiu',
        coverage: ['CN_A_SHARES_SH_SZ'],
        capabilityEnabled: true,
        configurationReady: true,
      })),
    );
    expect(readFileSync(path, 'utf8')).toContain('LUOOME_MARKET_SOURCES="xueqiu,tencent"');
    const reopened = new MarketSettingsStore(baseEnv, path);
    expect(reopened.read().activeOrder).toEqual(['xueqiu', 'tencent']);
    expect(
      createMarketAdapterFromEnv(reopened.runtimeEnv(), { logger }).marketSourceStatus(),
    ).toEqual(market.marketSourceStatus());
  });

  it('persists private credentials, keeps unrelated env entries and never returns a secret', () => {
    const { settings, path } = store();
    writeFileSync(path, '# existing settings\nUNRELATED=keep-me\n');
    const apply = vi.fn();
    const result = settings.save(input(), (env) => {
      expect(env.FUYAO_API_KEY).toBe('synthetic-fuyao-key');
      expect(env.LUOOME_MARKET_SOURCES).toBe('fuyao,tencent');
      expect(apply).not.toHaveBeenCalled();
      return apply;
    });
    expect(apply).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      activeOrder: ['fuyao', 'tencent'],
      fuyao: { baseUrl: 'https://fuyao.example.test', configured: true },
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-fuyao-key');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toContain('UNRELATED=keep-me');
    const reopened = new MarketSettingsStore({ FUYAO_API_KEY: 'old-env-key' }, path);
    expect(reopened.read()).toEqual(result);
    expect(reopened.runtimeEnv().FUYAO_API_KEY).toBe('synthetic-fuyao-key');
    reopened.save(
      { ...input(), fuyao: { baseUrl: 'https://changed.example.test' } },
      () => () => {},
    );
    expect(new MarketSettingsStore({}, path).runtimeEnv().FUYAO_API_KEY).toBe(
      'synthetic-fuyao-key',
    );
  });

  it('does not let persisted market settings override ownership or tool permissions', () => {
    const { path } = store();
    writeFileSync(
      path,
      'FUYAO_API_KEY=saved\nLUOOME_OWNER_ACCOUNT_ID=other\nLUOOME_EXPOSE_TRADE=true\n',
    );
    const settings = new MarketSettingsStore({ LUOOME_OWNER_ACCOUNT_ID: 'owner' }, path);
    expect(settings.runtimeEnv()).toEqual({
      FUYAO_API_KEY: 'saved',
      LUOOME_OWNER_ACCOUNT_ID: 'owner',
    });
  });

  it('keeps the previous file and configuration when adapter preparation or persistence fails', () => {
    const { settings, path } = store();
    settings.save(input(), () => () => {});
    const before = readFileSync(path, 'utf8');
    expect(() =>
      settings.save({ ...input(), sources: ['tencent'] }, () => {
        throw new Error('adapter rejected candidate');
      }),
    ).toThrow('adapter rejected candidate');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(settings.read().activeOrder).toEqual(['fuyao', 'tencent']);
    const impossible = new MarketSettingsStore({}, join(path, 'nested.env'));
    const apply = vi.fn();
    expect(() => impossible.save(input(), () => apply)).toThrow();
    expect(apply).not.toHaveBeenCalled();
    expect(impossible.read().activeOrder).toEqual(['eastmoney', 'tencent', 'sina']);
  });

  it('rejects missing credentials without modifying the current configuration', async () => {
    const { settings } = store();
    const handler = createMarketSettingsHandler({
      read: () => settings.read(),
      save: (value) => settings.save(value, () => () => {}),
    });
    const response = await handler(
      new Request('https://dsh.test/api/luoome/settings/market', {
        method: 'POST',
        headers: { origin: 'https://dsh.test', 'content-type': 'application/json' },
        body: JSON.stringify({ ...input(), fuyao: { baseUrl: 'https://fuyao.example.test' } }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
    expect(settings.read().activeOrder).not.toContain('fuyao');
  });

  it('requires same-origin JSON and sanitizes invalid inputs and storage errors', async () => {
    const { settings } = store();
    const save = vi.fn(() => {
      throw new Error('synthetic-fuyao-key /private/path');
    });
    const handler = createMarketSettingsHandler({ read: () => settings.read(), save });
    const request = (body: unknown, origin?: string) =>
      new Request('https://dsh.test/api/luoome/settings/market', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
        body: JSON.stringify(body),
      });
    for (const origin of [undefined, 'https://other.test'])
      expect((await handler(request(input(), origin))).status).toBe(403);
    for (const body of [
      { ...input(), sources: ['fuyao', 'fuyao'] },
      { ...input(), sources: ['fuyao', 'tencent', 'sina', 'eastmoney'] },
      { ...input(), owner: 'other' },
      { ...input(), fuyao: { ...input().fuyao, apiKey: 'key\nLUOOME_EXPOSE_TRADE=true' } },
      ...[
        'file:///private/key',
        'https://user:pass@example.test',
        'https://example.test?key=secret',
      ].map((baseUrl) => ({ ...input(), fuyao: { baseUrl } })),
    ])
      expect((await handler(request(body, 'https://dsh.test'))).status).toBe(400);
    expect(save).not.toHaveBeenCalled();
    const response = await handler(request(input(), 'https://dsh.test'));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/synthetic-fuyao-key|private\/path/);
    const read = await handler(new Request('https://dsh.test/api/luoome/settings/market'));
    expect(read.headers.get('cache-control')).toBe('no-store');
  });
});
