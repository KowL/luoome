import { money, type SignalObservation } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import {
  completeStrategyObservationsTool,
  getSignalObservationStatsTool,
  listPendingStrategyObservationsTool,
} from './signal-observation.js';

const BASELINE = new Date('2026-08-03T08:00:00.000Z');
const NOW = new Date('2026-08-10T08:00:00.000Z');

const pending = (horizon: SignalObservation['horizon']): SignalObservation => ({
  id: `signal-observation:strategy-signal:s1:${horizon}`,
  sourceKind: 'strategy-signal',
  sourceId: 's1',
  stockId: '600519.SH',
  baselinePrice: 10,
  baselineAt: BASELINE,
  horizon,
  benchmarkStatus: 'unavailable',
  status: 'pending',
  provenance: {
    provider: 'quote',
    observedAt: BASELINE,
    fetchedAt: BASELINE,
    freshness: 'unknown',
  },
});

const observed = (id: string, overrides: Partial<SignalObservation> = {}): SignalObservation => ({
  id,
  sourceKind: 'strategy-signal',
  sourceId: `source-${id}`,
  stockId: '600519.SH',
  baselinePrice: 10,
  baselineAt: BASELINE,
  horizon: 't1',
  closePrice: 11,
  returnPct: 0.1,
  maxFavorableExcursionPct: 0.2,
  maxAdverseExcursionPct: -0.05,
  benchmarkReturnPct: 0.02,
  benchmarkStatus: 'complete',
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

describe('strategy signal observation tools', () => {
  it('列出 pending 并仅完成日线样本已足够的 horizon', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await ctx.repos.signalObservation.save(pending('t3'));
    await ctx.repos.signalObservation.save(pending('t5'));
    const dates = ['2026-08-04', '2026-08-05', '2026-08-06'];
    await ctx.repos.dailyBar.saveMany(
      dates.map((date, index) => ({
        stockId: '600519.SH',
        date: new Date(`${date}T00:00:00Z`),
        open: money(10),
        high: money(11 + index),
        low: money(9),
        close: money(10.5 + index),
        volume: 100,
        adjustment: 'qfq' as const,
        source: 'fixture',
      })),
    );
    const listed = await listPendingStrategyObservationsTool.execute({}, ctx);
    expect(listed).toMatchObject({
      ok: true,
      data: {
        stockIds: ['600519.SH'],
        observations: [{ status: 'pending' }, { status: 'pending' }],
      },
    });
    const result = await completeStrategyObservationsTool.execute({}, ctx);
    expect(result).toMatchObject({
      ok: true,
      data: {
        scanned: 2,
        completed: 1,
        pending: 1,
        byHorizon: {
          t3: { scanned: 1, completed: 1, pending: 0 },
          t5: { scanned: 1, completed: 0, pending: 1 },
          t20: { scanned: 0, completed: 0, pending: 0 },
        },
      },
    });
    expect(await ctx.repos.signalObservation.findById(pending('t3').id)).toMatchObject({
      status: 'complete',
      observedAt: new Date('2026-08-06T00:00:00.000Z'),
    });
    expect(await ctx.repos.signalObservation.findById(pending('t5').id)).toMatchObject({
      status: 'pending',
    });
  });

  it('按 stock-day-horizon 去重并返回描述性统计与缺失限制', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await ctx.repos.signalObservation.save(observed('complete-1'));
    await ctx.repos.signalObservation.save(
      observed('pending-duplicate', {
        status: 'pending',
        closePrice: undefined,
        returnPct: undefined,
      }),
    );
    await ctx.repos.signalObservation.save(
      observed('pending-2', {
        stockId: '002594.SZ',
        baselineAt: new Date('2026-08-04T08:00:00.000Z'),
        status: 'pending',
        closePrice: undefined,
        returnPct: undefined,
      }),
    );
    await ctx.repos.signalObservation.save(
      observed('watch-trigger-outside-filter', {
        sourceKind: 'watch-trigger',
        horizon: 't3',
        baselineAt: new Date('2026-08-06T08:00:00.000Z'),
      }),
    );

    const result = await getSignalObservationStatsTool.execute(
      {
        since: '2026-08-03T00:00:00.000Z',
        until: '2026-08-05T23:59:59.000Z',
        sourceKind: 'strategy-signal',
        horizons: ['t1'],
        limit: 20,
      },
      ctx,
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        sampleUnit: 'stock-day-horizon',
        total: 2,
        complete: 1,
        missingRate: 0.5,
        observedAsOf: new Date('2026-08-04T08:00:00.000Z'),
        stats: [
          expect.objectContaining({
            horizon: 't1',
            sampleUnit: 'stock-day-horizon',
            total: 2,
            complete: 1,
            pending: 1,
            unavailable: 0,
            uniqueStocks: 2,
            missingRate: 0.5,
            averageReturnPct: 0.1,
            benchmarkStatus: 'complete',
          }),
        ],
      },
    });
    if (!result.ok) return;
    expect(result.data.stats[0]?.observationIds).toEqual(['complete-1', 'pending-2']);
    expect(result.data.limitations.join(' ')).toContain('描述性统计');
    expect(result.data.limitations.join(' ')).toContain('胜率承诺');
    expect(result.data.limitations.join(' ')).toContain('missingRate');
  });

  it('拒绝反向时间范围，且不把其他 horizon/source 混入统计', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await ctx.repos.signalObservation.save(observed('strategy-t1'));
    await ctx.repos.signalObservation.save(
      observed('strategy-t3', { horizon: 't3', baselineAt: new Date('2026-08-04T08:00:00.000Z') }),
    );
    await ctx.repos.signalObservation.save(
      observed('watch-t1', {
        sourceKind: 'watch-trigger',
        baselineAt: new Date('2026-08-04T08:00:00.000Z'),
      }),
    );

    const filtered = await getSignalObservationStatsTool.execute(
      {
        since: '2026-08-03T00:00:00.000Z',
        until: '2026-08-03T23:59:59.000Z',
        sourceKind: 'strategy-signal',
        horizons: ['t1'],
      },
      ctx,
    );
    expect(filtered).toMatchObject({
      ok: true,
      data: { total: 1, stats: [expect.objectContaining({ horizon: 't1', total: 1 })] },
    });

    const invalid = await getSignalObservationStatsTool.execute(
      { since: '2026-08-05T00:00:00.000Z', until: '2026-08-03T00:00:00.000Z' },
      ctx,
    );
    expect(invalid).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
  });
});
