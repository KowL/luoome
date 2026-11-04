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
    const sections = settings.read().credentials;
    // task-32：`credentials` 现在也容纳**非行情源**通道（飞书通知），
    // 所以按 `kind` 取行情源那一支再对账——判据更严：不仅「有这一格」，
    // 还要求它确实被标成 `market-source`（而不是混进通知通道里）。
    const ids = sections.filter((item) => item.kind === 'market-source').map((item) => item.id);
    const expected = (
      Object.keys(MARKET_SOURCE_MANIFEST) as (keyof typeof MARKET_SOURCE_MANIFEST)[]
    )
      .filter((id) => MARKET_SOURCE_MANIFEST[id].requiredEnv !== undefined)
      .sort();
    expect([...ids].sort()).toEqual(expected);
    // 非行情源条目**不得**被标成 market-source，且不得出现在 manifest 派生的 id 里。
    for (const section of sections.filter((item) => item.kind === 'notification-channel'))
      expect(expected).not.toContain(section.id as never);
  });

  it('配置 Fuyao 凭据后切到它，请求打到 Fuyao 端点并解析出收盘价', async () => {
    const { settings, path } = store({ LUOOME_MARKET_PROVIDER: 'real' });
    settings.save(
      SaveMarketSettingsSchema.parse({
        sources: ['fuyao'],
        fuyao: { apiKey: 'synthetic-fuyao-key' },
        credentials: {},
      }),
      () => () => {},
    );
    expect(readFileSync(path, 'utf8')).toContain('FUYAO_API_KEY="synthetic-fuyao-key"');
    expect(JSON.stringify(settings.read())).not.toContain('synthetic-fuyao-key');
    expect(settings.read().credentials.find((item) => item.id === 'fuyao')?.configured).toBe(true);

    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      return Response.json({
        code: 0,
        message: 'success',
        request_id: 'settings-provider-test',
        data: {
          timestamp: null,
          item: [
            {
              thscode: '600519.SH',
              ticker: '600519',
              last_price: 1234.5,
              open_price: 1200,
              high_price: 1210,
              low_price: 1190,
              prev_price: 1200,
              volume: 1000,
              turnover: 1_234_500,
            },
          ],
        },
      });
    }) as unknown as typeof fetch;

    const adapter = createMarketAdapterFromEnv(settings.runtimeEnv(), {
      logger: silent,
      fetchImpl,
      clock: () => new Date('2026-10-31T02:00:00.000Z'),
    });
    const quote = await adapter.fetchQuote('600519.SH');
    expect(quote.source).toBe('fuyao');
    expect(Number(quote.close)).toBeCloseTo(1234.5, 4);
    expect(calls.length).toBeGreaterThan(0);
    for (const url of calls) expect(url).toContain('fuyao.aicubes.cn');
  });

  it('未配置凭据就启用该源时失败并点名缺哪个环境变量', () => {
    const { settings } = store({});
    expect(() =>
      settings.save(
        SaveMarketSettingsSchema.parse({
          sources: ['fuyao'],
          fuyao: { clear: false },
          credentials: {},
        }),
        () => () => {},
      ),
    ).toThrow(/FUYAO_API_KEY/);
  });
});
