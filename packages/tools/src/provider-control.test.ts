import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMarketAdapterFromEnv,
  EastmoneySource,
  MarketRequestCoordinator,
  marketRequestConfigFromEnv,
  ProviderRuntime,
} from '@luoome/adapters';
import { money } from '@luoome/core';
import { syncDailyBarsTool } from '@luoome/plugin-market-tasks/tools/sync-daily-bars.js';
import { computeIndicatorsTool } from '@luoome/toolkit/tools/compute-indicators.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginExecutionPolicy } from './plugin-policy.js';
import { buildTestContext, createTestPluginControl } from './testing/context.js';

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
  const { store, set } = createTestPluginControl(root);
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

it('fails late source work once the parent guard is revoked', async () => {
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
  valid = false;
  expect(store.isEnabled('source.eastmoney')).toBe(true);
  const rejected = expect(late).rejects.toThrow('parent revoked');
  release.resolve();
  await rejected;
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
  await expect(unavailable.fetchQuote('002594.SZ')).rejects.toThrow('没有可用的数据源');
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
