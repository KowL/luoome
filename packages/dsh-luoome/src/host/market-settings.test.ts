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

  it('loads explicitly configured Fuyao domains and shared transport limits after restart', () => {
    const { path } = store();
    const saved = {
      LUOOME_MARKET_DUMP_SOURCES: 'fuyao',
      LUOOME_SECTOR_MEMBERSHIP_SOURCES: 'fuyao',
      LUOOME_FINANCIAL_SNAPSHOT_SOURCES: 'fuyao',
      LUOOME_LIMIT_UP_LADDER_SOURCES: 'eastmoney,fuyao',
      LUOOME_ASHARE_SENTIMENT_SOURCES: 'eastmoney,fuyao',
      LUOOME_DRAGON_TIGER_SOURCES: 'eastmoney,fuyao',
      LUOOME_NEWS_SOURCES: 'eastmoney,fuyao',
      LUOOME_SECTOR_QUOTE_SOURCES: 'eastmoney,fuyao',
      LUOOME_FUYAO_NEWS_TAG_ID: '21103',
      FUYAO_MAX_CONCURRENCY: '2',
      FUYAO_MIN_INTERVAL_MS: '100',
      FUYAO_MAX_RETRIES: '2',
      FUYAO_RATE_LIMIT_COOLDOWN_MS: '30000',
    };
    writeFileSync(
      path,
      Object.entries(saved)
        .map(([key, value]) => `${key}="${value}"`)
        .join('\n'),
    );
    expect(new MarketSettingsStore({}, path).runtimeEnv()).toMatchObject(saved);
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
    writeFileSync(path, `${current}MANUAL_TOKEN="manual-token"\n`);
    // 再保存一次别的配置：运行时候选必须来自磁盘，而不是被内存覆盖。
    settings.save(
      {
        sources: ['fuyao', 'tencent'],
        fuyao: { baseUrl: 'https://changed.example.test', clear: false },
        credentials: {},
      },
      () => () => {},
    );
    expect(settings.runtimeEnv().MANUAL_TOKEN).toBe('manual-token');
    expect(readFileSync(path, 'utf8')).toContain('MANUAL_TOKEN="manual-token"');
  });

  it('凭据分区从 manifest 的 requiredEnv 派生', () => {
    const { settings } = store({});
    const ids = settings.read().credentials.map((item) => item.id);
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

// task-32：飞书通知通道搬进插件设置（`kind` 判别 + 三态 + 域名白名单 + 不回显）。
describe('task-32 飞书通知通道', () => {
  const FEISHU = 'LUOOME_FEISHU_WEBHOOK_URL';
  const VALID = 'https://open.feishu.cn/open-apis/bot/v2/hook/abcd-1234_EF';
  const withFeishu = (feishu: unknown) =>
    SaveMarketSettingsSchema.parse({
      sources: ['fuyao', 'tencent'],
      fuyao: { baseUrl: 'https://fuyao.example.test/', apiKey: 'k' },
      credentials: {},
      notifications: { feishu },
    });

  it('credentials 数组里追加非行情源条目，用 kind 区分（不塞进 manifest）', () => {
    const { settings } = store({ [FEISHU]: VALID });
    const view = settings.read();
    const feishu = view.credentials.find((section) => section.id === 'feishu');
    expect(feishu?.kind).toBe('notification-channel');
    expect(feishu?.configured).toBe(true);
    expect(feishu?.envKey).toBe(FEISHU);
    // 行情源条目都带 market-source 判别字段。
    for (const section of view.credentials.filter((item) => item.kind === 'market-source'))
      expect(section.kind).toBe('market-source');
    // 非行情源条目只剩通知通道（task-38：local-path 已按 PRD 废弃）。
    for (const section of view.credentials.filter((item) => item.kind !== 'market-source'))
      expect(section.kind).toBe('notification-channel');
    // 类型上已无 `local-path` 分支；运行时用源码守卫再钉一次（见下方 task-38 用例）。
  });

  it('任何序列化都不含 Webhook 原文（只给 configured + 端点域名）', () => {
    const { settings } = store({ [FEISHU]: VALID });
    const serialized = JSON.stringify(settings.read());
    expect(serialized).not.toContain('abcd-1234_EF');
    expect(serialized).not.toContain(VALID);
    expect(serialized).toContain('open.feishu.cn');
  });

  it('保存：非空更新；空串保留原值；clearWebhook 才删除（三条都要成立）', () => {
    const { path, settings } = store({});
    // 非空 → 写入
    settings.save(withFeishu({ webhookUrl: VALID }), () => () => undefined);
    expect(settings.read().credentials.find((s) => s.id === 'feishu')?.configured).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toContain(FEISHU);

    // 空串 → 保留（不是清空）
    settings.save(withFeishu({ webhookUrl: '' }), () => () => undefined);
    expect(settings.read().credentials.find((s) => s.id === 'feishu')?.configured).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain(FEISHU);

    // 缺席 → 保留
    settings.save(withFeishu({}), () => () => undefined);
    expect(settings.read().credentials.find((s) => s.id === 'feishu')?.configured).toBe(true);

    // clearWebhook: true → 删除
    settings.save(withFeishu({ clearWebhook: true }), () => () => undefined);
    expect(settings.read().credentials.find((s) => s.id === 'feishu')?.configured).toBe(false);
    expect(readFileSync(path, 'utf8')).not.toContain(FEISHU);
  });

  it('非法 Webhook 被拒且点名原因（http / 非飞书域名 / 带 query）', () => {
    const { settings } = store({});
    const rejects: [string, RegExp][] = [
      ['http://open.feishu.cn/open-apis/bot/v2/hook/abc', /仅支持飞书自定义机器人的 HTTPS Webhook/],
      [
        'https://evil.example.com/open-apis/bot/v2/hook/abc',
        /仅支持飞书自定义机器人的 HTTPS Webhook/,
      ],
      [
        'https://open.feishu.cn/open-apis/bot/v2/hook/abc?token=1',
        /仅支持飞书自定义机器人的 HTTPS Webhook/,
      ],
      [
        'https://user:pw@open.feishu.cn/open-apis/bot/v2/hook/abc',
        /仅支持飞书自定义机器人的 HTTPS Webhook/,
      ],
      ['https://open.feishu.cn/other/path', /仅支持飞书自定义机器人的 HTTPS Webhook/],
    ];
    for (const [url, expected] of rejects)
      expect(
        () => settings.save(withFeishu({ webhookUrl: url }), () => () => undefined),
        url,
      ).toThrow(expected);
    // 全部被拒后仍未配置（失败不留半成品）。
    expect(settings.read().credentials.find((s) => s.id === 'feishu')?.configured).toBe(false);
  });

  it('clearWebhook 与 webhookUrl 同时给出 → 拒绝（不猜用户意图）', () => {
    expect(() => withFeishu({ webhookUrl: VALID, clearWebhook: true })).toThrow(
      'clearWebhook 与 webhookUrl 不能同时给出',
    );
  });

  it('重启保留：磁盘上的 Webhook 在重建 store 后仍可见', () => {
    const { path, settings } = store({});
    settings.save(withFeishu({ webhookUrl: VALID }), () => () => undefined);
    const reopened = new MarketSettingsStore({}, path);
    expect(reopened.read().credentials.find((s) => s.id === 'feishu')?.configured).toBe(true);
    expect(reopened.runtimeEnv()[FEISHU]).toBe(VALID);
  });
});

// task-38：研究库设置分区按 PRD M4-01 废弃——**只拆界面，不动工具层与磁盘已有值**。
describe('task-38 研究库设置已废弃', () => {
  const VAULT = 'LUOOME_RESEARCH_VAULT';
  const VAULT_ID = 'LUOOME_RESEARCH_VAULT_ID';

  it('设置视图与源码里都不再出现研究库分区', async () => {
    const { settings } = store({ [VAULT]: '/opt/vault' });
    // 运行时：只有行情源 + 飞书两类。
    expect(new Set(settings.read().credentials.map((section) => section.kind))).toEqual(
      new Set(['market-source', 'notification-channel']),
    );
    // 静态：源码里不再有 local-path / localPaths / 研究库常量。
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'market-settings.ts'),
      'utf8',
    );
    for (const token of ['local-path', 'localPaths', 'RESEARCH_VAULT_CHANNEL', 'pathKey'])
      expect(source, token).not.toContain(token);
  });

  it('保存设置**不会删掉** .env 里已有的研究库键（只停界面读写）', () => {
    const { path, settings } = store({});
    // 模拟用户手写过：直接落盘（走 save 之外的路径，等价于 `echo ... >> .env`）。
    writeFileSync(path, `${VAULT}="/opt/vault"\n${VAULT_ID}="my-vault"\n`, { mode: 0o600 });
    settings.save(
      SaveMarketSettingsSchema.parse({
        sources: ['fuyao', 'tencent'],
        fuyao: { baseUrl: 'https://fuyao.example.test/', apiKey: 'k' },
        credentials: {},
      }),
      () => () => undefined,
    );
    const text = readFileSync(path, 'utf8');
    // **磁盘上原有的键必须还在**。
    expect(text).toContain(`${VAULT}="/opt/vault"`);
    expect(text).toContain(`${VAULT_ID}="my-vault"`);
  });

  it('手写值仍然进运行时（SETTINGS_KEYS 保留研究库键 ⇒ 已有配置不失效）', () => {
    const { path } = store({});
    writeFileSync(path, `${VAULT}="/opt/vault"\n`, { mode: 0o600 });
    const reopened = new MarketSettingsStore({}, path);
    // 移出 SETTINGS_KEYS 会让这里变 undefined —— 那正是「界面废弃顺带废掉已有配置」的事故。
    expect(reopened.runtimeEnv()[VAULT]).toBe('/opt/vault');
  });

  it('工具层未被误伤：研究库相关工具仍然注册', async () => {
    const { toolRegistry } = await import('@luoome/tools');
    const names = toolRegistry.all().map((tool) => tool.name);
    for (const name of [
      'create_research_document',
      'list_research_documents',
      'search_research_documents',
    ])
      expect(names, name).toContain(name);
  });
});
