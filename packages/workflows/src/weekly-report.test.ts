import type { AShareSentimentManagerLike, AShareSentimentSnapshot } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { weeklyReportWorkflow } from './weekly-report.js';

const now = new Date('2026-07-31T11:00:00.000Z');

const snapshotFor = (date: string): AShareSentimentSnapshot => {
  const observedAt = new Date(`${date}T07:00:00.000Z`);
  return {
    date,
    coverage: 'CN_A_SHARES_SH_SZ',
    dataAsOf: observedAt,
    indexes: {
      status: 'complete',
      provenance: [
        {
          provider: 'fixture-index',
          observedAt,
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
          observedAt,
          fetchedAt: now,
          freshness: 'fresh',
        },
      ],
      warnings: [],
      value: {
        sealedCount: 10,
        brokenCount: 2,
        brokenRate: 1 / 6,
        maxLadderLevel: 3,
        totalSealAmount: 500_000_000,
        boardDistribution: { '1': 8, '2': 1, '3': 1 },
        leaders: [],
      },
    },
    themes: {
      status: 'partial',
      provenance: [
        {
          provider: 'fixture-limit-up',
          observedAt,
          fetchedAt: now,
          freshness: 'fresh',
        },
      ],
      warnings: ['concept themes unavailable'],
      value: { industries: [], concepts: [] },
    },
  };
};

describe('weekly-report workflow', () => {
  it('按本周真实交易日生成趋势，不把自然日周末纳入周期', async () => {
    const requestedDates: string[] = [];
    const manager: AShareSentimentManagerLike = {
      fetch: async (input) => {
        requestedDates.push(input.date);
        return { ok: true, data: snapshotFor(input.date) };
      },
    };
    const ctx = await buildTestContext({ clock: () => now, ashareSentiment: manager });

    const result = await weeklyReportWorkflow.run({ periodEnd: '2026-07-31', notify: false }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(requestedDates).toEqual([
      '2026-07-27',
      '2026-07-28',
      '2026-07-29',
      '2026-07-30',
      '2026-07-31',
    ]);
    expect(result.data.report).toMatchObject({
      kind: 'weekly',
      periodStart: '2026-07-27',
      periodEnd: '2026-07-31',
      status: 'partial',
      dataAsOf: new Date('2026-07-27T07:00:00.000Z'),
    });
    expect(result.data.report.sections.map((section) => section.key)).toEqual([
      'market-week',
      'account-week',
      'alert-feedback',
      'signal-outcomes',
      'research-changes',
      'next-week-events',
    ]);
    const marketWeek = result.data.report.sections.find((section) => section.key === 'market-week');
    const table = marketWeek?.blocks.find((block) => block.kind === 'table');
    // 表格列无 unit 元数据，炸板率在构建期已格式化为百分比字符串
    expect(table?.kind === 'table' ? table.rows[0]?.brokenRate : undefined).toBe('16.7%');
  });
});
