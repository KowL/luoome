import { TEST_ACCOUNT, TEST_ACCOUNT_LONGTERM, TEST_TRADES } from '@luoome/adapters/testing';
import { money, type Trade } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { getDecisionLoopReviewTool } from './get-decision-loop-review.js';

const NOW = new Date('2026-08-01T00:00:00.000Z');

const completeObservation = {
  id: 'review-observation-complete',
  sourceKind: 'strategy-signal' as const,
  sourceId: 'review-signal-complete',
  stockId: '002594.SZ',
  baselinePrice: 100,
  baselineAt: new Date('2026-07-20T00:00:00.000Z'),
  horizon: 't1' as const,
  closePrice: 101,
  returnPct: 0.01,
  maxFavorableExcursionPct: 0.02,
  maxAdverseExcursionPct: -0.01,
  benchmarkReturnPct: 0.005,
  benchmarkStatus: 'complete' as const,
  status: 'complete' as const,
  provenance: {
    provider: 'fixture',
    observedAt: new Date('2026-07-21T00:00:00.000Z'),
    fetchedAt: NOW,
    freshness: 'fresh' as const,
  },
  observedAt: new Date('2026-07-21T00:00:00.000Z'),
};

const pendingObservation = {
  id: 'review-observation-pending',
  sourceKind: 'strategy-signal' as const,
  sourceId: 'review-signal-pending',
  stockId: '002594.SZ',
  baselinePrice: 100,
  baselineAt: new Date('2026-07-22T00:00:00.000Z'),
  horizon: 't3' as const,
  benchmarkStatus: 'unavailable' as const,
  status: 'pending' as const,
  provenance: {
    provider: 'fixture',
    observedAt: new Date('2026-07-22T00:00:00.000Z'),
    fetchedAt: NOW,
    freshness: 'unknown' as const,
  },
};

describe('get_decision_loop_review', () => {
  it('按账户/股票聚合 Advice、Trade 归因、SignalObservation 与研究假设证据', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const advice = (
      await ctx.repos.advice.query({
        subjectKind: 'stock',
        subjectId: '002594.SZ',
        includeExpired: true,
      })
    )[0];
    if (advice === undefined) throw new Error('test advice missing');

    await ctx.repos.advice.recordOutcome(advice.id, {
      adviceId: advice.id,
      tradeIds: [TEST_TRADES[0]?.id ?? 'test-trade-0001'],
      outcome: 'followed',
      pnl: money(120),
      recordedAt: NOW,
    });
    await ctx.repos.trade.save({
      ...(TEST_TRADES[0] as Trade),
      adviceId: advice.id,
      researchHypothesisVersionId: 'hypothesis_review',
      strategyVersionId: 'review-strategy-v1',
    });
    await ctx.repos.researchHypothesisVersion.create({
      id: 'hypothesis_review',
      topicId: 'topic_review',
      documentId: 'doc_review',
      documentContentHash: 'a'.repeat(64),
      version: 1,
      status: 'active',
      summary: '测试研究假设',
      createdAt: NOW,
    });
    await ctx.repos.signalObservation.save(completeObservation);
    await ctx.repos.signalObservation.save(pendingObservation);

    const result = await getDecisionLoopReviewTool.execute(
      { accountId: TEST_ACCOUNT.id, stockId: '002594.SZ' },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.scope).toEqual({ accountId: TEST_ACCOUNT.id, stockId: '002594.SZ' });
    expect(result.data.advice).toEqual({
      total: 1,
      backfilled: 1,
      pending: 0,
      outcomeDistribution: { followed: 1, partiallyFollowed: 0, ignored: 0 },
    });
    expect(result.data.trades).toMatchObject({
      total: 2,
      attributionCounts: { advice: 1, researchHypothesisVersion: 1, strategyVersion: 1 },
      unattributed: 1,
    });
    expect(result.data.signalObservations).toMatchObject({
      total: 2,
      complete: 1,
      pending: 1,
      unavailable: 0,
      sampleUnit: 'stock-day-horizon',
    });
    expect(result.data.researchHypothesisVersions).toMatchObject([
      {
        id: 'hypothesis_review',
        topicId: 'topic_review',
        documentId: 'doc_review',
        version: 1,
        status: 'active',
        summary: '测试研究假设',
      },
    ]);
    expect(result.data.evidenceIds).toEqual(
      expect.arrayContaining([
        advice.id,
        'test-trade-0001',
        'test-trade-0002',
        'review-observation-complete',
        'review-observation-pending',
        'hypothesis_review',
      ]),
    );
    expect(result.data.dataAsOf).toEqual(NOW);
    expect(result.data.limitations.length).toBeGreaterThan(0);
  });

  it('账户隔离、日期过滤和非法时间范围', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const isolated = await getDecisionLoopReviewTool.execute(
      { accountId: TEST_ACCOUNT_LONGTERM.id },
      ctx,
    );
    expect(isolated.ok).toBe(true);
    if (!isolated.ok) return;
    expect(isolated.data.accountId).toBe(TEST_ACCOUNT_LONGTERM.id);
    expect(isolated.data.advice.total).toBe(0);
    expect(isolated.data.trades.total).toBe(0);

    const filtered = await getDecisionLoopReviewTool.execute(
      {
        accountId: TEST_ACCOUNT.id,
        stockId: '002594.SZ',
        since: '2026-05-06T05:00:00.000Z',
        until: '2026-05-06T07:00:00.000Z',
      },
      ctx,
    );
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) return;
    expect(filtered.data.trades.total).toBe(1);

    const invalid = await getDecisionLoopReviewTool.execute(
      { since: '2026-08-02T00:00:00.000Z', until: '2026-08-01T00:00:00.000Z' },
      ctx,
    );
    expect(invalid).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
  });
});
