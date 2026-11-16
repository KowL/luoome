import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMarketAdapterFromEnv,
  createMarketDumpAdapterFromEnv,
  EastmoneySource,
  MarketRequestCoordinator,
  marketRequestConfigFromEnv,
  PluginConfigStore,
  ProviderRuntime,
} from '@luoome/adapters';
import { type ManagedPluginId, money } from '@luoome/core';
import { syncDailyBarsTool } from '@luoome/plugin-market-tasks/tools/sync-daily-bars.js';
import { computeIndicatorsTool } from '@luoome/toolkit/tools/compute-indicators.js';
import { getStockMinuteBarsTool } from '@luoome/toolkit/tools/get-stock-minute-bars.js';
import { BUILTIN_PLUGIN_DEFAULTS } from '@luoome/tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginExecutionPolicy } from './plugin-policy.js';
import { buildTestContext } from './testing/context.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), 'luoome-p2-'));
  roots.push(root);
  const store = new PluginConfigStore(join(root, 'plugins.json'));
  store.initialize(BUILTIN_PLUGIN_DEFAULTS);
  const set = (id: ManagedPluginId, enabled: boolean) => {
    const read = store.read();
    if (!read.ok) throw new Error('missing');
    return store.set(id, enabled, read.config);
  };
  const now = new Date('2026-11-12T07:00:00Z');
  const base = await buildTestContext({ clock: () => now });
  const coordinator = new MarketRequestCoordinator(
    base.repos.publicMarket,
    marketRequestConfigFromEnv({}),
  );
  const runtime = new ProviderRuntime(store, coordinator);
  const source = new EastmoneySource({ clock: () => now });
  const market = createMarketAdapterFromEnv(
    { LUOOME_MARKET_PROVIDER: 'real' },
    {
      logger: base.logger,
      clock: () => now,
      providerRuntime: runtime,
      sourceOrder: ['eastmoney'],
      sources: { eastmoney: source },
    },
  );
  const ctx = {
    ...base,
    dataScope: runtime,
    executionPolicy: createPluginExecutionPolicy(
      store,
      new Set(['read', 'write', 'external', 'advice']),
    ),
    adapters: { ...base.adapters, market },
  };
  const bars = (close: number) => [
    {
      stockId: '002594.SZ',
      date: new Date('2026-11-11T00:00:00Z'),
      open: money(close),
      high: money(close),
      low: money(close),
      close: money(close),
      volume: 100,
      adjustment: 'qfq' as const,
      source: 'eastmoney',
    },
  ];
  return { ctx, runtime, store, set, source, bars };
};
const input = {
  scope: 'explicit',
  stockIds: ['002594.SZ'],
  concurrency: 1,
  maxRetries: 2,
} as const;

it('observes outstanding source work after the parent returns and marks parent revocation as draining', async () => {
  const { store, set } = await setup();
  set('source.eastmoney', true);
  const runtime = new ProviderRuntime(store);
  const started = deferred(),
    release = deferred();
  const transport = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
    started.resolve();
    await release.promise;
    return new Response('late');
  });
  const port = runtime.wrap('market', ['eastmoney'], () => ({
    read: async () =>
      (await runtime.fetchFor('eastmoney', transport)('https://example.com/quote')).text(),
  }));
  let valid = true;
  let late: Promise<string> | undefined;
  await runtime.run(
    async () => {
      late = port.read();
      await started.promise;
    },
    () => {
      if (!valid) throw new Error('parent revoked');
    },
  );
  expect(runtime.activity()).toEqual([{ id: 'source.eastmoney', inFlight: 1, revokedInFlight: 0 }]);
  valid = false;
  expect(runtime.activity()).toEqual([{ id: 'source.eastmoney', inFlight: 1, revokedInFlight: 1 }]);
  expect(store.acquire('source.eastmoney').ok).toBe(true);
  const rejected = expect(late).rejects.toThrow('parent revoked');
  release.resolve();
  await rejected;
  expect(runtime.activity()).toEqual([]);
});

