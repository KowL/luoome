import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';
import { listDecisionReviewsTool } from './decision-review.js';

describe('list_decision_reviews', () => {
  it('来源窗口半开、记录活动可翻页，水位冻结旧修订且游标绑定筛选', async () => {
    const ctx = await buildTestContext();
    const accountId = ctx.user.defaultAccountId;
    const review = {
      id: 'list-review',
      accountId,
      subject: { kind: 'advice' as const, id: 'advice-list' },
      stockId: '002594.SZ',
      sourceOccurredAt: new Date('2026-09-01T00:00:00Z'),
      context: {
        schemaVersion: 1 as const,
        capturedAt: new Date('2026-09-02T00:00:00Z'),
        sourceDataAsOf: null,
        captureOrigin: 'user' as const,
        source: {},
        contextHash: 'context-list',
      },
      createdAt: new Date('2026-09-02T00:00:00Z'),
    };
    const content = {
      tradeIds: [],
      adviceFeedback: { outcome: 'ignored' as const },
      triggerFeedback: null,
      note: null,
    };
    const first = await ctx.repos.decisionReview.commit({
      accountId,
      requestId: 'request-list-1',
      requestHash: 'hash-list-1',
      expectedRevision: 0,
      review,
      content,
      contentHash: 'content-list-1',
      tradeFactHashes: {},
      changeNote: null,
      recordedAt: new Date('2026-09-02T01:00:00Z'),
    });
    await ctx.repos.decisionReview.commit({
      accountId,
      requestId: 'request-list-2',
      requestHash: 'hash-list-2',
      expectedRevision: 1,
      review,
      content: { ...content, note: '更正' },
      contentHash: 'content-list-2',
      tradeFactHashes: {},
      changeNote: null,
      recordedAt: new Date('2026-09-03T01:00:00Z'),
    });
    const source = await listDecisionReviewsTool.execute(
      {
        accountId,
        since: new Date('2026-09-01T00:00:00Z'),
        until: new Date('2026-09-02T00:00:00Z'),
        throughSequence: first.result.revision.sequence,
      },
      ctx,
    );
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    expect(source.data.records.map((item) => item.revision.revision)).toEqual([1]);
    expect(source.data.window.timeBasis).toBe('source');
    const boundary = await listDecisionReviewsTool.execute(
      {
        accountId,
        since: new Date('2026-09-02T00:00:00Z'),
        until: new Date('2026-09-03T00:00:00Z'),
      },
      ctx,
    );
    expect(boundary.ok && boundary.data.total).toBe(0);
    const recorded = await listDecisionReviewsTool.execute(
      {
        accountId,
        timeBasis: 'recorded',
        since: new Date('2026-09-02T00:00:00Z'),
        until: new Date('2026-09-04T00:00:00Z'),
        limit: 1,
      },
      ctx,
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok || recorded.data.nextCursor === null) return;
    expect(recorded.data.total).toBe(2);
    expect(recorded.data.records[0]?.revision.revision).toBe(2);
    const next = await listDecisionReviewsTool.execute(
      {
        accountId,
        timeBasis: 'recorded',
        since: new Date('2026-09-02T00:00:00Z'),
        until: new Date('2026-09-04T00:00:00Z'),
        limit: 1,
        cursor: recorded.data.nextCursor,
      },
      ctx,
    );
    expect(next.ok && next.data.records[0]?.revision.revision).toBe(1);
    const mismatch = await listDecisionReviewsTool.execute(
      {
        accountId,
        timeBasis: 'recorded',
        stockId: '600519.SH',
        limit: 1,
        cursor: recorded.data.nextCursor,
      },
      ctx,
    );
    expect(mismatch).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
  });
});
