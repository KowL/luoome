import type { Logger } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { createMarketAdapterFromEnv } from './factory.js';

const silentLogger = (): Logger => {
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
};

describe('market/factory', () => {
  it('env 缺省 → 启动期报配置错误', () => {
    expect(() => createMarketAdapterFromEnv({}, { logger: silentLogger() })).toThrow(
      /MARKET_PROVIDER/,
    );
  });

  it('"mock" → 启动期报配置错误', () => {
    expect(() =>
      createMarketAdapterFromEnv({ LUOOME_MARKET_PROVIDER: 'mock' }, { logger: silentLogger() }),
    ).toThrow(/real/);
  });

  it('real → MarketDataManager', () => {
    const adapter = createMarketAdapterFromEnv(
      { LUOOME_MARKET_PROVIDER: 'real' },
      { logger: silentLogger() },
    );
    expect(adapter.name).toBe('manager');
  });

  it('非法 provider → 启动期抛错', () => {
    expect(() =>
      createMarketAdapterFromEnv(
        { LUOOME_MARKET_PROVIDER: 'eastmoney' },
        { logger: silentLogger() },
      ),
    ).toThrow(/非法/);
  });

  it('real：Eastmoney 形状响应 → quote.source=eastmoney', async () => {
    const adapter = createMarketAdapterFromEnv(
      { LUOOME_MARKET_PROVIDER: 'real' },
      {
        logger: silentLogger(),
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              rc: 0,
              data: { f43: 100.5, f44: 101, f45: 99.5, f46: 100, f47: 12345, f60: 99.8 },
            }),
            { status: 200 },
          )) as never,
      },
    );
    const q = await adapter.fetchQuote('002594.SZ');
    expect(q.source).toBe('eastmoney');
    expect(q.close).toBe(100.5);
    expect(q.volume).toBe(1_234_500); // 手 → 股
  });

  it('real：primary 失败 → 落到 Tencent fallback', async () => {
    const urls: string[] = [];
    const adapter = createMarketAdapterFromEnv(
      { LUOOME_MARKET_PROVIDER: 'real' },
      {
        logger: silentLogger(),
        fetchImpl: ((url: string) => {
          urls.push(String(url));
          // Eastmoney（push2）一律失败；Tencent（ifzq）返回 minute 形状
          if (String(url).includes('push2')) {
            return Promise.resolve(new Response('boom', { status: 500 }));
          }
          return Promise.resolve(
            new Response(JSON.stringify({ data: { data: { now: 380, open: 375 } } }), {
              status: 200,
            }),
          );
        }) as never,
      },
    );
    const q = await adapter.fetchQuote('00700.HK');
    expect(q.source).toBe('tencent');
    expect(urls.some((u) => u.includes('push2'))).toBe(true);
    expect(urls.some((u) => u.includes('ifzq'))).toBe(true);
  });

  it('real：全源失败 → 明确抛错，不生成行情', async () => {
    const adapter = createMarketAdapterFromEnv(
      { LUOOME_MARKET_PROVIDER: 'real' },
      {
        logger: silentLogger(),
        fetchImpl: (async () => new Response('down', { status: 500 })) as never,
      },
    );
    await expect(adapter.fetchQuote('002594.SZ')).rejects.toThrow(/all market sources failed/i);
  });
});
