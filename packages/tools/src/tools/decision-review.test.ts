import { money, quantity, type Trade } from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';
import { buildTestContext } from '../testing/context.js';
import {
  getDecisionReviewContextTool,
  getDecisionWriteReceiptTool,
  saveDecisionReviewTool,
} from './decision-review.js';

describe('decision review tools', () => {
  it('在仓储筛选最新候选成交，并保留窗口外已关联成交', async () => {
    const ctx = await buildTestContext();
    const advice = (
      await ctx.repos.advice.query({ subjectKind: 'stock', includeExpired: true, limit: 1 })
    )[0];
    if (!advice) throw new Error('advice fixture missing');
    const accountId = ctx.user.defaultAccountId;
    const subject = { kind: 'advice', id: advice.id };
    const makeTrade = (id: string, offset: number, overrides: Partial<Trade> = {}): Trade => ({
      id,
      accountId,
      stockId: advice.subjectId,
      side: 'buy',
      quantity: quantity(100),
      price: money(10),
      fee: money(0),
      executedAt: new Date(advice.createdAt.getTime() + offset),
      createdAt: ctx.clock(),
      source: 'manual',
      ...overrides,
    });
    for (let i = 0; i < 25; i++)
      await ctx.repos.trade.save(makeTrade(`candidate-${String(i).padStart(2, '0')}`, i));
    await ctx.repos.trade.save(makeTrade('before-source', -1));
    await ctx.repos.trade.save(makeTrade('other-stock', 30, { stockId: 'other-stock' }));
    await ctx.repos.trade.save(makeTrade('other-account', 30, { accountId: 'other-account' }));
    const query = vi.spyOn(ctx.repos.trade, 'listByAccount');
    const preview = await getDecisionReviewContextTool.execute({ subject }, ctx);
    expect(preview.ok).toBe(true);
    if (!preview.ok || preview.data.context === null) return;
    expect(query).toHaveBeenCalledWith(accountId, {
      stockId: advice.subjectId,
      executedAtFrom: advice.createdAt,
      order: 'desc',
      limit: 20,
    });
    expect(preview.data.candidateTrades.map((trade) => trade.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `candidate-${String(24 - i).padStart(2, '0')}`),
    );
    const saved = await saveDecisionReviewTool.execute(
      {
        requestId: crypto.randomUUID(),
        subject,
        contextHash: preview.data.context.contextHash,
        expectedRevision: 0,
        content: {
          tradeIds: ['candidate-00', 'candidate-24'],
          adviceFeedback: null,
          triggerFeedback: null,
          note: '',
        },
      },
      ctx,
    );
    expect(saved.ok).toBe(true);
    const linked = await getDecisionReviewContextTool.execute({ subject }, ctx);
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    expect(linked.data.candidateTrades.map((trade) => trade.id)).toEqual([
      ...preview.data.candidateTrades.map((trade) => trade.id),
      'candidate-00',
    ]);
  });

  it('saves an account revision, replays a request, and rejects stale edits', async () => {
    const ctx = await buildTestContext();
    const advice = (await ctx.repos.advice.query({ includeExpired: true, limit: 1 }))[0]!;
    const subject = { kind: 'advice', id: advice.id };
    const preview = await getDecisionReviewContextTool.execute({ subject }, ctx);
    expect(preview.ok).toBe(true);
    if (!preview.ok || preview.data.context === null) return;
    const input = {
      requestId: crypto.randomUUID(),
      subject,
      contextHash: preview.data.context.contextHash,
      expectedRevision: 0,
      content: {
        tradeIds: [],
        adviceFeedback: { outcome: 'partially_followed' },
        triggerFeedback: null,
        note: '等待结算',
      },
    };
    const first = await saveDecisionReviewTool.execute(input, ctx);
    expect(first.ok).toBe(true);
    const repeated = await saveDecisionReviewTool.execute(input, ctx);
    expect(repeated.ok && repeated.data.replayed).toBe(true);
    const stale = await saveDecisionReviewTool.execute(
      {
        ...input,
        requestId: crypto.randomUUID(),
        content: { ...input.content, note: '另一个标签页' },
      },
      ctx,
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.kind).toBe('invariant_violation');
    const receipt = await getDecisionWriteReceiptTool.execute({ requestId: input.requestId }, ctx);
    expect(receipt.ok).toBe(true);
  });

  it('只列出 Advice 持久证据指向的信号观察，不按同股拼接', async () => {
    const ctx = await buildTestContext();
    const advice = (
      await ctx.repos.advice.query({ subjectKind: 'stock', includeExpired: true, limit: 50 })
    )[0];
    if (!advice) throw new Error('advice fixture missing');
    const observation = {
      id: 'explicit-observation',
      sourceKind: 'strategy-signal' as const,
      sourceId: 'explicit-signal',
      stockId: advice.subjectId,
      baselinePrice: 100,
      baselineAt: advice.createdAt,
      horizon: 't1' as const,
      benchmarkStatus: 'unavailable' as const,
      status: 'pending' as const,
      provenance: {
        provider: 'fixture',
        observedAt: advice.createdAt,
        fetchedAt: advice.createdAt,
        freshness: 'unknown' as const,
      },
    };
    await ctx.repos.signalObservation.save(observation);
    const subject = { kind: 'advice' as const, id: advice.id };
    const unlinked = await getDecisionReviewContextTool.execute({ subject }, ctx);
    expect(unlinked.ok && unlinked.data.observations).toEqual([]);
    await ctx.repos.advice.save({
      ...advice,
      basedOn: {
        ...advice.basedOn,
        strategy: {
          strategyId: 'strategy-explicit',
          strategyVersionId: 'version-explicit',
          runId: 'run-explicit',
          stockId: advice.subjectId,
          resultEvidence: [],
          signalIds: ['explicit-signal'],
          observationIds: ['explicit-observation'],
          recommendationTrigger: 'run',
        },
      },
    });
    const linked = await getDecisionReviewContextTool.execute({ subject }, ctx);
    expect(linked.ok && linked.data.observations.map((item) => item.id)).toEqual([
      'explicit-observation',
    ]);
  });
});
