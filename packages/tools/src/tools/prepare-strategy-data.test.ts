import { createHash } from 'node:crypto';
import type { DailyBarRevision } from '@luoome/core';
import { type DailyBar, money } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext, seedTestStockUniverse } from '../testing/context.js';
import { prepareStrategyDataTool } from './prepare-strategy-data.js';

const bar = (date: Date): DailyBar => ({
  stockId: '600519.SH',
  date,
  open: money(10),
  high: money(11),
  low: money(9),
  close: money(10),
  volume: 1_000_000,
  adjustment: 'qfq',
  source: 'stale-fixture',
});

const revisionFor = (input: DailyBar, recordedAt: Date): DailyBarRevision => ({
  stockId: input.stockId,
  date: input.date,
  contentHash: createHash('sha256')
    .update(
      JSON.stringify({
        open: input.open,
        high: input.high,
        low: input.low,
        close: input.close,
        volume: input.volume,
        source: input.source,
      }),
    )
    .digest('hex'),
  open: input.open,
  high: input.high,
  low: input.low,
  close: input.close,
  volume: input.volume,
  source: input.source,
  recordedAt,
});

describe('prepare_strategy_data freshness and vintage', () => {
  it('honors the bounded provider concurrency', async () => {
    const now = new Date('2026-08-12T09:00:00.000Z');
    const base = await buildTestContext({ clock: () => now });
    const stockIds = ['600519.SH', '000001.SZ', '300750.SZ', '601318.SH'];
    let active = 0;
    let maxActive = 0;
    const ctx = {
      ...base,
      adapters: {
        ...base.adapters,
        market: {
          ...base.adapters.market,
          fetchDailyBars: async (stockId: string) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active -= 1;
            return [{ ...bar(new Date('2026-08-11T00:00:00.000Z')), stockId }];
          },
        },
      },
    };

    const result = await prepareStrategyDataTool.execute(
      {
        strategyId: 'strategy-1',
        asOf: now,
        stockIds,
        concurrency: 2,
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(result.data.checkpoint.availableCount).toBe(stockIds.length);
  });

  it('scheduled cache policy reuses a fresh local projection without calling the provider', async () => {
    const now = new Date('2026-08-12T09:00:00.000Z');
    const base = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(base, { limit: 1, observedAt: now });
    const cachedBar = bar(new Date('2026-08-11T00:00:00.000Z'));
    await base.repos.dailyBar.saveMany([cachedBar]);
    let providerCalls = 0;
    const ctx = {
      ...base,
      adapters: {
        ...base.adapters,
        market: {
          ...base.adapters.market,
          fetchDailyBars: () => {
            providerCalls += 1;
            return Promise.reject(new Error('provider must not be called for fresh cache'));
          },
        },
      },
    };

    const result = await prepareStrategyDataTool.execute(
      {
        strategyId: 'strategy-1',
        asOf: now,
        stockIds: ['600519.SH'],
        cachePolicy: 'reuse-fresh',
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(providerCalls).toBe(0);
    expect(result.data.checkpoint).toMatchObject({
      status: 'complete',
      availableCount: 1,
      providerStatuses: [
        expect.objectContaining({
          provider: 'local:daily-bars',
          freshness: 'fresh',
        }),
      ],
    });
    expect(result.data.members[0]).toMatchObject({
      status: 'available',
      provider: 'local:daily-bars',
    });
    expect(await ctx.repos.dailyBar.listRevisions({ stockId: '600519.SH' })).toHaveLength(1);
  });

  it('stale daily bar is missing rather than provider-ok and lowers checkpoint coverage', async () => {
    const now = new Date('2026-08-12T09:00:00.000Z');
    const base = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(base, { limit: 1, observedAt: now });
    const oldBar = bar(new Date('2026-08-05T00:00:00.000Z'));
    const ctx = {
      ...base,
      adapters: {
        ...base.adapters,
        market: { ...base.adapters.market, fetchDailyBars: () => Promise.resolve([oldBar]) },
      },
    };

    const result = await prepareStrategyDataTool.execute(
      {
        strategyId: 'strategy-1',
        asOf: now,
        stockIds: ['600519.SH'],
        maxStalenessTradingDays: 1,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.checkpoint).toMatchObject({
      status: 'failed',
      availableCount: 0,
      vintageStatus: 'not-applicable',
      providerStatuses: [
        expect.objectContaining({
          freshness: 'unavailable',
          dataAsOf: oldBar.date,
          missing: 1,
          errorKinds: ['stale_data'],
        }),
      ],
    });
    expect(result.data.members[0]).toMatchObject({
      status: 'missing',
      errorKind: 'stale_data',
    });
    expect(result.data.performance).toMatchObject({
      memberLatencyMs: { samples: 1 },
    });
    expect(result.data.checkpoint.providerStatuses[0]?.latencyMs).toMatchObject({ samples: 1 });
  });

  it('reuse-fresh refreshes a stale local projection before applying the freshness gate', async () => {
    const now = new Date('2026-08-12T09:00:00.000Z');
    const base = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(base, { limit: 1, observedAt: now });
    await base.repos.dailyBar.saveMany([bar(new Date('2026-08-05T00:00:00.000Z'))]);
    const freshBar = bar(new Date('2026-08-11T00:00:00.000Z'));
    let providerCalls = 0;
    const ctx = {
      ...base,
      adapters: {
        ...base.adapters,
        market: {
          ...base.adapters.market,
          fetchDailyBars: () => {
            providerCalls += 1;
            return Promise.resolve([freshBar]);
          },
        },
      },
    };

    const result = await prepareStrategyDataTool.execute(
      {
        strategyId: 'strategy-1',
        asOf: now,
        stockIds: ['600519.SH'],
        cachePolicy: 'reuse-fresh',
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(providerCalls).toBe(1);
    expect(result.data.members[0]).toMatchObject({
      status: 'available',
      provider: 'fake-market',
      latestBarDate: freshBar.date,
    });
  });

  it('replay freshly fetched history without pre-cutoff revisions is explicitly vintage unavailable', async () => {
    const now = new Date('2026-08-12T09:00:00.000Z');
    const asOf = new Date('2026-08-10T00:00:00.000Z');
    const base = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(base, { limit: 1, observedAt: asOf });
    const historicalBar = bar(asOf);
    const ctx = {
      ...base,
      adapters: {
        ...base.adapters,
        market: {
          ...base.adapters.market,
          fetchDailyBars: () => Promise.resolve([historicalBar]),
        },
      },
    };

    const result = await prepareStrategyDataTool.execute(
      {
        strategyId: 'strategy-1',
        asOf,
        stockIds: ['600519.SH'],
        persistCurrentProjection: false,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.checkpoint.vintageStatus).toBe('unavailable');
    expect(
      await ctx.repos.dailyBar.listRevisions({ stockId: historicalBar.stockId, recordedAt: asOf }),
    ).toEqual([]);
  });

  it('same-date revision with different OHLCV is vintage unavailable', async () => {
    const now = new Date('2026-08-12T09:00:00.000Z');
    const asOf = new Date('2026-08-10T00:00:00.000Z');
    const base = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(base, { limit: 1, observedAt: asOf });
    const fetchedBar = bar(asOf);
    const priorBar = { ...fetchedBar, close: money(9.5), high: money(10.5) };
    await base.repos.dailyBar.saveRevisions([
      revisionFor(priorBar, new Date('2026-08-09T00:00:00.000Z')),
    ]);
    const ctx = {
      ...base,
      adapters: {
        ...base.adapters,
        market: {
          ...base.adapters.market,
          fetchDailyBars: () => Promise.resolve([fetchedBar]),
        },
      },
    };

    const result = await prepareStrategyDataTool.execute(
      {
        strategyId: 'strategy-1',
        asOf,
        stockIds: ['600519.SH'],
        persistCurrentProjection: false,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.checkpoint.vintageStatus).toBe('unavailable');
  });

  it('provider timeout is persisted as a stable error kind', async () => {
    const now = new Date('2026-08-12T09:00:00.000Z');
    const base = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(base, { limit: 1, observedAt: now });
    const ctx = {
      ...base,
      adapters: {
        ...base.adapters,
        market: {
          ...base.adapters.market,
          fetchDailyBars: () => new Promise<DailyBar[]>(() => {}),
        },
      },
    };
    const result = await prepareStrategyDataTool.execute(
      {
        strategyId: 'strategy-1',
        asOf: now,
        stockIds: ['600519.SH'],
        maxRetries: 0,
        requestTimeoutMs: 500,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.members[0]?.errorKind).toBe('provider_timeout');
    expect(result.data.checkpoint.providerStatuses[0]?.errorKinds).toEqual(['provider_timeout']);
  });
});
