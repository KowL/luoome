import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMarketAdapterFromEnv } from '@luoome/adapters';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    // 行情源条目都带 market-source 判别字段（task-33 后 credentials 里还有 local-path 条目）。
    for (const section of view.credentials.filter((item) => item.kind === 'market-source'))
      expect(section.kind).toBe('market-source');
    // 非行情源条目必须是另外两种 kind（不是 market-source）。
    for (const section of view.credentials.filter((item) => item.kind !== 'market-source'))
      expect(['notification-channel', 'local-path']).toContain(section.kind);
    expect(view.credentials.filter((item) => item.kind === 'local-path')).toHaveLength(1);
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

// task-33：研究库（本机路径）配置搬进设置分区。
describe('task-33 研究库路径通道', () => {
  const VAULT = 'LUOOME_RESEARCH_VAULT';
  const VAULT_ID = 'LUOOME_RESEARCH_VAULT_ID';
  let vaultDir: string;

  beforeEach(() => {
    vaultDir = mkdtempSync(join(tmpdir(), 'luoome-vault-'));
    roots.push(vaultDir);
  });

  const withVault = (researchVault: unknown) =>
    SaveMarketSettingsSchema.parse({
      sources: ['fuyao', 'tencent'],
      fuyao: { baseUrl: 'https://fuyao.example.test/', apiKey: 'k' },
      credentials: {},
      localPaths: { researchVault },
    });

  it('credentials 数组里追加 local-path 条目，与凭据/通知通道在类型上可区分', () => {
    const { settings } = store({ [VAULT]: vaultDir });
    const view = settings.read();
    const vault = view.credentials.find((section) => section.id === 'research-vault');
    expect(vault?.kind).toBe('local-path');
    expect(vault?.configured).toBe(true);
    expect(vault?.envKey).toBe(VAULT);
    // 三个 kind 互不混淆。
    expect(view.credentials.filter((s) => s.kind === 'local-path')).toHaveLength(1);
    expect(view.credentials.filter((s) => s.kind === 'notification-channel')).toHaveLength(1);
  });

  it('路径可以回显（不是秘密），且库 ID 也回显', () => {
    const { settings } = store({ [VAULT]: vaultDir, [VAULT_ID]: 'my-vault' });
    const vault = settings.read().credentials.find((s) => s.id === 'research-vault');
    expect(vault?.kind === 'local-path' ? vault.path : undefined).toBe(vaultDir);
    expect(vault?.kind === 'local-path' ? vault.vaultId : undefined).toBe('my-vault');
  });

  it('保存三态：非空更新 / 空串与缺席保留 / clearVault 才删除（两个键一起删）', () => {
    const { path, settings } = store({});
    settings.save(withVault({ path: vaultDir, vaultId: 'v1' }), () => () => undefined);
    expect(settings.read().credentials.find((s) => s.id === 'research-vault')?.configured).toBe(
      true,
    );
    expect(statSync(path).mode & 0o777).toBe(0o600);

    // 空串 → 保留（断言的是「值还在」，不是「没抛错」——mutation「空串即清空」必须在这里红）
    settings.save(withVault({ path: '' }), () => () => undefined);
    expect(readFileSync(path, 'utf8')).toContain(`${VAULT}="${vaultDir}"`);
    expect(settings.read().credentials.find((s) => s.id === 'research-vault')?.configured).toBe(
      true,
    );
    // 缺席 → 保留
    settings.save(withVault({}), () => () => undefined);
    expect(readFileSync(path, 'utf8')).toContain(VAULT);

    // clearVault → 两个键都删
    settings.save(withVault({ clearVault: true }), () => () => undefined);
    const text = readFileSync(path, 'utf8');
    expect(text).not.toContain(VAULT);
    expect(text).not.toContain(VAULT_ID);
    expect(settings.read().credentials.find((s) => s.id === 'research-vault')?.configured).toBe(
      false,
    );
  });

  it('非法路径被拒且点名原因（相对 / 不存在 / 是文件 / 太宽 / .obsidian）', () => {
    const { settings } = store({});
    const filePath = join(vaultDir, 'a-file.txt');
    writeFileSync(filePath, 'x');
    const rejects: [string, RegExp][] = [
      ['relative/path', /必须填绝对路径/],
      [join(vaultDir, 'does-not-exist'), /路径不存在/],
      [filePath, /路径存在但不是目录/],
      ['/', /路径太宽泛或是保留目录/],
      [join(vaultDir, '.obsidian'), /路径太宽泛或是保留目录/],
    ];
    mkdirSync(join(vaultDir, '.obsidian'));
    for (const [path, expected] of rejects)
      expect(() => settings.save(withVault({ path }), () => () => undefined), path).toThrow(
        expected,
      );
    expect(settings.read().credentials.find((s) => s.id === 'research-vault')?.configured).toBe(
      false,
    );
  });

  it('clearVault 与 path 同时给出 → 拒绝', () => {
    expect(() => withVault({ path: vaultDir, clearVault: true })).toThrow(
      'clearVault 与 path 不能同时给出',
    );
  });

  it('重启保留：磁盘上的研究库配置在重建 store 后仍可见（SETTINGS_KEYS 覆盖两个键）', () => {
    const { path, settings } = store({});
    settings.save(withVault({ path: vaultDir, vaultId: 'kept' }), () => () => undefined);
    const reopened = new MarketSettingsStore({}, path);
    const vault = reopened.read().credentials.find((s) => s.id === 'research-vault');
    expect(vault?.configured).toBe(true);
    expect(reopened.runtimeEnv()[VAULT]).toBe(vaultDir);
    expect(reopened.runtimeEnv()[VAULT_ID]).toBe('kept');
  });
});