it('keeps credential-missing controlled sources unavailable while retaining a ready fallback', async () => {
  const { store, set, source, bars } = await setup();
  set('source.tushare', true);
  const runtime = new ProviderRuntime(store);
  const env = { LUOOME_MARKET_PROVIDER: 'real' };
  const logger = (await buildTestContext()).logger;
  const unavailable = createMarketAdapterFromEnv(env, {
    logger,
    providerRuntime: runtime,
    sourceOrder: ['tushare'],
  });
  expect(runtime.ready(unavailable)).toBe(false);
  await expect(unavailable.fetchQuote('002594.SZ')).rejects.toThrow('no ready data providers');
  set('source.eastmoney', true);
  vi.spyOn(source, 'fetchDailyBars').mockResolvedValue(bars(10));
  const fallback = createMarketAdapterFromEnv(env, {
    logger,
    providerRuntime: runtime,
    sourceOrder: ['tushare', 'eastmoney'],
    sources: { eastmoney: source },
  });
  expect(runtime.ready(fallback)).toBe(true);
  expect(
    (
      await fallback.fetchDailyBars('002594.SZ', {
        start: new Date('2026-11-01'),
        end: new Date('2026-11-12'),
      })
    )[0]?.close,
  ).toBe(10);
});

describe('provider and ingestion task control', () => {
  it('starts closed, independently enables providers/tasks, and retains local reads with everything off', async () => {
    const { ctx, set, source, bars } = await setup();
    const fetch = vi.spyOn(source, 'fetchDailyBars').mockResolvedValue(bars(10));
    expect(await syncDailyBarsTool.execute(input, ctx)).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
    set('source.eastmoney', true);
    const range = { start: new Date('2026-11-01'), end: ctx.clock() };
    expect((await ctx.adapters.market.fetchDailyBars('002594.SZ', range))[0]?.close).toBe(10);
    expect(await syncDailyBarsTool.execute(input, ctx)).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
    set('task.daily-bars-sync', true);
    expect(await syncDailyBarsTool.execute(input, ctx)).toMatchObject({
      ok: true,
      data: { synced: 1 },
    });
    set('source.eastmoney', false);
    set('task.daily-bars-sync', false);
    expect(ctx.adapters.market.marketSourceStatus()).toEqual([]);
    await expect(ctx.adapters.market.fetchDailyBars('002594.SZ', range)).rejects.toThrow();
    expect(await computeIndicatorsTool.execute({ stockId: '002594.SZ' }, ctx)).toMatchObject({
      ok: true,
      data: { barsCount: 1, indicators: { close: 10 } },
    });
    expect((await ctx.repos.dailyBar.latestBefore('002594.SZ', ctx.clock(), 1))[0]?.close).toBe(10);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  for (const id of ['source.eastmoney', 'task.daily-bars-sync'] as const) {
    it(`${id}: an old paused A cannot overwrite B or rejoin B's activation`, async () => {
      const { ctx, set, source, bars } = await setup();
      set('source.eastmoney', true);
      set('task.daily-bars-sync', true);
      const started = deferred(),
        release = deferred();
      let calls = 0;
      vi.spyOn(source, 'fetchDailyBars').mockImplementation(async () => {
        calls++;
        if (calls === 1) {
          started.resolve();
          await release.promise;
          return bars(10);
        }
        return bars(20);
      });
      const old = syncDailyBarsTool.execute(input, ctx);
      await started.promise;
      set(id, false);
      set(id, true);
      expect(await syncDailyBarsTool.execute(input, ctx)).toMatchObject({
        ok: true,
        data: { synced: 1 },
      });
      release.resolve();
      expect(await old).toMatchObject({ ok: true, data: { synced: 0, failed: 1 } });
      expect((await ctx.repos.dailyBar.latestBefore('002594.SZ', ctx.clock(), 1))[0]?.close).toBe(
        20,
      );
      const currentPolicy = ctx.executionPolicy.bind();
      const cached = await ctx.dataScope.run(
        async () =>
          ctx.adapters.market.fetchDailyBars('002594.SZ', {
            start: new Date(ctx.clock().getTime() - 370 * 86400000),
            end: ctx.clock(),
          }),
        (dependency) => currentPolicy.assertTool('sync_daily_bars', dependency),
        currentPolicy.scopeKey('sync_daily_bars'),
      );
      expect(cached[0]?.close).toBe(20);
      expect(calls).toBe(2);
      expect(
        ctx.adapters.market.marketSourceStatus().filter((s) => s.dataset === 'daily-bars'),
      ).toMatchObject([{ lastSuccessAt: ctx.clock() }]);
    });
  }
  it('revokes a previously bound tool even when it misses the complete off/on transition', async () => {
    const { ctx, set, source } = await setup();
    set('source.eastmoney', true);
    set('task.daily-bars-sync', true);
    const saved = { ...ctx, executionPolicy: ctx.executionPolicy.bind() };
    const fetch = vi.spyOn(source, 'fetchDailyBars');
    set('task.daily-bars-sync', false);
    set('task.daily-bars-sync', true);
    expect(await syncDailyBarsTool.execute(input, saved)).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('checks the real transport dependency and does not reset provider budgets on off/on', async () => {
    const { runtime, set, ctx } = await setup();
    set('source.tencent', true);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{}'));
    const transport = runtime.fetchFor('tencent', fetch);
    await expect(transport('https://hq.sinajs.cn/list=sh600000')).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    set('source.sina', true);
    await transport('https://hq.sinajs.cn/list=sh600000');
    set('source.sina', false);
    set('source.sina', true);
    await transport('https://hq.sinajs.cn/list=sh600000');
    expect(fetch).toHaveBeenCalledTimes(2);
    const entry = ctx.repos.publicMarket.read('provider:sina', Date.now());
    expect(entry && JSON.parse(entry).attempts).toHaveLength(2);
  });
  it('a failed prepared settings rebuild keeps the old route; publication revokes old closures', async () => {
    const { runtime, set } = await setup();
    set('source.eastmoney', true);
    const first = runtime.wrap('test', ['eastmoney'], () => ({ read: async () => 1 }));
    const old = first.read;
    const abandoned = runtime.prepare(() =>
      runtime.wrap('test', ['eastmoney'], () => ({ read: async () => 2 })),
    );
    expect(await first.read()).toBe(1);
    abandoned.activate();
    await expect(old()).rejects.toThrow();
    expect(await abandoned.value.read()).toBe(2);
  });
});

it('minute collection can be stopped while local history remains readable, including after a late response', async () => {
  const { ctx, set } = await setup();
  const minute = {
    stockId: '002594.SZ',
    interval: '1m' as const,
    endedAt: new Date('2026-11-12T02:00:00Z'),
    fetchedAt: ctx.clock(),
    open: money(10),
    high: money(10),
    low: money(10),
    close: money(10),
    volume: 100,
    adjustment: 'raw' as const,
    source: 'fixture',
    completeness: 'closed' as const,
  };
  await ctx.repos.minuteBar.saveMany([minute]);
  const started = deferred(),
    release = deferred();
  const fetch = vi.fn(async () => {
    started.resolve();
    await release.promise;
    return [{ ...minute, close: money(20), high: money(20) }];
  });
  const scoped = {
    ...ctx,
    adapters: { ...ctx.adapters, market: { ...ctx.adapters.market, fetchMinuteBars: fetch } },
  };
  expect(await getStockMinuteBarsTool.execute({ stockId: '002594.SZ' }, scoped)).toMatchObject({
    ok: true,
    data: {
      retrieval: 'local-fallback',
      bars: [{ close: 10 }],
      warnings: expect.arrayContaining(['task-disabled']),
    },
  });
  expect(fetch).not.toHaveBeenCalled();
  set('task.minute-bars-sync', true);
  const old = getStockMinuteBarsTool.execute({ stockId: '002594.SZ' }, scoped);
  await started.promise;
  set('task.minute-bars-sync', false);
  release.resolve();
  expect(await old).toMatchObject({
    ok: true,
    data: { retrieval: 'local-fallback', bars: [{ close: 10 }] },
  });
  expect((await ctx.repos.minuteBar.latestSession('002594.SZ', '1m'))[0]?.close).toBe(10);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('late dump bodies cannot replace a newer artifact with the same upstream filename', async () => {
  const { runtime, store, set } = await setup();
  set('source.fuyao', true);
  const started = deferred(),
    release = deferred();
  let downloads = 0;
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('/download-url'))
      return Response.json({
        code: 0,
        data: { presigned_url: 'https://example.com/shared.parquet' },
      });
    downloads++;
    const response = new Response(downloads === 1 ? 'old' : 'new');
    if (downloads === 1)
      vi.spyOn(response, 'arrayBuffer').mockImplementation(async () => {
        started.resolve();
        await release.promise;
        return new TextEncoder().encode('old').buffer;
      });
    return response;
  });
  const adapter = createMarketDumpAdapterFromEnv(
    { FUYAO_API_KEY: 'offline-fixture-only' },
    { providerRuntime: runtime, home: join(store.path, '..'), fetchImpl: fetch },
  );
  if (adapter === undefined) throw new Error('missing dump fixture');
  const old = adapter.download('daily-k-10d');
  const rejected = expect(old).rejects.toThrow();
  await started.promise;
  set('source.fuyao', false);
  set('source.fuyao', true);
  const published = await adapter.download('daily-k-10d');
  expect(readFileSync(published.localPath, 'utf8')).toBe('new');
  release.resolve();
  await rejected;
  expect(readFileSync(published.localPath, 'utf8')).toBe('new');
});

for (const status of [200, 429])
  it(`provider ${status === 200 ? 'quota' : 'cooldown'} survives off/on and a new runtime`, async () => {
    const { ctx, store, set } = await setup();
    set('source.eastmoney', true);
    const config = marketRequestConfigFromEnv({ LUOOME_MARKET_REQUESTS_PER_WINDOW: '1' });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => new Response('{}', { status }));
    const runtime = new ProviderRuntime(
      store,
      new MarketRequestCoordinator(ctx.repos.publicMarket, config),
    );
    if (status === 200) await runtime.fetchFor('eastmoney', fetch)('https://example.com/quote');
    else
      await expect(
        runtime.fetchFor('eastmoney', fetch)('https://example.com/quote'),
      ).rejects.toThrow();
    set('source.eastmoney', false);
    set('source.eastmoney', true);
    const restarted = new ProviderRuntime(
      store,
      new MarketRequestCoordinator(ctx.repos.publicMarket, config),
    );
    await expect(
      restarted.fetchFor('eastmoney', fetch)('https://example.com/quote'),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

it('rechecks after quota lock admission before sending, without turning revocation into provider failure', async () => {
  const { ctx, store, set } = await setup();
  set('source.eastmoney', true);
  const publicMarket = ctx.repos.publicMarket;
  let revoked = false;
  const blockedStore = {
    read: publicMarket.read.bind(publicMarket),
    update: <T>(
      key: string,
      now: number,
      until: number,
      change: (value: string | null) => { readonly value: string; readonly result: T },
    ) =>
      publicMarket.update(key, now, until, (value) => {
        if (key === 'provider:eastmoney' && !revoked) {
          set('source.eastmoney', false);
          revoked = true;
        }
        return change(value);
      }),
  };
  const runtime = new ProviderRuntime(
    store,
    new MarketRequestCoordinator(blockedStore, marketRequestConfigFromEnv({})),
  );
  const fetch = vi.fn<typeof globalThis.fetch>();
  await expect(runtime.fetchFor('eastmoney', fetch)('https://example.com/quote')).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  const state = publicMarket.read('provider:eastmoney', Date.now());
  expect(state && JSON.parse(state).errorKind).toBeUndefined();
});
