import type { SignalObservation } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { completeStrategyObservationsWorkflow } from './complete-strategy-observations.js';

describe('complete-strategy-observations workflow', () => {
  it('先同步 qfq 日线，再完成到期 StrategySignal 观察', async () => {
    const now = new Date('2026-08-10T08:00:00.000Z');
    const ctx = await buildTestContext({ clock: () => now });
    const baselineAt = new Date('2026-07-30T08:00:00.000Z');
    const observation: SignalObservation = {
      id: 'signal-observation:strategy-signal:s1:t1',
      sourceKind: 'strategy-signal',
      sourceId: 's1',
      stockId: '600519.SH',
      baselinePrice: 10,
      baselineAt,
      horizon: 't1',
      benchmarkStatus: 'unavailable',
      status: 'pending',
      provenance: {
        provider: 'quote',
        observedAt: baselineAt,
        fetchedAt: baselineAt,
        freshness: 'unknown',
      },
    };
    await ctx.repos.signalObservation.save(observation);
    const result = await completeStrategyObservationsWorkflow.run({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      requestedStocks: 1,
      syncedStocks: 1,
      failedStocks: 0,
      benchmarkDataVersion: '000300.SH:qfq:daily:v1',
      benchmarkSyncStatus: 'succeeded',
      benchmarkSynced: 1,
      benchmarkFailed: 0,
      scanned: 1,
      completed: 1,
      pending: 0,
    });
    expect(await ctx.repos.signalObservation.findById(observation.id)).toMatchObject({
      status: 'complete',
      benchmarkStatus: 'complete',
    });
  });

  it('基准同步失败时保留个股事实，但明确 benchmark unavailable', async () => {
    const now = new Date('2026-08-10T08:00:00.000Z');
    const base = await buildTestContext({ clock: () => now });
    const ctx = {
      ...base,
      adapters: {
        ...base.adapters,
        market: {
          ...base.adapters.market,
          fetchDailyBars: async (
            stockId: string,
            range: Parameters<typeof base.adapters.market.fetchDailyBars>[1],
          ) => {
            if (stockId === '000300.SH') throw new Error('benchmark provider unavailable');
            return base.adapters.market.fetchDailyBars(stockId, range);
          },
        },
      },
    };
    const observation: SignalObservation = {
      id: 'signal-observation:strategy-signal:s2:t1',
      sourceKind: 'strategy-signal',
      sourceId: 's2',
      stockId: '600519.SH',
      baselinePrice: 10,
      baselineAt: new Date('2026-07-30T08:00:00.000Z'),
      horizon: 't1',
      benchmarkStatus: 'unavailable',
      status: 'pending',
      provenance: {
        provider: 'quote',
        observedAt: new Date('2026-07-30T08:00:00.000Z'),
        fetchedAt: new Date('2026-07-30T08:00:00.000Z'),
        freshness: 'unknown',
      },
    };
    await ctx.repos.signalObservation.save(observation);
    const result = await completeStrategyObservationsWorkflow.run({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      benchmarkDataVersion: '000300.SH:qfq:daily:v1',
      benchmarkSyncStatus: 'failed',
      benchmarkSynced: 0,
      benchmarkFailed: 1,
      completed: 1,
    });
    expect(await ctx.repos.signalObservation.findById(observation.id)).toMatchObject({
      status: 'complete',
      benchmarkStatus: 'unavailable',
    });
  });
});
