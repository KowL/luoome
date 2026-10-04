import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';
import {
  getDecisionReviewContextTool,
  getDecisionWriteReceiptTool,
  saveDecisionReviewTool,
} from './decision-review.js';

describe('decision review tools', () => {
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
