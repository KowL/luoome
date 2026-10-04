import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';
import { getDecisionReviewContextTool } from './decision-review.js';
import { recordDecisionTradeTool } from './record-decision-trade.js';

describe('record_decision_trade', () => {
  it('commits once and returns the original receipt on retry', async () => {
    const ctx = await buildTestContext();
    const accountId = ctx.user.defaultAccountId;
    const state = await ctx.repos.decisionTrade.getLedgerState(accountId);
    expect(state?.appendEligibility).toBe('eligible');
    if (state === null) return;
    const before = await ctx.repos.account.findById(accountId);
    const input = {
      requestId: crypto.randomUUID(),
      expectedLedgerStateHash: state.hash,
      confirmedNotRecorded: true,
      stockId: '002594.SZ',
      side: 'buy',
      quantity: 1,
      price: 100,
      fee: 0,
      executedAt: ctx.clock().toISOString(),
      sources: [],
    };
    const first = await recordDecisionTradeTool.execute(input, ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const retry = await recordDecisionTradeTool.execute(input, ctx);
    expect(retry.ok && retry.data.replayed).toBe(true);
    const after = await ctx.repos.account.findById(accountId);
    expect(after!.cashBalance).toBe(before!.cashBalance - 100);
    const conflicting = await recordDecisionTradeTool.execute(
      { ...input, requestId: crypto.randomUUID() },
      ctx,
    );
    expect(conflicting.ok).toBe(false);
  });

  it('adds an explicitly chosen advice link without inventing feedback', async () => {
    const ctx = await buildTestContext();
    const accountId = ctx.user.defaultAccountId;
    const advice = (
      await ctx.repos.advice.query({
        subjectKind: 'stock',
        subjectId: '002594.SZ',
        includeExpired: true,
        limit: 1,
      })
    )[0]!;
    const subject = { kind: 'advice', id: advice.id };
    const preview = await getDecisionReviewContextTool.execute({ subject }, ctx);
    expect(preview.ok).toBe(true);
    if (!preview.ok || preview.data.context === null) return;
    const ledgerState = await ctx.repos.decisionTrade.getLedgerState(accountId);
    if (ledgerState === null) return;
    const result = await recordDecisionTradeTool.execute(
      {
        requestId: crypto.randomUUID(),
        expectedLedgerStateHash: ledgerState.hash,
        confirmedNotRecorded: true,
        stockId: '002594.SZ',
        side: 'buy',
        quantity: 1,
        price: 100,
        fee: 0,
        executedAt: ctx.clock().toISOString(),
        sources: [{ subject, contextHash: preview.data.context.contextHash, expectedRevision: 0 }],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.result.reviews).toHaveLength(1);
    expect(result.data.result.reviews[0]!.revision.content.adviceFeedback).toBeNull();
    expect(result.data.result.trade.adviceId).toBe(advice.id);
  });
});
