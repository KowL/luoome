import { TEST_ACCOUNT, TEST_ACCOUNT_LONGTERM, TEST_TRADES } from '@luoome/adapters/testing';
import type { Trade } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { getAdviceAttributionTool } from './get-advice-attribution.js';
import { getDecisionLoopReviewTool } from './get-decision-loop-review.js';
import { recordAdviceOutcomeTool } from './record-advice-outcome.js';

const NOW = new Date('2026-08-01T00:00:00.000Z');

/** 归因工具里的「已归因成交数」= 所有建议关联成交的条数（每条只归一个 owner）。 */
const attrActributionCountFor = (data: {
  rows: readonly { status: string; tradeLinks?: readonly unknown[] }[];
}): number =>
  data.rows
    .filter((row) => row.status === 'traded')
    .reduce((total, row) => total + (row.tradeLinks?.length ?? 0), 0);

const completeObservation = {
  id: 'review-observation-complete',
  sourceKind: 'strategy-signal' as const,
  sourceId: 'review-signal-complete',
  stockId: '002594.SZ',
  baselinePrice: 100,
  baselineAt: new Date('2026-07-20T00:00:00.000Z'),
  horizon: 't1' as const,
  vintage: 'pit' as const,
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
  vintage: 'pit' as const,
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
    const ctx = await buildTestContext({ clock: () => NOW, adviceOutcomeOrigin: 'user' });
    const advice = (
      await ctx.repos.advice.query({
        subjectKind: 'stock',
        subjectId: '002594.SZ',
        includeExpired: true,
      })
    )[0];
    if (advice === undefined) throw new Error('test advice missing');
    const sourceAt = new Date('2026-05-05T00:00:00.000Z');
    await ctx.repos.advice.save({
      ...advice,
      basedOn: { ...advice.basedOn, dataAsOf: sourceAt },
      validFrom: sourceAt,
      createdAt: sourceAt,
    });

    await ctx.repos.trade.save({
      ...(TEST_TRADES[0] as Trade),
      adviceId: advice.id,
      researchHypothesisVersionId: 'hypothesis_review',
      strategyVersionId: 'review-strategy-v1',
    });
    const outcome = await recordAdviceOutcomeTool.execute(
      {
        adviceId: advice.id,
        accountId: TEST_ACCOUNT.id,
        outcome: 'followed',
        tradeIds: [TEST_TRADES[0]?.id ?? 'test-trade-0001'],
        pnl: 120,
      },
      ctx,
    );
    expect(outcome).toEqual(expect.objectContaining({ ok: true }));
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
      originFilter: 'user',
      originCounts: { user: 1, model: 0, import: 0, unattested: 0 },
      excluded: { nonUserOrigin: 0, unattested: 0 },
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

  it('默认只统计窗口内 user，显式 all 保留原来源；成交归因不随过滤改变', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const template = (await ctx.repos.advice.query({ includeExpired: true }))[0];
    if (!template) throw new Error('missing advice fixture');
    for (const id of ['user', 'model', 'import', 'legacy', 'outside-window', 'other-account']) {
      const accountId = id === 'other-account' ? TEST_ACCOUNT_LONGTERM.id : TEST_ACCOUNT.id;
      const createdAt = id === 'outside-window' ? new Date('2026-07-01') : NOW;
      await ctx.repos.advice.save({
        ...template,
        id,
        subjectKind: 'portfolio',
        subjectId: accountId,
        createdAt,
      });
      const origin = id === 'user' ? 'user' : id === 'import' ? 'import' : 'model';
      expect(
        (
          await recordAdviceOutcomeTool.execute(
            { adviceId: id, accountId, outcome: 'ignored' },
            { ...ctx, adviceOutcomeOrigin: origin },
          )
        ).ok,
      ).toBe(true);
      if (id === 'legacy') {
        const row = await ctx.repos.decisionReview.findBySubject({
          accountId,
          subject: { kind: 'advice', id },
        });
        if (!row?.revision.content.adviceFeedback) throw new Error('missing review fixture');
        const { origin: _origin, ...feedback } = row.revision.content.adviceFeedback;
        await ctx.repos.decisionReview.commit({
          accountId,
          requestId: crypto.randomUUID(),
          requestHash: 'legacy',
          expectedRevision: 1,
          review: row.review,
          content: { ...row.revision.content, adviceFeedback: feedback },
          contentHash: 'legacy',
          tradeFactHashes: {},
          changeNote: 'legacy fixture',
          recordedAt: NOW,
        });
      }
    }
    const input = { accountId: TEST_ACCOUNT.id, since: NOW, until: NOW };
    const strict = await getDecisionLoopReviewTool.execute(input, ctx);
    const all = await getDecisionLoopReviewTool.execute({ ...input, originFilter: 'all' }, ctx);
    if (!strict.ok || !all.ok) throw new Error('review fixture failed');
    expect(strict.data.advice).toMatchObject({
      backfilled: 1,
      pending: 3,
      originFilter: 'user',
      originCounts: { user: 1, model: 1, import: 1, unattested: 1 },
      excluded: { nonUserOrigin: 2, unattested: 1 },
      outcomeDistribution: { followed: 0, partiallyFollowed: 0, ignored: 1 },
    });
    expect(all.data.advice).toMatchObject({
      backfilled: 4,
      pending: 0,
      originFilter: 'all',
      excluded: { nonUserOrigin: 0, unattested: 0 },
      outcomeDistribution: { ignored: 4 },
    });
    expect(strict.data.trades).toEqual(all.data.trades);
    expect(strict.data.limitations.join(' ')).toContain('无来源戳 1 条');
  });
});

