import type { SignalObservation, StrategySignal } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { collectStrategyObservationEvidence } from './strategy-observation-evidence.js';

const SIGNAL_DAY = new Date('2026-08-03T08:00:00.000Z');

const signal = (id: string, stockId = '600519.SH'): StrategySignal => ({
  id,
  strategyId: 'strategy-1',
  strategyVersionId: 'strategy-1-v1',
  runId: 'run-1',
  ruleId: 'entry',
  stockId,
  ts: SIGNAL_DAY,
  score: 80,
  direction: 'bullish',
  evidence: ['signal-fact'],
  evaluationSnapshot: {},
});

const observation = (
  id: string,
  sourceId: string,
  overrides: Partial<SignalObservation> = {},
): SignalObservation => ({
  id,
  sourceKind: 'strategy-signal',
  sourceId,
  stockId: '600519.SH',
  baselinePrice: 100,
  baselineAt: SIGNAL_DAY,
  horizon: 't1',
  closePrice: 105,
  returnPct: 0.05,
  maxFavorableExcursionPct: 0.08,
  maxAdverseExcursionPct: -0.02,
  benchmarkStatus: 'complete',
  benchmarkReturnPct: 0.01,
  status: 'complete',
  provenance: {
    provider: 'fixture',
    observedAt: new Date('2026-08-04T08:00:00.000Z'),
    fetchedAt: new Date('2026-08-04T09:00:00.000Z'),
    freshness: 'fresh',
  },
  observedAt: new Date('2026-08-04T08:00:00.000Z'),
  ...overrides,
});

describe('StrategyObservationEvidence', () => {
  it('统一 active horizon、关联校验、stock-day-horizon 去重与 expected missing', async () => {
    const ctx = await buildTestContext();
    const signals = [signal('signal-1'), signal('signal-2', '002594.SZ')];
    await ctx.repos.signalObservation.save(observation('complete', 'signal-1'));
    await ctx.repos.signalObservation.save(
      observation('pending-duplicate', 'signal-1', {
        status: 'pending',
        closePrice: undefined,
        returnPct: undefined,
        maxFavorableExcursionPct: undefined,
        maxAdverseExcursionPct: undefined,
        benchmarkReturnPct: undefined,
        benchmarkStatus: 'unavailable',
        observedAt: undefined,
      }),
    );
    await ctx.repos.signalObservation.save(
      observation('wrong-stock', 'signal-2', { stockId: '300750.SZ' }),
    );
    await ctx.repos.signalObservation.save(
      observation('retired-horizon', 'signal-1', { horizon: 't20' }),
    );

    const evidence = await collectStrategyObservationEvidence({
      ctx,
      signals,
      horizons: ['t1', 't3', 't5'],
      sourceLabel: 'test',
    });

    expect(evidence.observations.map((item) => item.id)).toEqual(['complete']);
    expect(evidence.sampledObservations.map((item) => item.id)).toEqual(['complete']);
    expect(evidence.observationLinks).toEqual([
      expect.objectContaining({
        observationId: 'complete',
        signalId: 'signal-1',
        stockId: '600519.SH',
        horizon: 't1',
      }),
    ]);
    expect(evidence.missingByHorizon).toEqual({ t1: 1, t3: 2, t5: 2 });
    expect(evidence.truncated).toBe(false);
    expect(evidence.limitations.join(' ')).toContain('wrong-stock');
    expect(evidence.limitations.join(' ')).toContain('T+20');
  });

  it('按 source id 批量读取时不会受通用 observation limit 影响，并显式报告 truncation', async () => {
    const ctx = await buildTestContext();
    const signals = Array.from({ length: 1_005 }, (_, index) =>
      signal(`signal-${index}`, index % 2 === 0 ? '600519.SH' : '002594.SZ'),
    );
    for (const [index, item] of signals.entries()) {
      const baselineAt = new Date(SIGNAL_DAY.getTime() + index * 86_400_000);
      await ctx.repos.signalObservation.save(
        observation(`observation-${index}`, item.id, {
          stockId: item.stockId,
          baselineAt,
        }),
      );
    }

    const evidence = await collectStrategyObservationEvidence({
      ctx,
      signals,
      horizons: ['t1'],
      maxObservations: 1_000,
    });

    expect(evidence.rawObservationCount).toBe(1_005);
    expect(evidence.sampledObservationCount).toBe(1_005);
    expect(evidence.observations).toHaveLength(1_000);
    expect(evidence.truncated).toBe(true);
    expect(evidence.limitations.join(' ')).toContain('截断');
  });
});
