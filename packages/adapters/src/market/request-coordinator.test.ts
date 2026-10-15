import { money, type PublicMarketStore, type Quote } from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';
import { EastmoneySource } from '../eastmoney/source.js';
import { SourceExecutionError } from '../source-error.js';
import { createMarketAdapterFromEnv } from './factory.js';
import { MarketRequestCoordinator, marketRequestConfigFromEnv } from './request-coordinator.js';
import { MarketSourceRegistry } from './source-registry.js';

const store = (): PublicMarketStore => {
  const entries = new Map<string, string>();
  return {
    read: (key) => entries.get(key) ?? null,
    update: (key, _now, _until, change) => {
      const next = change(entries.get(key) ?? null);
      entries.set(key, next.value);
      return next.result;
    },
  };
};
const config = marketRequestConfigFromEnv({});
const T0 = Date.parse('2026-10-15T02:00:00Z');
const quote = (stockId: string): Quote => ({
  stockId,
  source: 'eastmoney',
  observedAt: new Date(T0),
  fetchedAt: new Date(T0),
  ts: new Date(T0),
  timestampSource: 'upstream',
  open: money(10),
  high: money(11),
  low: money(9),
  close: money(10),
  volume: 100,
});
const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const logger = { debug() {}, info() {}, warn() {}, error() {} };

