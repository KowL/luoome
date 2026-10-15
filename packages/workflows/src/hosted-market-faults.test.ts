import { money, type Quote, stockCode, type ToolContext } from '@luoome/core';
import {
  addWatchlistMemberTool,
  batchQuoteTool,
  createAlertPlanTool,
  createWatchlistTool,
} from '@luoome/tools';
import { createHostedWatchNotificationManager } from '@luoome/tools/hosted';
import { buildTestContext } from '@luoome/tools/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuoteCache } from '../../adapters/src/market/cache.js';
import { MarketDataManager } from '../../adapters/src/market/manager.js';
import {
  MarketRequestCoordinator,
  marketRequestConfigFromEnv,
} from '../../adapters/src/market/request-coordinator.js';
import { MarketSourceRegistry } from '../../adapters/src/market/source-registry.js';
import { createMemoryPublicMarketStore } from '../../db/src/hosted/public-market-memory.js';
import { intradayWatchWorkflow } from './intraday-watch.js';

const T0 = Date.parse('2026-10-15T02:00:00Z');
const config = { ...marketRequestConfigFromEnv({}), cacheTtlMs: 1000, requestsPerWindow: 100 };
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const quote = (stockId: string, now: number, price = 120): Quote => ({
  stockId,
  source: 'eastmoney',
  observedAt: new Date(now),
  fetchedAt: new Date(now),
  ts: new Date(now),
  timestampSource: 'upstream',
  open: money(price),
  high: money(price),
  low: money(price),
  close: money(price),
  volume: 100,
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DS-4 market fault injection', () => {
  it.each(['429', 'network'] as const)(
    '%s cooldown is shared across rebuilt coordinators and rejected stocks cannot slide its deadline',
    async (failure) => {
      vi.useFakeTimers();
      vi.setSystemTime(T0);
      let now = T0;
      const shared = createMemoryPublicMarketStore();
      const http = vi.fn(async () => {
        if (http.mock.calls.length > 1) return Response.json({ ok: true });
        if (failure === 'network') throw new TypeError('injected offline');
        return new Response(null, { status: 429, headers: { 'retry-after': '120' } });
      });
      const perform = async (stockId: string, single = false) => {
        const coordinator = new MarketRequestCoordinator(shared, config, () => now);
        const fetch = coordinator.fetchFor('eastmoney', http as unknown as typeof globalThis.fetch);
        if (single)
          return coordinator.execute(
            {
              source: 'eastmoney',
              capability: 'quote',
              coverage: [],
              execute: async ({ stockId }) => {
                await fetch('https://push2.eastmoney.com/quote');
                return quote(stockId, now);
              },
            },
            { stockId },
          );
        return coordinator.execute(
          {
            source: 'eastmoney',
            capability: 'batch-quote',
            coverage: [],
            execute: async ({ stockIds }) => {
              await fetch('https://push2.eastmoney.com/batch');
              return stockIds.map((id) => quote(id, now));
            },
          },
          { stockIds: [stockId] },
        );
      };
      await expect(perform('600519.SH')).rejects.toMatchObject({
        kind: failure === '429' ? 'rate_limited' : 'network',
      });
      const deadline = T0 + (failure === '429' ? 120_000 : 60_000);
      for (const offset of [1, 10_000, 30_000, deadline - T0 - 1]) {
        now = T0 + offset;
        await expect(perform(`blocked-${offset}.SH`, offset % 2 === 1)).rejects.toMatchObject({
          kind: failure === '429' ? 'rate_limited' : 'network',
        });
        await expect(perform('600519.SH')).rejects.toMatchObject({
          kind: failure === '429' ? 'rate_limited' : 'network',
        });
        expect(JSON.parse(shared.read('provider:eastmoney', now) ?? '{}')).toMatchObject({
          blockedUntil: deadline,
          attempts: now - T0 < config.windowMs ? [T0] : [],
        });
        expect(http).toHaveBeenCalledTimes(1);
      }
      now = deadline;
      await expect(perform('recovered.SH')).resolves.toMatchObject([
        { stockId: 'recovered.SH', observedAt: new Date(deadline) },
      ]);
      expect(http).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['429', 'network'] as const)(
    '%s returns stale display facts with original timestamps but blocks intraday action evidence until fresh recovery',
    async (failure) => {
      vi.useFakeTimers();
      vi.setSystemTime(T0);
      let now = T0;
      let price = 90;
      let offline = false;
      const clock = () => new Date(now);
      const shared = createMemoryPublicMarketStore();
      const coordinator = new MarketRequestCoordinator(shared, config, () => now);
      const upstream = vi.fn(async () => {
        if (offline) {
          if (failure === 'network') throw new TypeError('injected offline');
          return new Response(null, { status: 429 });
        }
        return Response.json({ ok: true });
      });
      const transport = coordinator.fetchFor('eastmoney', upstream as unknown as typeof fetch);
      const registry = new MarketSourceRegistry(
        [
          {
            source: 'eastmoney',
            capability: 'batch-quote',
            coverage: ['CN_A_SHARES_SH_SZ'],
            configurationReady: true,
            observationOf: () => ({ outcome: 'success' as const, dataAsOf: clock() }),
            execute: async ({ stockIds }) => {
              await transport('https://push2.eastmoney.com/quotes');
              return stockIds.map((id) => quote(id, now, price));
            },
          },
          {
            source: 'eastmoney',
            capability: 'quote',
            coverage: ['CN_A_SHARES_SH_SZ'],
            configurationReady: true,
            observationOf: () => ({ outcome: 'success' as const, dataAsOf: clock() }),
            execute: async ({ stockId }) => {
              await transport('https://push2.eastmoney.com/quote');
              return quote(stockId, now, price);
            },
          },
        ],
        clock,
        coordinator,
      );
      const market = new MarketDataManager({
        registry,
        logger,
        clock,
        rateLimitPerSec: 10_000,
        quoteCache: new QuoteCache(32, 1000, clock),
      });
      const base = await buildTestContext({ clock });
      await base.repos.stock.save({
        id: '600001.SH',
        code: stockCode('600001'),
        exchange: 'SH',
        name: '无缓存测试',
      });
      const trusted: ToolContext = {
        ...base,
        adapters: { ...base.adapters, market },
        identity: {
          mode: 'hosted',
          actor: 'worker',
          userId: base.user.id,
          tenantId: 'tenant',
          tenantGeneration: 1,
          requestId: 'fault',
        },
        hostedAuthorization: async () => null,
      };
      const ctx = {
        ...trusted,
        notification: createHostedWatchNotificationManager(trusted, async () => null),
      };
      await createWatchlistTool.execute(
        { id: 'fault-list', name: 'fixture', kind: 'personal', membershipPolicy: 'manual' },
        ctx,
      );
      await addWatchlistMemberTool.execute(
        { watchlistId: 'fault-list', stockId: '600519.SH' },
        ctx,
      );
      await createAlertPlanTool.execute(
        {
          id: 'fault-plan',
          name: 'fixture',
          watchlistId: 'fault-list',
          cooldownMinutes: 0,
          rules: [{ id: 'price', kind: 'price-level', level: 100, side: 'above' }],
        },
        ctx,
      );
      const settings = await ctx.repos.watchDelivery.settings();
      await ctx.repos.watchDelivery.saveSettings({
        ...settings,
        expectedRevision: settings.revision,
        webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/ds4-fixture',
        now: clock(),
      });
      const webhook = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => Response.json({ StatusCode: 0 }));
      expect((await intradayWatchWorkflow.run({ notify: true }, ctx)).ok).toBe(true);
      now += 1001;
      price = 120;
      expect(await batchQuoteTool.execute({ stockIds: ['600519.SH'] }, ctx)).toMatchObject({
        ok: true,
        data: { items: [{ status: 'ok' }] },
      });
      const original = await ctx.repos.quote.latestByStock('600519.SH');
      expect(original?.close).toBe(120);
      now += 240_000;
      offline = true;
      const display = await batchQuoteTool.execute(
        { stockIds: ['600519.SH', '600001.SH'], context: 'display' },
        ctx,
      );
      expect(display).toMatchObject({
        ok: true,
        data: {
          items: [
            {
              stockId: '600519.SH',
              status: 'ok',
              freshness: 'stale',
              retrieval: 'local-fallback',
              quote: {
                observedAt: original?.observedAt,
                fetchedAt: original?.fetchedAt,
                ts: original?.ts,
                close: 120,
              },
            },
            { stockId: '600001.SH', status: 'unavailable' },
          ],
        },
      });
      const callsAtFailure = upstream.mock.calls.length;
      const blocked = await intradayWatchWorkflow.run({ notify: true }, ctx);
      expect(blocked).toMatchObject({
        ok: true,
        data: {
          triggers: [],
          unknownRules: 1,
          unavailableQuoteStocks: 1,
          quoteBatches: 1,
          notified: 0,
          notifyFailed: 0,
        },
      });
      expect(await ctx.repos.watchTrigger.listRecent({})).toEqual([]);
      expect(await ctx.repos.watchTrigger.countAttemptedSince(new Date(T0))).toBe(0);
      expect(webhook).not.toHaveBeenCalled();
      expect(upstream).toHaveBeenCalledTimes(callsAtFailure);
      expect(await ctx.repos.quote.latestByStock('600519.SH')).toEqual(original);
      now += 60_000;
      offline = false;
      const recovered = await intradayWatchWorkflow.run({ notify: true }, ctx);
      expect(recovered).toMatchObject({
        ok: true,
        data: { triggers: [{ quoteClose: 120 }], delivered: 1, notifyFailed: 0 },
      });
      expect(await ctx.repos.watchTrigger.countAttemptedSince(new Date(T0))).toBe(1);
      expect(webhook).toHaveBeenCalledTimes(1);
      expect((await ctx.repos.watchDelivery.list())[0]).toMatchObject({
        state: 'accepted',
        deliveredAt: null,
      });
    },
  );
});
