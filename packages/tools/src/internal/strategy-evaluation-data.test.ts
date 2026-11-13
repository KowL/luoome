import { type DailyBar, money } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import {
  createLiveStrategyEvaluationDataAdapter,
  createLocalStrategyEvaluationDataAdapter,
} from './strategy-evaluation-data.js';

const bar = (date: string, close: number, source = 'fixture'): DailyBar => ({
  stockId: '600519.SH',
  date: new Date(`${date}T00:00:00.000Z`),
  open: money(10),
  high: money(12),
  low: money(9),
  close: money(close),
  volume: 1_000_000,
  adjustment: 'qfq',
  source,
});

describe('StrategyEvaluationData adapters', () => {
  it('live adapter owns bounded quote preload, external reads, and provider audit', async () => {
    const now = new Date('2026-08-12T07:00:00.000Z');
    const ctx = await buildTestContext({ clock: () => now });
    const adapter = createLiveStrategyEvaluationDataAdapter(ctx);

    const quotes = await adapter.preloadQuotes(['600519.SH'], 1);
    expect(quotes.get('600519.SH')?.stockId).toBe('600519.SH');

    const request = {
      stockIds: ['600519.SH'],
      dataAsOf: now,
      fetchedAt: now,
      lookback: 30,
      needsQuote: true,
      needsDailyBars: true,
      concurrency: 1,
    } as const;
    const batch = await adapter.load(request);
    const audit = adapter.audit(request, batch);

    expect(batch.failures).toEqual([]);
    expect(batch.prepared).toHaveLength(1);
    expect(batch.prepared[0]?.quote?.stockId).toBe('600519.SH');
    expect(batch.prepared[0]?.bars.length).toBeGreaterThan(0);
    expect(audit.providerStatuses.map((status) => status.provider)).toEqual([
      ctx.adapters.market.name,
      `${ctx.adapters.market.name}:daily-bars`,
    ]);
    expect(audit.providerCoverage.map((coverage) => coverage.capability)).toEqual([
      'quote',
      'daily-bars',
    ]);
  });

  it('local adapter 取 dataAsOf 之前的最新本地日线', async () => {
    const now = new Date('2026-08-12T07:00:00.000Z');
    const ctx = await buildTestContext({ clock: () => now });
    await ctx.repos.dailyBar.saveMany([
      bar('2026-08-09', 10, 'first'),
      bar('2026-08-10', 12, 'later'),
    ]);
    const adapter = createLocalStrategyEvaluationDataAdapter({ ctx });
    const request = {
      stockIds: ['600519.SH'],
      dataAsOf: new Date('2026-08-09T23:59:59.000Z'),
      fetchedAt: now,
      lookback: 30,
      needsQuote: true,
      needsDailyBars: true,
      concurrency: 1,
    } as const;

    const batch = await adapter.load(request);
    const audit = adapter.audit(request, batch);

    expect(batch.failures).toEqual([]);
    expect(batch.prepared[0]?.bars.at(-1)?.close).toBe(money(10));
    expect(batch.prepared[0]?.quote?.source).toBe('first');
    expect(audit.providerStatuses).toEqual([{ provider: 'local:daily-bars', ok: true }]);
    expect(audit.providerCoverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability: 'quote', freshness: 'stale', succeeded: 1 }),
        expect.objectContaining({ capability: 'daily-bars', freshness: 'stale', succeeded: 1 }),
      ]),
    );
  });
});
