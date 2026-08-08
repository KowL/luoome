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
      scanned: 1,
      completed: 1,
      pending: 0,
    });
    expect(await ctx.repos.signalObservation.findById(observation.id)).toMatchObject({
      status: 'complete',
      benchmarkStatus: 'unavailable',
    });
  });
});
