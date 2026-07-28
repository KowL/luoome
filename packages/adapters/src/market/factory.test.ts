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
    expect(
      adapter.marketSourceStatus().map(({ dataset, source }) => `${source}:${dataset}`),
    ).toEqual([
      'eastmoney:quote',
      'eastmoney:daily-bars',
      'eastmoney:search',
      'eastmoney:market-snapshot',
      'eastmoney:realtime-index',
      'tencent:quote',
      'tencent:daily-bars',
      'tencent:search',
    ]);
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
            new Response(
              JSON.stringify({
                code: 0,
                data: {
                  hk00700: { data: { data: ['0930 375 100 37500.00', '1530 380 120 45600.00'] } },
                },
              }),
              { status: 200 },
            ),
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

  it('LUOOME_MARKET_SOURCES 含 tushare + TUSHARE_TOKEN：主备失败 → finalFallback 返回 source=tushare', async () => {
    const adapter = createMarketAdapterFromEnv(
      {
        LUOOME_MARKET_PROVIDER: 'real',
        LUOOME_MARKET_SOURCES: 'eastmoney,tencent,tushare',
        TUSHARE_TOKEN: 'test-token',
      },
      {
        logger: silentLogger(),
        fetchImpl: ((url: string) => {
          if (String(url).includes('api.tushare.pro')) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  code: 0,
                  msg: '',
                  data: {
                    fields: ['ts_code', 'trade_time', 'open', 'high', 'low', 'price', 'vol'],
                    items: [['002594.SZ', '2026-07-24T07:00:00.000Z', 248, 251, 247, 250, 999]],
                  },
                }),
                { status: 200 },
              ),
            );
          }
          return Promise.resolve(new Response('down', { status: 500 }));
        }) as never,
      },
    );
    const q = await adapter.fetchQuote('002594.SZ');
    expect(q.source).toBe('tushare');
    expect(q.close).toBe(250);
  });

  it('LUOOME_MARKET_SOURCES 含 tushare 但 TUSHARE_TOKEN 缺失 → 启动期报错', () => {
    expect(() =>
      createMarketAdapterFromEnv(
        { LUOOME_MARKET_PROVIDER: 'real', LUOOME_MARKET_SOURCES: 'tushare' },
        { logger: silentLogger() },
      ),
    ).toThrow(/TUSHARE_TOKEN/);
  });

  it('LUOOME_MARKET_SOURCES 含 tushare 且 TUSHARE_TOKEN 已配置 → 装配成功', () => {
    const adapter = createMarketAdapterFromEnv(
      {
        LUOOME_MARKET_PROVIDER: 'real',
        LUOOME_MARKET_SOURCES: 'tushare',
        TUSHARE_TOKEN: 'test-token',
      },
      { logger: silentLogger() },
    );
    expect(adapter.name).toBe('manager');
  });

  it('LUOOME_MARKET_SOURCES 控制开关与优先级', async () => {
    const calls: string[] = [];
    const adapter = createMarketAdapterFromEnv(
      {
        LUOOME_MARKET_PROVIDER: 'real',
        LUOOME_MARKET_SOURCES: 'tencent,eastmoney',
      },
      {
        logger: silentLogger(),
        fetchImpl: (async (input: string | URL | Request) => {
          const url = String(input);
          calls.push(url);
          if (url.includes('web.ifzq.gtimg.cn')) {
            return new Response(
              JSON.stringify({ code: 0, data: { sz002594: { data: { data: ['0930 250 10'] } } } }),
              { status: 200 },
            );
          }
          return new Response('unexpected', { status: 500 });
        }) as typeof fetch,
      },
    );
    const quote = await adapter.fetchQuote('002594.SZ');
    expect(quote.source).toBe('tencent');
    expect(calls).toHaveLength(1);
  });

  it('activeOrder 仅 tushare：realtime index 明确不支持，且不会隐式调用 Eastmoney', async () => {
    const urls: string[] = [];
    const adapter = createMarketAdapterFromEnv(
      {
        LUOOME_MARKET_PROVIDER: 'real',
        LUOOME_MARKET_SOURCES: 'tushare',
        TUSHARE_TOKEN: 'test-token',
      },
      {
        logger: silentLogger(),
        fetchImpl: ((url: string) => {
          urls.push(String(url));
          return Promise.resolve(new Response('unexpected request', { status: 500 }));
        }) as never,
      },
    );
    await expect(adapter.fetchIndexQuotes()).rejects.toThrow(/unsupported_capability/);
    expect(
      adapter.marketSourceStatus().map(({ dataset, source }) => `${source}:${dataset}`),
    ).toEqual(['tushare:quote', 'tushare:daily-bars', 'tushare:search', 'tushare:delayed-index']);
    expect(urls).toEqual([]);
  });

  it('activeOrder 含 eastmoney：realtime index 能力来自显式启用源', async () => {
    const adapter = createMarketAdapterFromEnv(
      {
        LUOOME_MARKET_PROVIDER: 'real',
        LUOOME_MARKET_SOURCES: 'eastmoney,tushare',
        TUSHARE_TOKEN: 'test-token',
      },
      {
        logger: silentLogger(),
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              rc: 0,
              data: { f43: 3500.5, f57: '000001', f58: '上证指数', f169: 12.3, f170: 0.35 },
            }),
            { status: 200 },
          )) as never,
      },
    );
    const indices = await adapter.fetchIndexQuotes();
    expect(indices[0]?.source).toBe('eastmoney');
  });
});
