import type { MarketSourceStatus } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';
import { computeRelevantStockIds } from './sync-stock-events.js';

/** 新鲜度阈值：最新快照超过 15 分钟视为 stale（Phase 1 简化，不区分盘中/盘后）。 */
const STALE_AFTER_MS = 15 * 60 * 1000;

export const ProviderFreshnessSchema = z.object({
  provider: z.string(),
  freshness: z.enum(['fresh', 'stale', 'unknown', 'unavailable']),
  latestObservedAt: z.coerce.date().optional(),
});

const DatasetStatusSchema = z.object({
  dataset: z.string(),
  source: z.string(),
  coverage: z.array(z.string()),
  capabilityEnabled: z.boolean(),
  configurationReady: z.boolean(),
  lastAttemptAt: z.coerce.date().optional(),
  lastSuccessAt: z.coerce.date().optional(),
  dataAsOf: z.coerce.date().optional(),
  freshness: z.enum(['fresh', 'stale', 'unknown', 'unavailable']),
  lastErrorKind: z.string().optional(),
});

export const GetMarketDataStatusInput = z.object({});

export const GetMarketDataStatusOutput = z.object({
  providers: z.array(ProviderFreshnessSchema),
  datasets: z.array(DatasetStatusSchema),
  watchHealth: z
    .object({
      state: z.enum(['never', 'running', 'healthy', 'failed']),
      latestRunAt: z.coerce.date().optional(),
      triggered: z.number().int().nonnegative().optional(),
      notifyFailed: z.number().int().nonnegative().optional(),
    })
    .nullable(),
  watchlistStale: z.array(z.object({ watchlistId: z.string(), name: z.string() })),
});

/**
 * get_market_data_status（ruo 迁移 §6 / §7.3，read）。现算，不落新表。
 *
 * - providers：按 PriceSnapshot 最新一条推断新鲜度（fresh / stale / unknown）
 * - watchHealth：最近 WatchRun 摘要
 * - watchlistStale：存在 stale 成员来源的启用 Watchlist
 */
export const getMarketDataStatusTool = defineTool({
  name: 'get_market_data_status',
  description: '行情数据健康读模型：各源新鲜度 + watch 运行健康 + stale Watchlist',
  sideEffect: 'read',
  input: GetMarketDataStatusInput,
  output: GetMarketDataStatusOutput,
  handler: async (_input, ctx) => {
    const now = ctx.clock();

    // provider 新鲜度：扫关注股票的最新快照，按 source 聚合 max(ts)
    const stockIds = await computeRelevantStockIds(ctx);
    const latestBySource = new Map<string, Date>();
    if (stockIds.length > 0) {
      const quotes = await ctx.repos.quote.latestByStocks(stockIds);
      for (const q of quotes.values()) {
        const prev = latestBySource.get(q.source);
        if (prev === undefined || q.observedAt.getTime() > prev.getTime()) {
          latestBySource.set(q.source, q.observedAt);
        }
      }
    }
    const marketInventory = ctx.adapters.market.marketSourceStatus();
    const universeInventory: MarketSourceStatus[] = await Promise.all(
      (ctx.adapters.stockUniverse?.sources ?? []).map(async (source) => {
        const latest = await ctx.repos.stockUniverse.latestSuccessfulSync({
          source,
          coverage: 'CN_A_SHARES_SH_SZ',
        });
        return {
          dataset: 'stock-universe' as const,
          source,
          coverage: ['CN_A_SHARES_SH_SZ'] as const,
          capabilityEnabled: true,
          configurationReady: true,
          ...(latest === null ? {} : { lastAttemptAt: latest.startedAt }),
          ...(latest?.finishedAt === null || latest?.finishedAt === undefined
            ? {}
            : { lastSuccessAt: latest.finishedAt }),
          ...(latest?.observedAt === null || latest?.observedAt === undefined
            ? {}
            : { dataAsOf: latest.observedAt }),
        };
      }),
    );
    const ladderInventory: MarketSourceStatus[] = (ctx.limitUpLadder?.sources ?? []).map(
      (source) => ({
        dataset: 'limit-up-ladder' as const,
        source,
        coverage: ['CN_A_SHARES_SH_SZ'] as const,
        capabilityEnabled: true,
        configurationReady: true,
      }),
    );
    const inventory: readonly MarketSourceStatus[] = [
      ...marketInventory,
      ...universeInventory,
      ...ladderInventory,
    ];
    const sourceIds = [
      ...new Set([...inventory.map((item) => item.source), ...latestBySource.keys()]),
    ];
    const providers = sourceIds.map((provider) => {
      const latest = latestBySource.get(provider);
      if (latest === undefined) {
        return { provider, freshness: 'unknown' as const };
      }
      const fresh = now.getTime() - latest.getTime() <= STALE_AFTER_MS;
      return {
        provider,
        freshness: fresh ? ('fresh' as const) : ('stale' as const),
        latestObservedAt: latest,
      };
    });
    const datasets = inventory.map((item) => {
      const dataAt = item.dataAsOf ?? item.lastSuccessAt;
      const thresholdMs =
        item.dataset === 'quote' ||
        item.dataset === 'realtime-index' ||
        item.dataset === 'market-snapshot' ||
        item.dataset === 'market-snapshot-envelope'
          ? STALE_AFTER_MS
          : 36 * 60 * 60 * 1000;
      const freshness =
        dataAt !== undefined
          ? now.getTime() - dataAt.getTime() <= thresholdMs
            ? ('fresh' as const)
            : ('stale' as const)
          : item.lastErrorKind !== undefined
            ? ('unavailable' as const)
            : ('unknown' as const);
      return { ...item, coverage: [...item.coverage], freshness };
    });

    // watch 健康
    const latestRun = await ctx.repos.watchRun.latest();
    const watchHealth =
      latestRun === null
        ? { state: 'never' as const }
        : {
            state:
              latestRun.status === 'failed'
                ? ('failed' as const)
                : latestRun.status === 'running'
                  ? ('running' as const)
                  : ('healthy' as const),
            latestRunAt: latestRun.finishedAt ?? latestRun.startedAt,
            triggered: latestRun.triggered,
            notifyFailed: latestRun.notifyFailed,
          };

    const watchlistStale: Array<{ watchlistId: string; name: string }> = [];
    for (const watchlist of await ctx.repos.watchlist.list({ enabledOnly: true })) {
      const members = await ctx.repos.watchlistMember.listMembers(watchlist.id);
      const sources = (
        await Promise.all(members.map((member) => ctx.repos.watchlistMember.listSources(member.id)))
      ).flat();
      if (sources.some((source) => source.status === 'stale')) {
        watchlistStale.push({ watchlistId: watchlist.id, name: watchlist.name });
      }
    }

    return { providers, datasets, watchHealth, watchlistStale };
  },
});