// task-16：Trade ↔ Advice 双链并认，两工具对同一批成交给出同一计数。
describe('task-16 双链并认的对拍', () => {
  const seedAdvice = async (ctx: Awaited<ReturnType<typeof buildTestContext>>, id: string) => {
    const template = (await ctx.repos.advice.query({ includeExpired: true }))[0];
    if (!template) throw new Error('missing advice fixture');
    await ctx.repos.advice.save({
      ...template,
      id,
      // get_advice_attribution 只归因可映射到股票的 advice（portfolio 主体不可归因）。
      subjectKind: 'stock',
      subjectId: '002594.SZ',
      createdAt: NOW,
    });
    return template;
  };

  /** 只带 `Trade.adviceId` 的成交：账本上有显式链接，但没有 DecisionReview.tradeIds。 */
  it('仅有 Trade.adviceId 时两工具都算已归因，且计数一致', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedAdvice(ctx, 'advice-chain-a');
    const base = TEST_TRADES[0] as Trade;
    await ctx.repos.trade.save({
      ...base,
      id: 'trade-chain-a',
      accountId: TEST_ACCOUNT.id,
      adviceId: 'advice-chain-a',
      executedAt: NOW,
    });
    // 归因工具只处理「账户归属明确」的建议（stock 建议需 review 认领或 strategy 归属）。
    await recordAdviceOutcomeTool.execute(
      { adviceId: 'advice-chain-a', accountId: TEST_ACCOUNT.id, outcome: 'ignored' },
      { ...ctx, adviceOutcomeOrigin: 'user' },
    );
    const review = await getDecisionLoopReviewTool.execute(
      { accountId: TEST_ACCOUNT.id, since: NOW, until: NOW },
      ctx,
    );
    const attribution = await getAdviceAttributionTool.execute(
      { accountId: TEST_ACCOUNT.id, adviceId: 'advice-chain-a' },
      ctx,
    );
    if (!attribution.ok)
      throw new Error(`attribution failed: ${JSON.stringify(attribution.error)}`);
    if (!review.ok || !attribution.ok) throw new Error('fixture failed');
    expect(review.data.trades.attributionCounts.advice).toBe(1);
    expect(review.data.trades.unattributed).toBe(0);
    const attributed = attribution.data.rows.find((row) => row.adviceId === 'advice-chain-a');
    expect(attributed?.status).toBe('traded');
    expect(attributed?.status === 'traded' ? attributed.tradeLinks[0]?.relation : undefined).toBe(
      'trade.adviceId',
    );
    // 对拍：两工具对同一批成交给出同一「已归因成交数」。
    expect(review.data.trades.attributionCounts.advice).toBe(
      attrActributionCountFor(attribution.data),
    );
  });

  /** 只带 `DecisionReview.tradeIds` 的成交：账本上无 adviceId。 */
  it('仅有 DecisionReview.tradeIds 时两工具都算已归因，且计数一致', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedAdvice(ctx, 'advice-chain-b');
    const base = TEST_TRADES[0] as Trade;
    await ctx.repos.trade.save({
      ...base,
      id: 'trade-chain-b',
      accountId: TEST_ACCOUNT.id,
      executedAt: NOW,
    });
    const outcome = await recordAdviceOutcomeTool.execute(
      {
        adviceId: 'advice-chain-b',
        accountId: TEST_ACCOUNT.id,
        outcome: 'followed',
        tradeIds: ['trade-chain-b'],
      },
      { ...ctx, adviceOutcomeOrigin: 'user' },
    );
    expect(outcome.ok).toBe(true);
    const review = await getDecisionLoopReviewTool.execute(
      { accountId: TEST_ACCOUNT.id, since: NOW, until: NOW },
      ctx,
    );
    const attribution = await getAdviceAttributionTool.execute(
      { accountId: TEST_ACCOUNT.id, adviceId: 'advice-chain-b' },
      ctx,
    );
    if (!review.ok || !attribution.ok) throw new Error('fixture failed');
    expect(review.data.trades.attributionCounts.advice).toBe(1);
    const attributed = attribution.data.rows.find((row) => row.adviceId === 'advice-chain-b');
    expect(attributed?.status === 'traded' ? attributed.tradeLinks[0]?.relation : undefined).toBe(
      'decision-review.tradeIds',
    );
    expect(review.data.trades.attributionCounts.advice).toBe(
      attrActributionCountFor(attribution.data),
    );
  });

  /** 同一条成交两条链都指向同一建议：**不重复计数**。 */
  it('两处都关联同一建议时不重复计数', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedAdvice(ctx, 'advice-chain-c');
    const base = TEST_TRADES[0] as Trade;
    await ctx.repos.trade.save({
      ...base,
      id: 'trade-chain-c',
      accountId: TEST_ACCOUNT.id,
      adviceId: 'advice-chain-c',
      executedAt: NOW,
    });
    await recordAdviceOutcomeTool.execute(
      {
        adviceId: 'advice-chain-c',
        accountId: TEST_ACCOUNT.id,
        outcome: 'followed',
        tradeIds: ['trade-chain-c'],
      },
      { ...ctx, adviceOutcomeOrigin: 'user' },
    );
    const review = await getDecisionLoopReviewTool.execute(
      { accountId: TEST_ACCOUNT.id, since: NOW, until: NOW },
      ctx,
    );
    if (!review.ok) throw new Error('fixture failed');
    // 一条成交 = 1，不是 2。
    expect(review.data.trades.attributionCounts.advice).toBe(1);
    expect(review.data.trades.unattributed).toBe(0);
  });
});
