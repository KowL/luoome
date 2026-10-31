// REQ-M3-15：新增一家源 → 设置页多一格 → 切到它 → 请求命中该源的端点（**注入 fetchImpl，不联网**）。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMarketAdapterFromEnv, MARKET_SOURCE_MANIFEST } from '@luoome/adapters';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MarketSettingsStore, SaveMarketSettingsSchema } from './market-settings.js';

const roots: string[] = [];
const store = (env: Record<string, string> = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'luoome-provider-settings-'));
  roots.push(root);
  const path = join(root, '.env');
  return { path, settings: new MarketSettingsStore(env, path) };
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe('REQ-M3-15 新增供应商凭据', () => {
  it('manifest 里每个需要凭据的源都在设置页有一格（分区从 requiredEnv 派生）', () => {
    const { settings } = store();
    const ids = settings.read().credentials.map((item) => item.id);
    const expected = (
      Object.keys(MARKET_SOURCE_MANIFEST) as (keyof typeof MARKET_SOURCE_MANIFEST)[]
    )
      .filter((id) => MARKET_SOURCE_MANIFEST[id].requiredEnv !== undefined)
      .sort();
    expect([...ids].sort()).toEqual(expected);
  });

  it('配置 Tushare 凭据后切到它，请求打到 tushare 端点并解析出收盘价', async () => {
    const { settings, path } = store({ LUOOME_MARKET_PROVIDER: 'real' });
    settings.save(
      SaveMarketSettingsSchema.parse({
        sources: ['tushare'],
        fuyao: { clear: false },
        credentials: { tushare: { apiKey: 'synthetic-tushare-token' } },
      }),
      () => () => {},
    );
    // 凭据确实落到 0600 的 .env，且视图仍不回显。
    expect(readFileSync(path, 'utf8')).toContain('TUSHARE_TOKEN="synthetic-tushare-token"');
    expect(JSON.stringify(settings.read())).not.toContain('synthetic-tushare-token');
    expect(settings.read().credentials.find((item) => item.id === 'tushare')?.configured).toBe(
      true,
    );

    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      return new Response(
        JSON.stringify({
          code: 0,
          msg: '',
          data: {
            // rt_k 快照行：price 即最新价，vol 已是股（见 adapters/src/market/tushare.ts:49-58）。
            fields: ['ts_code', 'trade_time', 'open', 'high', 'low', 'price', 'vol'],
            items: [['600519.SH', '2026-10-31T10:00:00+08:00', 1200, 1210, 1190, 1234.5, 1000]],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const adapter = createMarketAdapterFromEnv(settings.runtimeEnv(), {
      logger: silent,
      fetchImpl,
      clock: () => new Date('2026-10-31T02:00:00.000Z'),
    });
    const quote = await adapter.fetchQuote('600519.SH');
    expect(quote.source).toBe('tushare');
    expect(Number(quote.close)).toBeCloseTo(1234.5, 4);
    // 请求确实打到了新源的端点（链路级验收：验端点与参数，不验上游）。
    expect(calls.length).toBeGreaterThan(0);
    for (const url of calls) expect(url).toContain('tushare.pro');
  });

  it('未配置凭据就启用该源时失败并点名缺哪个环境变量', () => {
    const { settings } = store({});
    expect(() =>
      settings.save(
        SaveMarketSettingsSchema.parse({
          sources: ['tushare'],
          fuyao: { clear: false },
          credentials: {},
        }),
        () => () => {},
      ),
    ).toThrow(/TUSHARE_TOKEN/);
  });
});
