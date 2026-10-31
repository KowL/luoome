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
      { ...input(), fuyao: { baseUrl: 'https://changed.example.test', clear: false } },
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

// REQ-M3-15 三条 PRD 硬验收的回归测试（此前只靠既有行为，没有测试 = 没有验收）。
describe('REQ-M3-15 PRD 硬验收', () => {
  it('留空保存：原密钥仍保留（留在磁盘与运行时），且不回显', () => {
    const { settings, path } = store({});
    settings.save(input(), () => () => {});
    // 留空（apiKey 缺席）再存一次，只改地址。
    settings.save(
      {
        sources: ['fuyao', 'tencent'],
        fuyao: { baseUrl: 'https://other.example.test', clear: false },
        credentials: {},
      },
      () => () => {},
    );
    expect(readFileSync(path, 'utf8')).toContain('FUYAO_API_KEY="synthetic-fuyao-key"');
    expect(settings.runtimeEnv().FUYAO_API_KEY).toBe('synthetic-fuyao-key');
    // 空串同样表示保留，不是清空。
    settings.save(
      { sources: ['fuyao', 'tencent'], fuyao: { apiKey: '', clear: false }, credentials: {} },
      () => () => {},
    );
    expect(settings.runtimeEnv().FUYAO_API_KEY).toBe('synthetic-fuyao-key');
  });

  it('不回显：视图里只有 configured 布尔，任何序列化都不含密钥原文', () => {
    const { settings } = store({});
    const view = settings.save(input(), () => () => {});
    expect(view.fuyao.configured).toBe(true);
    expect(JSON.stringify(view)).not.toContain('synthetic-fuyao-key');
    for (const section of view.credentials) {
      expect(Object.keys(section)).toEqual(
        expect.arrayContaining(['id', 'label', 'envKey', 'configured']),
      );
      expect(Object.keys(section)).not.toContain('apiKey');
    }
  });

  it('重启保留：新建 store（模拟重启）后配置与凭据都在', () => {
    const { settings, path } = store({});
    settings.save(input(), () => () => {});
    const restarted = new MarketSettingsStore({}, path);
    expect(restarted.read().activeOrder).toEqual(['fuyao', 'tencent']);
    expect(restarted.read().fuyao.configured).toBe(true);
    expect(restarted.runtimeEnv().FUYAO_API_KEY).toBe('synthetic-fuyao-key');
  });

  it('磁盘上不在 SETTINGS_KEYS 的键，保存后运行时也认（重读盘修复）', () => {
    const { settings, path } = store({});
    settings.save(input(), () => () => {});
    // 人工往 .env 写一个不在白名单里的键（例如新增供应商的 token）。
    const current = readFileSync(path, 'utf8');
    writeFileSync(path, `${current}TUSHARE_TOKEN="manual-token"\n`);
    // 再保存一次别的配置：运行时候选必须来自磁盘，而不是被内存覆盖。
    settings.save(
      {
        sources: ['fuyao', 'tencent'],
        fuyao: { baseUrl: 'https://changed.example.test', clear: false },
        credentials: {},
      },
      () => () => {},
    );
    expect(settings.runtimeEnv().TUSHARE_TOKEN).toBe('manual-token');
    expect(readFileSync(path, 'utf8')).toContain('TUSHARE_TOKEN="manual-token"');
  });

  it('凭据分区从 manifest 的 requiredEnv 派生（Tushare 也有一格）', () => {
    const { settings } = store({});
    const ids = settings.read().credentials.map((item) => item.id);
    expect(ids).toContain('tushare');
    expect(ids).toContain('fuyao');
    // 无 requiredEnv 的源不出现。
    expect(ids).not.toContain('eastmoney');
  });

  it('显式清空：clear:true 才删除密钥行；空串绝不等于清空', () => {
    const { settings, path } = store({});
    settings.save(input(), () => () => {});
    settings.save(
      { sources: ['tencent'], fuyao: { clear: true }, credentials: {} },
      () => () => {},
    );
    expect(readFileSync(path, 'utf8')).not.toContain('FUYAO_API_KEY');
    expect(settings.runtimeEnv().FUYAO_API_KEY).toBeUndefined();
    expect(settings.read().fuyao.configured).toBe(false);
  });
});
