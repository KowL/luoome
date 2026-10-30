import { describe, expect, it } from 'vitest';
import type { SignalObservation } from '../entity/signal-observation.js';
import {
  aggregateSignalObservationStats,
  assertSignalObservationVintageHomogeneity,
  countSignalObservationVintages,
  deduplicateSignalObservations,
  SIGNAL_OBSERVATION_SAMPLE_UNIT,
  signalObservationVintageOf,
} from './observation-stats.js';

const observation = (
  id: string,
  status: SignalObservation['status'],
  overrides: Partial<SignalObservation> = {},
): SignalObservation => ({
  id,
  sourceKind: 'strategy-signal',
  sourceId: `signal-${id}`,
  stockId: '600519.SH',
  baselinePrice: 100,
  baselineAt: new Date('2026-08-10T00:00:00.000Z'),
  horizon: 't1',
  vintage: 'pit',
  benchmarkStatus: 'unavailable',
  status,
  provenance: {
    provider: 'sina',
    observedAt: new Date('2026-08-10T00:00:00.000Z'),
    fetchedAt: new Date('2026-08-10T01:00:00.000Z'),
    freshness: 'fresh',
  },
  ...(status === 'complete'
    ? {
        closePrice: 105,
        returnPct: 0.05,
        maxFavorableExcursionPct: 0.06,
        maxAdverseExcursionPct: -0.01,
        observedAt: new Date('2026-08-11T00:00:00.000Z'),
      }
    : {}),
  ...(status === 'unavailable' ? { unavailableReason: 'missing' } : {}),
  ...overrides,
});

describe('signal observation descriptive samples', () => {
  it('按股票-交易日-周期去重，并优先保留 complete 事实', () => {
    const duplicatePending = observation('pending', 'pending');
    const complete = observation('complete', 'complete');
    const anotherDay = observation('another-day', 'complete', {
      baselineAt: new Date('2026-08-11T00:00:00.000Z'),
      sourceId: 'signal-another-day',
    });

    expect(deduplicateSignalObservations([duplicatePending, complete, anotherDay])).toEqual([
      complete,
      anotherDay,
    ]);
    expect(aggregateSignalObservationStats([duplicatePending, complete, anotherDay])).toEqual([
      expect.objectContaining({
        group: 'all',
        horizon: 't1',
        total: 2,
        complete: 2,
        uniqueStocks: 1,
        observationIds: ['another-day', 'complete'],
      }),
    ]);
  });

  it('同一 observation 在不同分组中各自保持可追溯样本，不把缺失 benchmark 当收益 0', () => {
    const first = observation('first', 'complete', { returnPct: 0.1 });
    const second = observation('second', 'complete', {
      stockId: '000001.SZ',
      returnPct: -0.1,
    });
    const stats = aggregateSignalObservationStats([first, second], (row) =>
      row.stockId === '600519.SH' ? 'a' : 'b',
    );

    expect(stats).toHaveLength(2);
    expect(stats.every((item) => item.total === 1 && item.complete === 1)).toBe(true);
    expect(stats.every((item) => item.averageBenchmarkReturnPct === undefined)).toBe(true);
    expect(SIGNAL_OBSERVATION_SAMPLE_UNIT).toBe('stock-day-horizon');
  });
});

describe('signal observation vintage 混算守卫', () => {
  it('统计 vintage 计数与出现顺序', () => {
    const rows = [
      observation('pit', 'complete'),
      observation('legacy', 'complete', { vintage: 'legacy' }),
      observation('legacy-2', 'pending', { vintage: 'legacy' }),
    ];
    expect(countSignalObservationVintages(rows)).toEqual({ pit: 1, restated: 0, legacy: 2 });
    expect(signalObservationVintageOf(rows)).toBe('mixed');
    expect(() => assertSignalObservationVintageHomogeneity(rows)).toThrow(/不得混合 vintage/);
  });

  it('单一归组时守卫放行，空集返回 undefined', () => {
    const rows = [observation('pit', 'complete'), observation('pit-2', 'pending')];
    expect(signalObservationVintageOf(rows)).toBe('pit');
    expect(() => assertSignalObservationVintageHomogeneity(rows)).not.toThrow();
    expect(signalObservationVintageOf([])).toBeUndefined();
  });
});
