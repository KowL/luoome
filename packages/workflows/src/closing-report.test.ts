import type { AShareSentimentManagerLike, AShareSentimentSnapshot } from '@luoome/core';
import { createWatchlistTool, syncWatchlistSourceTool } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { closingReportWorkflow } from './closing-report.js';

const now = new Date('2026-07-27T10:00:00.000Z');
const marketAsOf = new Date('2026-07-27T07:00:00.000Z');

const snapshot = (): AShareSentimentSnapshot => ({
  date: '2026-07-27',
  coverage: 'CN_A_SHARES_SH_SZ',
  dataAsOf: marketAsOf,
  indexes: {
    status: 'complete',
    provenance: [
      {
        provider: 'fixture-index',
        observedAt: marketAsOf,
        fetchedAt: now,
        freshness: 'fresh',
      },
    ],
    warnings: [],
    values: [],
  },
  breadth: {
    status: 'unavailable',
    provenance: [
      {
        provider: 'fixture-breadth',
        observedAt: now,
        fetchedAt: now,
        freshness: 'unavailable',
        errorKind: 'incomplete_coverage',
      },
    ],
    warnings: ['breadth unavailable'],
  },
  limitUp: {
    status: 'complete',
    provenance: [
      {
        provider: 'fixture-limit-up',
        observedAt: marketAsOf,
        fetchedAt: now,
        freshness: 'fresh',
      },
    ],
    warnings: [],
    value: {
      sealedCount: 8,
      brokenCount: 2,
      brokenRate: 0.2,
      maxLadderLevel: 3,
      totalSealAmount: 600_000_000,
      boardDistribution: { '1': 6, '2': 1, '3': 1 },
      leaders: [],
    },
  },
  themes: {
    status: 'partial',
    provenance: [
      {
        provider: 'fixture-limit-up',
        observedAt: marketAsOf,
        fetchedAt: now,
        freshness: 'fresh',
      },
    ],
    warnings: ['concept themes unavailable'],
    value: { industries: [], concepts: [] },
  },
});

describe('closing-report workflow', () => {
  it('使用当日市场证据并保存六个收盘事实 section', async () => {
    const requestedDates: string[] = [];
    const manager: AShareSentimentManagerLike = {
      status: () => [],
      fetch: async (input) => {
        requestedDates.push(input.date);
        return { ok: true, data: snapshot() };
      },
    };
    const ctx = await buildTestContext({ clock: () => now, ashareSentiment: manager });

    const result = await closingReportWorkflow.run({ date: '2026-07-27', notify: false }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(requestedDates).toEqual(['2026-07-27']);
    expect(result.data.report).toMatchObject({
      kind: 'closing',
      periodStart: '2026-07-27',
      periodEnd: '2026-07-27',
      status: 'partial',
      dataAsOf: marketAsOf,
    });
    expect(result.data.report.sections.map((section) => section.key)).toEqual([
      'market-pulse',
      'account-performance',
      'important-triggers',
      'group-changes',
      'advice-expiry',
      'next-events',
    ]);
    expect(
      JSON.stringify(result.data.report.sections.flatMap((section) => section.blocks)),
    ).not.toContain('买入');
  });

  it('从真实 Watchlist 变化工具生成分组变化表', async () => {
    const ctx = await buildTestContext({
      clock: () => now,
      ashareSentiment: { status: () => [], fetch: async () => ({ ok: true, data: snapshot() }) },
    });
    const created = await createWatchlistTool.execute(
      {
        id: 'closing-watch',
        name: '收盘观察',
        kind: 'strategy',
        membershipPolicy: 'synced',
      },
      ctx,
    );
    expect(created.ok).toBe(true);
    const synced = await syncWatchlistSourceTool.execute(
      {
        watchlistId: 'closing-watch',
        sourceKind: 'ai',
        sourceKey: 'ai:closing',
        status: 'complete',
        candidates: [{ stockId: '600519.SH', reason: '收盘入选', evidence: ['fixture'] }],
      },
      ctx,
    );
    expect(synced.ok).toBe(true);

    const result = await closingReportWorkflow.run({ date: '2026-07-27', notify: false }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const groupChanges = result.data.report.sections.find(
      (section) => section.key === 'group-changes',
    );
    expect(groupChanges).toMatchObject({ status: 'complete', missingDimensions: [] });
    expect(groupChanges?.blocks[0]).toMatchObject({
      kind: 'table',
      rows: [
        { watchlist: '收盘观察', entered: 1, exited: 0, unchanged: 0, runs: 1, status: 'complete' },
      ],
    });
  });
});
