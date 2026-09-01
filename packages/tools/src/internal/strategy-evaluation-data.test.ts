import { createHash } from 'node:crypto';
import { type DailyBarRevision, money } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import {
  createCheckpointStrategyEvaluationDataAdapter,
  createLiveStrategyEvaluationDataAdapter,
} from './strategy-evaluation-data.js';

const revision = (recordedAt: Date, close: number, source = 'fixture'): DailyBarRevision => ({
  stockId: '600519.SH',
  date: new Date('2026-08-10T00:00:00.000Z'),
  contentHash: createHash('sha256').update(`${recordedAt.toISOString()}:${close}`).digest('hex'),
  open: money(10),
  high: money(12),
  low: money(9),
  close: money(close),
  volume: 1_000_000,
  source,
  recordedAt,
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

  it('checkpoint adapter reconstructs the point-in-time revision and never reads live market data', async () => {
    const now = new Date('2026-08-12T07:00:00.000Z');
    const ctx = await buildTestContext({ clock: () => now });
    const firstRecordedAt = new Date('2026-08-10T08:00:00.000Z');
    const laterRecordedAt = new Date('2026-08-11T08:00:00.000Z');
    await ctx.repos.dailyBar.saveRevisions([
      revision(firstRecordedAt, 10, 'first-vintage'),
      revision(laterRecordedAt, 99, 'later-vintage'),
    ]);
    const adapter = createCheckpointStrategyEvaluationDataAdapter({
      ctx,
      mode: 'replay',
      members: [],
      revisionCutoff: new Date('2026-08-10T12:00:00.000Z'),
    });
    const request = {
      stockIds: ['600519.SH'],
      dataAsOf: new Date('2026-08-10T23:59:59.000Z'),
      fetchedAt: now,
      lookback: 30,
      needsQuote: true,
      needsDailyBars: true,
      concurrency: 1,
    } as const;

    const batch = await adapter.load(request);
    const audit = adapter.audit(request, batch);

    expect(batch.failures).toEqual([]);
    expect(batch.prepared[0]?.bars[0]?.close).toBe(money(10));
    expect(batch.prepared[0]?.quote?.close).toBe(money(10));
    expect(batch.prepared[0]?.quote?.source).toBe('first-vintage');
    expect(audit.providerStatuses).toEqual([{ provider: 'local:daily-bars', ok: false }]);
    expect(audit.providerCoverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability: 'quote', freshness: 'stale', succeeded: 1 }),
        expect.objectContaining({ capability: 'daily-bars', freshness: 'stale', succeeded: 1 }),
      ]),
    );
  });
});
