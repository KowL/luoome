import { describe, expect, it } from 'vitest';

import {
  assertSignalObservationInvariants,
  SignalObservationSchema,
} from './signal-observation.js';

describe('SignalObservation', () => {
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
