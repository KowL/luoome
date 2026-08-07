import { describe, expect, it } from 'vitest';

import {
  assertSignalObservationInvariants,
  SignalObservationSchema,
} from './signal-observation.js';

describe('SignalObservation', () => {
  it('accepts StrategySignal as the current strategy observation source', () => {
    expect(
      SignalObservationSchema.parse({
        id: 'signal-observation:strategy-signal:run-1:entry:stock-1:t1',
        sourceKind: 'strategy-signal',
        sourceId: 'run-1:entry:stock-1',
        stockId: 'stock-1',
        baselinePrice: 10,
        baselineAt: new Date('2026-01-02T00:00:00Z'),
        horizon: 't1',
        benchmarkStatus: 'unavailable',
        status: 'pending',
        provenance: {
          provider: 'quote',
          observedAt: new Date('2026-01-02T00:00:00Z'),
          fetchedAt: new Date('2026-01-02T00:01:00Z'),
          freshness: 'unknown',
        },
      }).sourceKind,
    ).toBe('strategy-signal');
  });

  it('requires a factual baseline and full outcome before completion', () => {
    const observation = SignalObservationSchema.parse({
      id: 'signal-observation:tactic-signal:breakout:000001:1:t1',
      sourceKind: 'tactic-signal',
      sourceId: 'breakout:000001:1',
      stockId: '000001',
      baselinePrice: 10,
      baselineAt: new Date('2026-01-02T00:00:00Z'),
      horizon: 't1',
      closePrice: 10.5,
      returnPct: 0.05,
      maxFavorableExcursionPct: 0.08,
      maxAdverseExcursionPct: -0.02,
      benchmarkStatus: 'unavailable',
      status: 'complete',
      observedAt: new Date('2026-01-05T00:00:00Z'),
      provenance: {
        provider: 'daily-bar',
        observedAt: new Date('2026-01-05T00:00:00Z'),
        fetchedAt: new Date('2026-01-05T01:00:00Z'),
        freshness: 'fresh',
      },
    });
    expect(() => assertSignalObservationInvariants(observation)).not.toThrow();
    expect(() =>
      assertSignalObservationInvariants({ ...observation, closePrice: undefined }),
    ).toThrow('完整的后续表现');
  });
});
