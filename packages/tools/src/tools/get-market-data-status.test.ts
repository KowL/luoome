import type { SourceStatus } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { getMarketDataStatusTool } from './get-market-data-status.js';

describe('tool/get_market_data_status', () => {
  it('数据集库存来自 Gateway，新增 capability 不依赖写死 provider 常量', async () => {
    const ctx = await buildTestContext({
      stockUniverse: {
        name: 'stock-universe',
        sources: ['universe-test'],
        fetchStockUniverse: () => Promise.reject(new Error('not used')),
      },
      limitUpLadder: {
        name: 'limit-up-ladder',
        sources: ['ladder-test'],
        status: () => [
          {
            dataset: 'limit-up-ladder',
            source: 'ladder-test',
            coverage: ['CN_A_SHARES_SH_SZ'],
            capabilityEnabled: true,
            configurationReady: true,
          },
        ],
        fetchLadder: () => Promise.reject(new Error('not used')),
        compareLadder: () => Promise.reject(new Error('not used')),
      },
    });
    const result = await getMarketDataStatusTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.datasets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dataset: 'quote', source: 'test' }),
        expect.objectContaining({ dataset: 'daily-bars', source: 'test' }),
        expect.objectContaining({ dataset: 'market-snapshot', source: 'test' }),
        expect.objectContaining({
          dataset: 'stock-universe',
          source: 'universe-test',
        }),
        expect.objectContaining({
          dataset: 'limit-up-ladder',
          source: 'ladder-test',
        }),
      ]),
    );
    expect(result.data.providers.map((provider) => provider.provider)).toEqual(
      expect.arrayContaining(['test', 'universe-test', 'ladder-test']),
    );
  });

  it('聚合五个非行情 manager 的 status()；未装配的端口不产生 dataset', async () => {
    const marker = (dataset: string): SourceStatus => ({
      dataset,
      source: `${dataset}-src`,
      coverage: ['CN_A_SHARES_SH_SZ'],
      capabilityEnabled: true,
      configurationReady: true,
    });
    const ctx = await buildTestContext({
      dragonTiger: {
        name: 'dragon-tiger',
        sources: ['dragon-tiger-src'],
        fetchList: () => Promise.reject(new Error('not used')),
        status: () => [marker('dragon-tiger')],
      },
      news: {
        name: 'news',
        sources: ['news-src'],
        fetchNews: () => Promise.reject(new Error('not used')),
        status: () => [marker('finance-news')],
      },
      ashareSentiment: {
        fetch: () => Promise.reject(new Error('not used')),
        status: () => [marker('sentiment-sealed-pool'), marker('sentiment-broken-pool')],
      },
    });
    const result = await getMarketDataStatusTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.datasets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dataset: 'dragon-tiger', source: 'dragon-tiger-src' }),
        expect.objectContaining({ dataset: 'finance-news', source: 'finance-news-src' }),
        expect.objectContaining({ dataset: 'sentiment-sealed-pool' }),
        expect.objectContaining({ dataset: 'sentiment-broken-pool' }),
      ]),
    );
    // 未装配 limitUpLadder / northboundFlow：不产生对应 inventory
    expect(
      result.data.datasets.some(
        (dataset) => dataset.dataset === 'limit-up-ladder' || dataset.dataset === 'northbound-flow',
      ),
    ).toBe(false);
  });

  it('freshness 状态机：失败后 unavailable 且保留旧 dataAsOf，恢复后清除；空结果 unknown', async () => {
    const now = new Date('2026-08-21T08:00:00.000Z');
    const base = {
      dataset: 'finance-news',
      source: 'eastmoney',
      coverage: ['CN_FINANCE_NEWS'],
      capabilityEnabled: true,
      configurationReady: true,
    } as const;
    let current: SourceStatus = {
      ...base,
      lastAttemptAt: now,
      lastSuccessAt: now,
      dataAsOf: new Date(now.getTime() - 60_000),
    };
    const ctx = await buildTestContext({
      clock: () => now,
      news: {
        name: 'news',
        sources: ['eastmoney'],
        fetchNews: () => Promise.reject(new Error('not used')),
        status: () => [current],
      },
    });
    const freshnessOf = async (): Promise<{
      freshness: string;
      dataAsOf?: Date | undefined;
      lastErrorKind?: string | undefined;
    }> => {
      const result = await getMarketDataStatusTool.execute({}, ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      const dataset = result.data.datasets.find((item) => item.dataset === 'finance-news');
      if (dataset === undefined) throw new Error('finance-news dataset missing');
      return dataset;
    };

    // success：日级数据走 36h 档，1 分钟前的 dataAsOf 为 fresh
    expect(await freshnessOf()).toMatchObject({ freshness: 'fresh' });

    // failure：unavailable，保留旧 dataAsOf 供诊断（不回退 lastSuccessAt 判 fresh）
    const staleDataAsOf = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    current = {
      ...base,
      lastAttemptAt: now,
      lastSuccessAt: new Date(now.getTime() - 60_000),
      dataAsOf: staleDataAsOf,
      lastErrorKind: 'network',
    };
    expect(await freshnessOf()).toMatchObject({
      freshness: 'unavailable',
      dataAsOf: staleDataAsOf,
      lastErrorKind: 'network',
    });

    // 恢复 success：错误清除，按新 dataAsOf 重新判 fresh
    current = { ...base, lastAttemptAt: now, lastSuccessAt: now, dataAsOf: now };
    const recovered = await freshnessOf();
    expect(recovered.freshness).toBe('fresh');
    expect(recovered.lastErrorKind).toBeUndefined();

    // 超阈值：dataAsOf 超过 36h 为 stale
    current = { ...base, lastAttemptAt: now, lastSuccessAt: now, dataAsOf: staleDataAsOf };
    expect(await freshnessOf()).toMatchObject({ freshness: 'stale' });

    // 合法空结果：无 dataAsOf 且无错误 → unknown；有 lastSuccessAt 也不准回退伪造数据时间
    current = { ...base, lastAttemptAt: now, lastSuccessAt: now };
    const empty = await freshnessOf();
    expect(empty.freshness).toBe('unknown');
    expect(empty.dataAsOf).toBeUndefined();
  });
  it('watchlistStale 报告存在 stale 成员来源的启用 Watchlist', async () => {
    const ctx = await buildTestContext();
    const now = new Date('2026-07-28T02:00:00.000Z');
    await ctx.repos.watchlist.save({
      id: 'stale-watch',
      name: '过期观察',
      kind: 'personal',
      membershipPolicy: 'manual',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.repos.watchlistMember.saveMember({
      id: 'stale-watch:002594.SZ',
      watchlistId: 'stale-watch',
      stockId: '002594.SZ',
      stage: 'watching',
      priority: 'normal',
      firstAddedAt: now,
      lastActivityAt: now,
    });
    await ctx.repos.watchlistMember.saveSource({
      id: 'stale-watch:002594.SZ:manual-1',
      memberId: 'stale-watch:002594.SZ',
      kind: 'manual',
      sourceKey: 'manual:stale-watch:002594.SZ',
      reason: '测试 stale',
      status: 'stale',
      evidence: [],
      validFrom: now,
    });

    const result = await getMarketDataStatusTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.watchlistStale).toEqual([{ watchlistId: 'stale-watch', name: '过期观察' }]);
  });
});
