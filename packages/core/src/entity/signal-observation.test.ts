import { describe, expect, it } from 'vitest';

import { money } from '../types/branded.js';
import {
  ACTIVE_SIGNAL_OBSERVATION_HORIZONS,
  ActiveSignalObservationHorizonSchema,
  assertSignalObservationInvariants,
  completeSignalObservationFromDailyBars,
  SignalObservationHorizonSchema,
  SignalObservationSchema,
} from './signal-observation.js';

describe('SignalObservation', () => {
  it('active observation horizons stop at T+5 while legacy T+20 remains decodable', () => {
    expect(ACTIVE_SIGNAL_OBSERVATION_HORIZONS).toEqual(['t1', 't3', 't5']);
    expect(ActiveSignalObservationHorizonSchema.safeParse('t20').success).toBe(false);
    expect(SignalObservationHorizonSchema.parse('t20')).toBe('t20');
  });

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

  it('按 baseline 后第 N 根 qfq 日线计算 return/MFE/MAE，样本不足保持 pending', () => {
    const pending = SignalObservationSchema.parse({
      id: 'signal-observation:strategy-signal:s1:t3',
      sourceKind: 'strategy-signal',
      sourceId: 's1',
      stockId: '600519.SH',
      baselinePrice: 10,
      baselineAt: new Date('2026-08-03T08:00:00Z'),
      horizon: 't3',
      benchmarkStatus: 'unavailable',
      status: 'pending',
      provenance: {
        provider: 'quote',
        observedAt: new Date('2026-08-03T08:00:00Z'),
        fetchedAt: new Date('2026-08-03T08:00:01Z'),
        freshness: 'unknown',
      },
    });
    const bars = [
      ['2026-08-04', 11, 9.5, 10.5],
      ['2026-08-05', 12, 9, 11],
      ['2026-08-06', 11.5, 10, 11.2],
    ].map(([date, high, low, close]) => ({
      stockId: '600519.SH',
      date: new Date(`${date}T00:00:00Z`),
      open: money(10),
      high: money(Number(high)),
      low: money(Number(low)),
      close: money(Number(close)),
      volume: 100,
      adjustment: 'qfq' as const,
      source: 'fixture',
    }));
    expect(completeSignalObservationFromDailyBars(pending, bars.slice(0, 2), new Date())).toEqual(
      pending,
    );
    const completed = completeSignalObservationFromDailyBars(
      pending,
      bars,
      new Date('2026-08-06T01:00:00Z'),
    );
    expect(completed).toMatchObject({
      status: 'complete',
      closePrice: 11.2,
      benchmarkStatus: 'unavailable',
      observedAt: new Date('2026-08-06T00:00:00Z'),
    });
    expect(completed.returnPct).toBeCloseTo(0.12);
    expect(completed.maxFavorableExcursionPct).toBeCloseTo(0.2);
    expect(completed.maxAdverseExcursionPct).toBeCloseTo(-0.1);
  });

  it('有明确版本的沪深 300 日线时计算 excess return，缺失时仍显式 unavailable', () => {
    const pending = SignalObservationSchema.parse({
      id: 'signal-observation:strategy-signal:s1:t1',
      sourceKind: 'strategy-signal',
      sourceId: 's1',
      stockId: '600519.SH',
      baselinePrice: 10,
      baselineAt: new Date('2026-08-03T08:00:00Z'),
      horizon: 't1',
      benchmarkStatus: 'unavailable',
      status: 'pending',
      provenance: {
        provider: 'quote',
        observedAt: new Date('2026-08-03T08:00:00Z'),
        fetchedAt: new Date('2026-08-03T08:00:01Z'),
        freshness: 'unknown',
      },
    });
    const stockBars = [{ date: '2026-08-04', close: 11 }].map(({ date, close }) => ({
      stockId: '600519.SH',
      date: new Date(`${date}T00:00:00Z`),
      open: money(10),
      high: money(11),
      low: money(9),
      close: money(close),
      volume: 100,
      adjustment: 'qfq' as const,
      source: 'fixture',
    }));
    const benchmarkBars = [
      ['2026-08-03', 100],
      ['2026-08-04', 102],
    ].map(([date, close]) => ({
      stockId: '000300.SH',
      date: new Date(`${date}T00:00:00Z`),
      open: money(Number(close)),
      high: money(Number(close)),
      low: money(Number(close)),
      close: money(Number(close)),
      volume: 100,
      adjustment: 'qfq' as const,
      source: 'benchmark-v1',
    }));
    const completed = completeSignalObservationFromDailyBars(
      pending,
      stockBars,
      new Date('2026-08-04T01:00:00Z'),
      { benchmarkBars },
    );
    expect(completed).toMatchObject({
      benchmarkStatus: 'complete',
      benchmarkReturnPct: 0.02,
    });
    expect(completed.returnPct).toBeCloseTo(0.1);
  });
});