describe('public market request coordinator', () => {
  it('validates conservative environment configuration', () => {
    expect(config).toEqual({
      requestsPerWindow: 30,
      windowMs: 60_000,
      cooldownMs: 60_000,
      cacheTtlMs: 10_000,
      leaseMs: 30_000,
    });
    for (const key of [
      'LUOOME_MARKET_REQUESTS_PER_WINDOW',
      'LUOOME_MARKET_REQUEST_WINDOW_MS',
      'LUOOME_MARKET_FAILURE_COOLDOWN_MS',
      'LUOOME_MARKET_CACHE_TTL_MS',
      'LUOOME_MARKET_REQUEST_LEASE_MS',
    ]) {
      for (const value of ['0', '-1', 'NaN', '1.5', ''])
        expect(() => marketRequestConfigFromEnv({ [key]: value })).toThrow();
    }
  });

  it('merges overlapping Web/worker batches and single quotes without changing source observations on cache hits', async () => {
    const shared = store();
    const web = new MarketRequestCoordinator(shared, config, () => T0);
    const worker = new MarketRequestCoordinator(shared, config, () => T0);
    const gate = deferred();
    const batch = vi.fn(async ({ stockIds }: { stockIds: readonly string[] }) => {
      await gate.promise;
      return stockIds.map(quote);
    });
    const single = vi.fn(async ({ stockId }: { stockId: string }) => quote(stockId));
    const bindings = [
      {
        source: 'eastmoney',
        capability: 'batch-quote' as const,
        coverage: [],
        configurationReady: true,
        execute: batch,
        observationOf: () => ({ outcome: 'success' as const, dataAsOf: new Date(T0) }),
      },
      {
        source: 'eastmoney',
        capability: 'quote' as const,
        coverage: [],
        configurationReady: true,
        execute: single,
        observationOf: () => ({ outcome: 'success' as const, dataAsOf: new Date(T0) }),
      },
    ];
    const a = new MarketSourceRegistry(bindings, () => new Date(T0), web);
    const b = new MarketSourceRegistry(bindings, () => new Date(T0), worker);
    const first = a.sources('batch-quote')[0]?.execute({ stockIds: ['A', 'B'] });
    const second = b.sources('batch-quote')[0]?.execute({ stockIds: ['B', 'C'] });
    const third = b.sources('quote')[0]?.execute({ stockId: 'A' });
    gate.resolve();
    const [one, two, three] = await Promise.all([first, second, third]);
    expect(batch.mock.calls.map(([input]) => input.stockIds)).toEqual([['A', 'B'], ['C']]);
    expect(single).not.toHaveBeenCalled();
    expect(one?.map((item) => item.stockId).sort()).toEqual(['A', 'B']);
    expect(two?.map((item) => item.stockId).sort()).toEqual(['B', 'C']);
    expect(three?.observedAt).toEqual(new Date(T0));
    const before = b.describe();
    const cached = await b.sources('quote')[0]?.execute({ stockId: 'A' });
    expect(b.describe()).toEqual(before);
    expect(b.describe().find((item) => item.dataset === 'quote')?.lastSuccessAt).toBeUndefined();
    if (cached) cached.observedAt.setFullYear(2000);
    expect((await b.sources('quote')[0]?.execute({ stockId: 'A' }))?.observedAt.getTime()).toBe(T0);
  });

  it('shares a sliding HTTP quota across capabilities, coordinator instances and factory rebuilds', async () => {
    let now = T0;
    const shared = store();
    const cfg = { ...config, requestsPerWindow: 3, windowMs: 1000 };
    const a = new MarketRequestCoordinator(shared, cfg, () => now);
    const b = new MarketRequestCoordinator(shared, cfg, () => now);
    const http = vi.fn(async () => new Response('{}')) as unknown as typeof fetch;
    const mixed = await Promise.allSettled(
      Array.from({ length: 100 }, (_, i) =>
        (i % 2 ? a : b).fetchFor('eastmoney', http)(`https://example.invalid/${i}`),
      ),
    );
    expect(mixed.filter((item) => item.status === 'fulfilled')).toHaveLength(3);
    expect(http).toHaveBeenCalledTimes(3);
    now += 999;
    await expect(a.fetchFor('eastmoney', http)('https://example.invalid')).rejects.toMatchObject({
      kind: 'rate_limited',
    });
    now += 1;
    const rebuilt = new MarketRequestCoordinator(shared, cfg, () => now);
    await rebuilt.fetchFor('eastmoney', http)('https://example.invalid');
    await rebuilt.fetchFor('tencent', http)('https://example.invalid');
    expect(http).toHaveBeenCalledTimes(5);
  });

  it('counts every page inside one capability and stops before exceeding the provider quota', async () => {
    const c = new MarketRequestCoordinator(store(), { ...config, requestsPerWindow: 2 }, () => T0);
    const raw = vi.fn(async () => new Response('{}')) as unknown as typeof fetch;
    const http = c.fetchFor('eastmoney', raw);
    const execute = vi.fn(async () => {
      for (let page = 0; page < 3; page += 1)
        await http(`https://push2.eastmoney.com/page/${page}`);
      return [];
    });
    await expect(
      c.execute(
        { source: 'eastmoney', capability: 'search', coverage: [], execute },
        { query: 'A' },
      ),
    ).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it('charges Sina directory requests inside a Tencent capability to the shared Sina quota', async () => {
    const c = new MarketRequestCoordinator(store(), { ...config, requestsPerWindow: 1 }, () => T0);
    const raw = vi.fn(async () => new Response('{}')) as unknown as typeof fetch;
    await c.fetchFor('tencent', raw)('https://vip.stock.finance.sina.com.cn/directory');
    await expect(c.fetchFor('sina', raw)('https://hq.sinajs.cn/quote')).rejects.toMatchObject({
      kind: 'rate_limited',
    });
    await c.fetchFor('tencent', raw)('https://qt.gtimg.cn/quote');
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it.each(['429', 'network'] as const)(
    'cools down every stock after %s, including Eastmoney host fallback',
    async (failure) => {
      let now = T0;
      const shared = store();
      const coordinator = new MarketRequestCoordinator(shared, config, () => now);
      const http = vi.fn(async () => {
        if (failure === 'network') throw new TypeError('offline');
        return new Response('', { status: 429, headers: { 'retry-after': '120' } });
      }) as unknown as typeof fetch;
      const source = new EastmoneySource({ fetchImpl: coordinator.fetchFor('eastmoney', http) });
      const options = {
        logger,
        requestCoordinator: coordinator,
        sources: { eastmoney: source },
        sourceOrder: ['eastmoney'] as const,
      };
      const a = createMarketAdapterFromEnv({ LUOOME_MARKET_PROVIDER: 'real' }, options);
      expect((await a.batchQuote(['002594.SZ', '600519.SH'])).size).toBe(0);
      const rebuilt = createMarketAdapterFromEnv({ LUOOME_MARKET_PROVIDER: 'real' }, options);
      expect((await rebuilt.batchQuote(['688981.SH', '600000.SH'])).size).toBe(0);
      expect(http).toHaveBeenCalledTimes(1);
      const observation = a.marketSourceStatus().find((item) => item.dataset === 'batch-quote');
      expect(observation?.lastErrorKind).toBe(failure === '429' ? 'rate_limited' : 'network');
      expect(observation?.lastSuccessAt).toBeUndefined();
      now += 60_001;
      if (failure === '429') {
        await expect(
          coordinator.fetchFor('eastmoney', http)('https://example.invalid'),
        ).rejects.toMatchObject({ kind: 'rate_limited' });
        expect(http).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('retains previous successful source evidence on failure and never returns expired shared cache as fresh', async () => {
    let now = T0;
    const coordinator = new MarketRequestCoordinator(store(), config, () => now);
    let fail = false;
    const execute = vi.fn(async () => {
      if (fail) throw new SourceExecutionError('network', 'offline');
      return quote('A');
    });
    const registry = new MarketSourceRegistry(
      [
        {
          capability: 'quote',
          source: 'eastmoney',
          coverage: [],
          configurationReady: true,
          execute,
          observationOf: (result) => ({ outcome: 'success', dataAsOf: result.observedAt }),
        },
      ],
      () => new Date(now),
      coordinator,
    );
    const handle = registry.sources('quote')[0];
    await handle?.execute({ stockId: 'A' });
    now += config.cacheTtlMs + 1;
    fail = true;
    await expect(handle?.execute({ stockId: 'A' })).rejects.toMatchObject({ kind: 'network' });
    expect(registry.describe()[0]).toMatchObject({
      lastSuccessAt: new Date(T0),
      dataAsOf: new Date(T0),
      lastErrorKind: 'network',
    });
    await expect(handle?.execute({ stockId: 'A' })).rejects.toMatchObject({ kind: 'network' });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each(['tencent', 'sina'] as const)(
    'preserves structured rate limiting and recovery through the %s transport',
    async (source) => {
      let now = T0;
      const coordinator = new MarketRequestCoordinator(store(), config, () => now);
      const raw = vi.fn(async () => new Response('', { status: 429 })) as unknown as typeof fetch;
      const market = createMarketAdapterFromEnv(
        { LUOOME_MARKET_PROVIDER: 'real' },
        { logger, requestCoordinator: coordinator, fetchImpl: raw, sourceOrder: [source] },
      );
      expect((await market.batchQuote(['002594.SZ'])).size).toBe(0);
      expect(
        market.marketSourceStatus().find((item) => item.dataset === 'batch-quote')?.lastErrorKind,
      ).toBe('rate_limited');
      now += config.cooldownMs - 1;
      expect((await market.batchQuote(['600519.SH'])).size).toBe(0);
      expect(raw).toHaveBeenCalledTimes(1);
      now += 1;
      expect((await market.batchQuote(['600519.SH'])).size).toBe(0);
      expect(raw).toHaveBeenCalledTimes(2);
    },
  );

  it('does not extend cooldown on suppressed requests and resumes after the original deadline', async () => {
    let now = T0;
    const c = new MarketRequestCoordinator(store(), config, () => now);
    let offline = true;
    const raw = vi.fn(async () => {
      if (offline) throw new TypeError('offline');
      return new Response('{}');
    }) as unknown as typeof fetch;
    const http = c.fetchFor('eastmoney', raw);
    const handle = {
      source: 'eastmoney',
      capability: 'quote' as const,
      coverage: [],
      execute: async ({ stockId }: { stockId: string }) => {
        await http('https://example.invalid');
        return quote(stockId);
      },
    };
    await expect(c.execute(handle, { stockId: 'A' })).rejects.toMatchObject({ kind: 'network' });
    now += config.cooldownMs - 1;
    await expect(c.execute(handle, { stockId: 'B' })).rejects.toMatchObject({ kind: 'network' });
    offline = false;
    now += 1;
    expect((await c.execute(handle, { stockId: 'B' })).stockId).toBe('B');
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it('allows a bounded single-stock fallback after a missing native batch row', async () => {
    const c = new MarketRequestCoordinator(store(), config, () => T0);
    expect(
      await c.execute(
        { source: 'eastmoney', capability: 'batch-quote', coverage: [], execute: async () => [] },
        { stockIds: ['A'] },
      ),
    ).toEqual([]);
    const single = vi.fn(async () => quote('A'));
    expect(
      (
        await c.execute(
          { source: 'eastmoney', capability: 'quote', coverage: [], execute: single },
          { stockId: 'A' },
        )
      ).stockId,
    ).toBe('A');
    expect(single).toHaveBeenCalledTimes(1);
  });

  it('fences a late owner after expired-lease takeover without overwriting the successor cache', async () => {
    let now = T0;
    const c = new MarketRequestCoordinator(store(), config, () => now);
    const gate = deferred();
    let calls = 0;
    const handle = {
      source: 'eastmoney',
      capability: 'quote' as const,
      coverage: [],
      execute: async () => {
        calls += 1;
        const current = calls;
        if (current === 1) await gate.promise;
        return { ...quote('A'), close: money(current) };
      },
    };
    const old = c.execute(handle, { stockId: 'A' });
    now += config.leaseMs;
    expect((await c.execute(handle, { stockId: 'A' })).close).toBe(2);
    gate.resolve();
    await old;
    expect((await c.execute(handle, { stockId: 'A' })).close).toBe(2);
    expect(calls).toBe(2);
  });

  it('fails closed when shared quota storage is unavailable', async () => {
    const shared = store();
    shared.update = () => {
      throw new Error('storage unavailable');
    };
    const c = new MarketRequestCoordinator(shared, config, () => T0);
    const raw = vi.fn(async () => new Response('{}')) as unknown as typeof fetch;
    await expect(c.fetchFor('eastmoney', raw)('https://example.invalid')).rejects.toThrow(
      'storage unavailable',
    );
    expect(raw).not.toHaveBeenCalled();
  });

  it('keeps exchange identities and detail reads separate and rejects duplicate/unsolicited batch rows', async () => {
    const c = new MarketRequestCoordinator(store(), config, () => T0);
    const execute = vi.fn(async () => [quote('A.SH'), quote('A.SH'), quote('UNREQUESTED')]);
    const batch = {
      source: 'eastmoney',
      capability: 'batch-quote' as const,
      coverage: [],
      execute,
    };
    expect(await c.execute(batch, { stockIds: ['A.SH'] })).toEqual([]);
    const single = vi.fn(async ({ stockId }: { stockId: string }) => quote(stockId));
    const handle = {
      source: 'eastmoney',
      capability: 'quote' as const,
      coverage: [],
      execute: single,
    };
    await c.execute(handle, { stockId: 'A.SZ' });
    await c.execute(handle, { stockId: 'UNREQUESTED' });
    await c.execute(handle, { stockId: 'A.SZ', requireDetails: true });
    expect(single).toHaveBeenCalledTimes(3);
  });
});
