import type { Logger } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { EastmoneySource } from '../eastmoney/source.js';
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
      'eastmoney:batch-quote',
      'eastmoney:market-snapshot',
      'eastmoney:market-snapshot-envelope',
      'eastmoney:intraday-minutes',
      'eastmoney:realtime-index',
      'tencent:quote',
      'tencent:daily-bars',
      'tencent:search',
      'tencent:batch-quote',
      'tencent:market-snapshot',
      'tencent:market-snapshot-envelope',
      'tencent:intraday-minutes',
      'sina:daily-bars',
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

  it('注入共享 EastmoneySource 时 eastmoney 分支复用该实例，不再用 deps.fetchImpl 自构', async () => {
    const quoteBody = JSON.stringify({
      rc: 0,
      data: { f43: 100.5, f44: 101, f45: 99.5, f46: 100, f47: 12345, f60: 99.8 },
    });
    const injectedCalls: string[] = [];
    const injected = new EastmoneySource({
      fetchImpl: ((url: string | URL | Request) => {
        injectedCalls.push(String(url));
        return Promise.resolve(new Response(quoteBody, { status: 200 }));
      }) as unknown as typeof fetch,
    });
    const selfConstructFetch = (async () => {
      throw new Error('must not self-construct eastmoney');
    }) as unknown as typeof fetch;

    const adapter = createMarketAdapterFromEnv(
      { LUOOME_MARKET_PROVIDER: 'real', LUOOME_MARKET_SOURCES: 'eastmoney' },
      { logger: silentLogger(), fetchImpl: selfConstructFetch, sources: { eastmoney: injected } },
    );
    const q = await adapter.fetchQuote('002594.SZ');

    expect(q.source).toBe('eastmoney');
    expect(q.close).toBe(100.5);
    expect(injectedCalls.some((url) => url.includes('push2.eastmoney.com'))).toBe(true);
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
    // tencent 分钟快照 + qt 昨收补取各一次；全程不触达 eastmoney
    expect(calls.filter((u) => u.includes('web.ifzq.gtimg.cn'))).toHaveLength(1);
    expect(calls.some((u) => u.includes('eastmoney'))).toBe(false);
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
    ).toEqual([
      'tushare:quote',
      'tushare:daily-bars',
      'tushare:search',
      'tushare:minute-bars',
      'tushare:delayed-index',
    ]);
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

  it('intraday-minutes 由 eastmoney / tencent 注册并按来源顺序路由', async () => {
    const tencentOnly = createMarketAdapterFromEnv(
      { LUOOME_MARKET_PROVIDER: 'real', LUOOME_MARKET_SOURCES: 'tencent' },
      {
        logger: silentLogger(),
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              code: 0,
              data: {
                sz002594: { data: { date: '20260811', data: ['0930 91.18 1189 10841302.00'] } },
              },
            }),
            { status: 200 },
          )) as never,
      },
    );
    const points = await tencentOnly.fetchIntradayMinutes('002594.SZ');
    expect(points[0]?.source).toBe('tencent');
    expect(
      tencentOnly
        .marketSourceStatus()
        .some((s) => s.dataset === 'intraday-minutes' && s.source === 'tencent'),
    ).toBe(true);

    const eastmoneyOnly = createMarketAdapterFromEnv(
      { LUOOME_MARKET_PROVIDER: 'real', LUOOME_MARKET_SOURCES: 'eastmoney' },
      {
        logger: silentLogger(),
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              rc: 0,
              data: {
                trends: ['2026-08-31 09:30,3926.53,3926.53,3926.53,3926.53,100,1000.00,3926.53'],
              },
            }),
            { status: 200 },
          )) as never,
      },
    );
    const eastmoneyPoints = await eastmoneyOnly.fetchIntradayMinutes('000001.SH');
    expect(eastmoneyPoints[0]?.source).toBe('eastmoney');
    expect(
      eastmoneyOnly
        .marketSourceStatus()
        .some((s) => s.dataset === 'intraday-minutes' && s.source === 'eastmoney'),
    ).toBe(true);
  });

  it('minute-bars 只在显式启用 Tushare 时注册；映射 rt_min', async () => {
    const adapter = createMarketAdapterFromEnv(
      {
        LUOOME_MARKET_PROVIDER: 'real',
        LUOOME_MARKET_SOURCES: 'tushare',
        TUSHARE_TOKEN: 'test-token',
      },
      {
        logger: silentLogger(),
        clock: () => new Date('2026-08-14T02:00:00.000Z'),
        fetchImpl: (async (_url: string, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as { api_name: string };
          if (body.api_name !== 'rt_min') {
            return new Response('unexpected api', { status: 500 });
          }
          return new Response(
            JSON.stringify({
              code: 0,
              msg: '',
              data: {
                fields: [
                  'ts_code',
                  'trade_time',
                  'freq',
                  'open',
                  'close',
                  'high',
                  'low',
                  'vol',
                  'amount',
                ],
                items: [
                  ['002594.SZ', '2026-08-14 09:31:00', '1MIN', 90, 90.5, 91, 89, 10000, 905000],
                ],
              },
            }),
            { status: 200 },
          );
        }) as never,
      },
    );
    const bars = await adapter.fetchMinuteBars('002594.SZ', '1m');
    expect(bars[0]).toMatchObject({ source: 'tushare', interval: '1m', adjustment: 'raw' });
    expect(
      adapter
        .marketSourceStatus()
        .some((status) => status.dataset === 'minute-bars' && status.source === 'tushare'),
    ).toBe(true);
  });

  it('LUOOME_MARKET_SOURCES 含 fuyao 但 FUYAO_API_KEY 缺失 → 启动期报错', () => {
    expect(() =>
      createMarketAdapterFromEnv(
        { LUOOME_MARKET_PROVIDER: 'real', LUOOME_MARKET_SOURCES: 'fuyao' },
        { logger: silentLogger() },
      ),
    ).toThrow(/FUYAO_API_KEY/);
  });

  it('LUOOME_MARKET_SOURCES=fuyao + FUYAO_API_KEY：quote 路由到 fuyao，绑定集合正确', async () => {
    const adapter = createMarketAdapterFromEnv(
      {
        LUOOME_MARKET_PROVIDER: 'real',
        LUOOME_MARKET_SOURCES: 'fuyao',
        FUYAO_API_KEY: 'test-fuyao-key',
      },
      {
        logger: silentLogger(),
        fetchImpl: (async (url: string) => {
          expect(String(url)).toContain('fuyao.aicubes.cn/api/a-share/prices/snapshot');
          return new Response(
            JSON.stringify({
              code: 0,
              message: 'success',
              request_id: 'r1',
              data: {
                timestamp: Date.now() - 60_000,
                item: [
                  {
                    thscode: '002594.SZ',
                    ticker: '002594',
                    last_price: 250,
                    price_change: 2,
                    price_change_ratio_pct: 0.81,
                    open_price: 248,
                    high_price: 251,
                    low_price: 247,
                    prev_price: 248,
                    volume: 999,
                    turnover: 249750,
                  },
                ],
              },
            }),
            { status: 200 },
          );
        }) as never,
      },
    );
    const q = await adapter.fetchQuote('002594.SZ');
    expect(q.source).toBe('fuyao');
    expect(q.close).toBe(250);
    expect(
      adapter.marketSourceStatus().map(({ dataset, source }) => `${source}:${dataset}`),
    ).toEqual([
      'fuyao:quote',
      'fuyao:daily-bars',
      'fuyao:search',
      'fuyao:batch-quote',
      'fuyao:market-snapshot',
      'fuyao:market-snapshot-envelope',
      'fuyao:delayed-index',
    ]);
  });

  it('eastmoney 失败 → 降级到 fuyao fallback', async () => {
    const adapter = createMarketAdapterFromEnv(
      {
        LUOOME_MARKET_PROVIDER: 'real',
        LUOOME_MARKET_SOURCES: 'eastmoney,fuyao',
        FUYAO_API_KEY: 'test-fuyao-key',
      },
      {
        logger: silentLogger(),
        fetchImpl: (async (url: string) => {
          if (String(url).includes('fuyao.aicubes.cn')) {
            return new Response(
              JSON.stringify({
                code: 0,
                message: 'success',
                request_id: 'r1',
                data: {
                  timestamp: Date.now() - 60_000,
                  item: [
                    {
                      thscode: '002594.SZ',
                      ticker: '002594',
                      last_price: 250,
                      open_price: 248,
                      high_price: 251,
                      low_price: 247,
                      prev_price: 248,
                      volume: 999,
                      turnover: 249750,
                    },
                  ],
                },
              }),
              { status: 200 },
            );
          }
          return new Response('down', { status: 500 });
        }) as never,
      },
    );
    const q = await adapter.fetchQuote('002594.SZ');
    expect(q.source).toBe('fuyao');
    expect(q.close).toBe(250);
  });

  it('activeOrder 仅 fuyao：realtime index 明确不支持，minute/intraday 不注册', async () => {
    const urls: string[] = [];
    const adapter = createMarketAdapterFromEnv(
      {
        LUOOME_MARKET_PROVIDER: 'real',
        LUOOME_MARKET_SOURCES: 'fuyao',
        FUYAO_API_KEY: 'test-fuyao-key',
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
    await expect(adapter.fetchMinuteBars('002594.SZ', '1m')).rejects.toThrow(
      /unsupported_capability/,
    );
    await expect(adapter.fetchIntradayMinutes('002594.SZ')).rejects.toThrow(
      /unsupported_capability/,
    );
    expect(urls).toEqual([]);
  });
});
