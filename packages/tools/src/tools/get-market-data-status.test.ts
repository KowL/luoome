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