// task-33 补：四项高级配置（研究目录 / 受管目录 / 文本上限 / 附件上限）。
type ZodLike = {
  safeParse(input: unknown): { success: boolean };
};

describe('task-33 研究库高级配置', () => {
  let vaultDir: string;
  beforeEach(() => {
    vaultDir = mkdtempSync(join(tmpdir(), 'luoome-vault-'));
    roots.push(vaultDir);
  });
  const withVault = (researchVault: unknown) =>
    SaveMarketSettingsSchema.parse({
      sources: ['fuyao', 'tencent'],
      fuyao: { baseUrl: 'https://fuyao.example.test/', apiKey: 'k' },
      credentials: {},
      localPaths: { researchVault },
    });

  it('空库首次打开：四项回显默认值（Research / Research/Luoome / 10 / 100）', () => {
    const { settings } = store({});
    const vault = settings.read().credentials.find((s) => s.id === 'research-vault');
    if (vault?.kind !== 'local-path') throw new Error('missing local-path section');
    expect(vault.researchRoot).toBe('Research');
    expect(vault.managedRoot).toBe('Research/Luoome');
    expect(vault.maxTextMb).toBe(10);
    expect(vault.maxAttachmentMb).toBe(100);
  });

  it('保存四项后写入 .env 并回读一致', () => {
    const { path, settings } = store({});
    settings.save(
      withVault({
        path: vaultDir,
        researchRoot: 'Notes',
        managedRoot: 'Notes/Bot',
        maxTextMb: 25,
        maxAttachmentMb: 512,
      }),
      () => () => undefined,
    );
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('LUOOME_RESEARCH_ROOT="Notes"');
    expect(text).toContain('LUOOME_RESEARCH_MANAGED_ROOT="Notes/Bot"');
    expect(text).toContain('LUOOME_RESEARCH_MAX_TEXT_MB="25"');
    expect(text).toContain('LUOOME_RESEARCH_MAX_ATTACHMENT_MB="512"');
    const vault = settings.read().credentials.find((s) => s.id === 'research-vault');
    if (vault?.kind !== 'local-path') throw new Error('missing section');
    expect(vault.researchRoot).toBe('Notes');
    expect(vault.maxTextMb).toBe(25);
  });

  it('重启保留：四个键都在 SETTINGS_KEYS 里', () => {
    const { path, settings } = store({});
    settings.save(
      withVault({ path: vaultDir, researchRoot: 'Notes', maxTextMb: 25 }),
      () => () => undefined,
    );
    const reopened = new MarketSettingsStore({}, path);
    expect(reopened.runtimeEnv().LUOOME_RESEARCH_ROOT).toBe('Notes');
    expect(reopened.runtimeEnv().LUOOME_RESEARCH_MAX_TEXT_MB).toBe('25');
  });

  it('校验：目录拒空串与换行；上限拒 0 / 超界 / 非整数', () => {
    const { settings } = store({});
    const reject = (input: unknown, expected: RegExp | string) =>
      expect(() => settings.save(withVault(input), () => () => undefined)).toThrow(expected);
    // 目录字段：空串（注意空串在三态里表示「保留」，所以先填非空再传空串不适用）
    reject({ path: vaultDir, researchRoot: '   ' }, /研究目录不能为空/);
    reject({ path: vaultDir, researchRoot: 'a\nb' }, /研究目录必须是单行文本/);
    reject({ path: vaultDir, managedRoot: '   ' }, /受管目录不能为空/);
    // 上限字段
    // 上限字段：断言「抛错」+ 错误里带上界约束（zod 的措辞随版本变化，不锁具体文案）。
    reject({ path: vaultDir, maxTextMb: 0 }, /too_small|greater than or equal/);
    reject({ path: vaultDir, maxTextMb: 101 }, /too_big|less than or equal/);
    reject({ path: vaultDir, maxTextMb: 10.5 }, /invalid_type|int/i);
    reject({ path: vaultDir, maxAttachmentMb: 1_025 }, /too_big|less than or equal/);
  });

  it('对照：apps/web 的 SaveResearchVaultSettingsSchema 与本 schema 对同一组输入接受/拒绝一致', async () => {
    const { SaveResearchVaultSettingsSchema } = await import(
      '../../../../apps/web/src/research-vault-settings.js'
    ).then((module) => module as { SaveResearchVaultSettingsSchema: ZodLike });
    // 本插件侧：把同一组输入包进 `localPaths.researchVault`，看 SaveMarketSettingsSchema 是否接受。
    const pluginAccepts = (input: Record<string, unknown>): boolean =>
      SaveMarketSettingsSchema.safeParse({
        sources: ['fuyao', 'tencent'],
        fuyao: { baseUrl: 'https://fuyao.example.test/', apiKey: 'k' },
        credentials: {},
        localPaths: { researchVault: input },
      }).success;

    const cases: {
      researchRoot: string;
      managedRoot: string;
      maxTextMb: number;
      maxAttachmentMb: number;
    }[] = [
      {
        researchRoot: 'Research',
        managedRoot: 'Research/Luoome',
        maxTextMb: 10,
        maxAttachmentMb: 100,
      },
      { researchRoot: 'Notes', managedRoot: 'Notes/Bot', maxTextMb: 1, maxAttachmentMb: 1 },
      { researchRoot: 'A/B', managedRoot: 'A/B/C', maxTextMb: 100, maxAttachmentMb: 1_024 },
      { researchRoot: '   ', managedRoot: 'Research/Luoome', maxTextMb: 10, maxAttachmentMb: 100 },
      { researchRoot: 'a\nb', managedRoot: 'Research/Luoome', maxTextMb: 10, maxAttachmentMb: 100 },
      { researchRoot: 'Research', managedRoot: '  ', maxTextMb: 10, maxAttachmentMb: 100 },
      {
        researchRoot: 'Research',
        managedRoot: 'Research/Luoome',
        maxTextMb: 0,
        maxAttachmentMb: 100,
      },
      {
        researchRoot: 'Research',
        managedRoot: 'Research/Luoome',
        maxTextMb: 101,
        maxAttachmentMb: 100,
      },
      {
        researchRoot: 'Research',
        managedRoot: 'Research/Luoome',
        maxTextMb: 10,
        maxAttachmentMb: 0,
      },
      {
        researchRoot: 'Research',
        managedRoot: 'Research/Luoome',
        maxTextMb: 10,
        maxAttachmentMb: 1_025,
      },
    ];
    for (const item of cases) {
      const webAccepts = SaveResearchVaultSettingsSchema.safeParse({
        vaultPath: vaultDir,
        researchRoot: item.researchRoot,
        managedRoot: item.managedRoot,
        vaultId: '',
        maxTextMb: item.maxTextMb,
        maxAttachmentMb: item.maxAttachmentMb,
      }).success;
      expect(pluginAccepts({ path: vaultDir, ...item }), JSON.stringify(item)).toBe(webAccepts);
    }
  });
});
