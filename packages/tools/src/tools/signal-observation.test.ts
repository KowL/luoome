import { money, type SignalObservation } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import {
  completeStrategyObservationsTool,
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
});
