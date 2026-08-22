import {
  type AShareSentimentManagerLike,
  type AShareSentimentSnapshot,
  money,
  type SignalObservation,
} from '@luoome/core';
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

const completeSignalObservation = (): SignalObservation => ({
  id: 'weekly-signal-complete',
  sourceKind: 'strategy-signal',
  sourceId: 'weekly-strategy-signal',
  stockId: '600519.SH',
  baselinePrice: 100,
  baselineAt: new Date('2026-07-28T08:00:00.000Z'),
  horizon: 't1',
  closePrice: 110,
  returnPct: 0.1,
  maxFavorableExcursionPct: 0.12,
  maxAdverseExcursionPct: -0.02,
  benchmarkReturnPct: 0.02,
  benchmarkStatus: 'complete',
  status: 'complete',
  provenance: {
    provider: 'weekly-fixture',
    observedAt: new Date('2026-07-29T08:00:00.000Z'),
    fetchedAt: now,
    freshness: 'fresh',
  },
  observedAt: new Date('2026-07-29T08:00:00.000Z'),
});

const pendingSignalObservation = (): SignalObservation => ({
  id: 'weekly-signal-pending',
  sourceKind: 'strategy-signal',
  sourceId: 'weekly-strategy-signal-pending',
  stockId: '002594.SZ',
  baselinePrice: 50,
  baselineAt: new Date('2026-07-29T08:00:00.000Z'),
  horizon: 't1',
  benchmarkStatus: 'unavailable',
  status: 'pending',
  provenance: {
    provider: 'weekly-fixture',
    observedAt: new Date('2026-07-29T08:00:00.000Z'),
    fetchedAt: now,
    freshness: 'unknown',
  },
});

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
      'advice-outcomes',
      'trade-attribution',
      'behavior-patterns',
      'data-quality',
      'research-changes',
      'next-week-events',
    ]);
    const marketWeek = result.data.report.sections.find((section) => section.key === 'market-week');
    const table = marketWeek?.blocks.find((block) => block.kind === 'table');
    // 表格列无 unit 元数据，炸板率在构建期已格式化为百分比字符串
    expect(table?.kind === 'table' ? table.rows[0]?.brokenRate : undefined).toBe('16.7%');
    const accountWeek = result.data.report.sections.find(
      (section) => section.key === 'account-week',
    );
    const accountMetrics = accountWeek?.blocks.find((block) => block.kind === 'metrics');
    expect(
      accountWeek?.missingDimensions.some((item) => item.errorKind === 'not_implemented'),
    ).toBe(false);
    expect(
      accountMetrics?.kind === 'metrics' ? accountMetrics.items.map((item) => item.key) : [],
    ).toEqual(expect.arrayContaining(['periodStartValue', 'periodTwrPct', 'maxDrawdownPct']));
    const signalOutcomes = result.data.report.sections.find(
      (section) => section.key === 'signal-outcomes',
    );
    expect(signalOutcomes?.status).toBe('partial');
    expect(signalOutcomes?.missingDimensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: 'signal-outcomes.samples',
          errorKind: 'no_data',
        }),
      ]),
    );
    const signalMetrics = signalOutcomes?.blocks.find((block) => block.kind === 'metrics');
    expect(
      signalMetrics?.kind === 'metrics'
        ? signalMetrics.items.find((item) => item.key === 'missingRate')?.value
        : undefined,
    ).toBeNull();
    const adviceOutcomes = result.data.report.sections.find(
      (section) => section.key === 'advice-outcomes',
    );
    expect(adviceOutcomes?.status).toBe('partial');
    expect(adviceOutcomes?.missingDimensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: 'advice-outcomes.pending',
          errorKind: 'outcome_pending',
        }),
      ]),
    );
    const adviceMetrics = adviceOutcomes?.blocks.find((block) => block.kind === 'metrics');
    expect(
      adviceMetrics?.kind === 'metrics'
        ? adviceMetrics.items.find((item) => item.key === 'totalAdvices')?.value
        : undefined,
    ).toBe(2);
    expect(
      adviceMetrics?.kind === 'metrics'
        ? adviceMetrics.items.find((item) => item.key === 'outcomeMissingRate')?.value
        : undefined,
    ).toBe(1);
    const tradeAttribution = result.data.report.sections.find(
      (section) => section.key === 'trade-attribution',
    );
    expect(tradeAttribution?.status).toBe('partial');
    expect(tradeAttribution?.missingDimensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: 'trade-attribution.samples',
          errorKind: 'no_data',
        }),
      ]),
    );
    const tradeMetrics = tradeAttribution?.blocks.find((block) => block.kind === 'metrics');
    expect(
      tradeMetrics?.kind === 'metrics'
        ? tradeMetrics.items.find((item) => item.key === 'attributionRate')?.value
        : undefined,
    ).toBeNull();
    const behaviorPatterns = result.data.report.sections.find(
      (section) => section.key === 'behavior-patterns',
    );
    expect(behaviorPatterns?.status).toBe('partial');
    expect(behaviorPatterns?.missingDimensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: 'behavior-patterns.account-scope',
          errorKind: 'scope_unavailable',
        }),
      ]),
    );
    const dataQuality = result.data.report.sections.find(
      (section) => section.key === 'data-quality',
    );
    expect(dataQuality?.status).toBe('partial');
    expect(dataQuality?.missingDimensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: 'data-quality.signal-account-scope',
          errorKind: 'scope_unavailable',
        }),
      ]),
    );
    const researchChanges = result.data.report.sections.find(
      (section) => section.key === 'research-changes',
    );
    expect(researchChanges?.missingDimensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          errorKind: 'global_version_query_unavailable',
          reason: expect.stringContaining('可靠的全局研究版本查询能力'),
        }),
      ]),
    );
  });

  it('将 signal observation 和 Advice outcome 以描述性统计写入周报', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await ctx.repos.signalObservation.save(completeSignalObservation());
    await ctx.repos.signalObservation.save(pendingSignalObservation());
    const advices = await ctx.repos.advice.query({ includeExpired: true, limit: 500 });
    const [followed, ignored] = advices;
    if (followed === undefined || ignored === undefined) throw new Error('fixture advice missing');
    await ctx.repos.advice.recordOutcome(followed.id, {
      adviceId: followed.id,
      tradeIds: [],
      outcome: 'followed',
      pnl: money(100),
      benchmarkPnl: money(20),
      recordedAt: now,
    });
    await ctx.repos.advice.recordOutcome(ignored.id, {
      adviceId: ignored.id,
      tradeIds: [],
      outcome: 'ignored',
      recordedAt: now,
    });

    const result = await weeklyReportWorkflow.run({ periodEnd: '2026-07-31', notify: false }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const signal = result.data.report.sections.find((section) => section.key === 'signal-outcomes');
    expect(signal?.status).toBe('partial');
    const signalMetrics = signal?.blocks.find((block) => block.kind === 'metrics');
    expect(signalMetrics?.kind === 'metrics' ? signalMetrics.items : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'total', value: 2 }),
        expect.objectContaining({ key: 'complete', value: 1 }),
        expect.objectContaining({ key: 'missingRate', value: 0.5 }),
      ]),
    );
    const signalTable = signal?.blocks.find((block) => block.kind === 'table');
    expect(signalTable?.kind === 'table' ? signalTable.rows : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          horizon: 't1',
          averageReturnPct: 0.1,
          averageBenchmarkReturnPct: 0.02,
          averageExcessReturnPct: 0.08,
        }),
      ]),
    );
    expect(signal?.evidenceIds).toContain('signal-outcomes:stats');

    const advice = result.data.report.sections.find((section) => section.key === 'advice-outcomes');
    expect(advice?.status).toBe('complete');
    const adviceMetrics = advice?.blocks.find((block) => block.kind === 'metrics');
    expect(adviceMetrics?.kind === 'metrics' ? adviceMetrics.items : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'withOutcome', value: 2 }),
        expect.objectContaining({ key: 'pendingOutcome', value: 0 }),
        expect.objectContaining({ key: 'outcomeMissingRate', value: 0 }),
        expect.objectContaining({ key: 'knownPnlSamples', value: 1 }),
        expect.objectContaining({ key: 'knownBenchmarkPnlSamples', value: 1 }),
      ]),
    );
    expect(advice?.evidenceIds).toEqual(
      expect.arrayContaining(['advice-outcomes:advice', 'advice-outcomes:stats']),
    );
  });

  it('账户范围周报只投影指定账户的交易归因', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    const advice = (await ctx.repos.advice.query({ includeExpired: true, limit: 500 }))[0];
    const seedTrade = (await ctx.repos.trade.listByAccount(ctx.user.defaultAccountId))[0];
    if (advice === undefined || seedTrade === undefined) throw new Error('fixture fact missing');
    await ctx.repos.trade.save({
      ...seedTrade,
      id: 'weekly-attributed-trade',
      executedAt: new Date('2026-07-30T02:30:00.000Z'),
      adviceId: advice.id,
    });

    const result = await weeklyReportWorkflow.run(
      {
        periodEnd: '2026-07-31',
        scope: { kind: 'account', accountId: ctx.user.defaultAccountId },
        notify: false,
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tradeAttribution = result.data.report.sections.find(
      (section) => section.key === 'trade-attribution',
    );
    expect(tradeAttribution?.status).toBe('complete');
    const tradeMetrics = tradeAttribution?.blocks.find((block) => block.kind === 'metrics');
    expect(tradeMetrics?.kind === 'metrics' ? tradeMetrics.items : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'accountsRequested', value: 1 }),
        expect.objectContaining({ key: 'totalTrades', value: 1 }),
        expect.objectContaining({ key: 'attributedTrades', value: 1 }),
        expect.objectContaining({ key: 'attributionRate', value: 1 }),
        expect.objectContaining({ key: 'unattributedTrades', value: 0 }),
      ]),
    );
    const tradeTable = tradeAttribution?.blocks.find((block) => block.kind === 'table');
    expect(tradeTable?.kind === 'table' ? tradeTable.rows : []).toHaveLength(0);
  });
});
