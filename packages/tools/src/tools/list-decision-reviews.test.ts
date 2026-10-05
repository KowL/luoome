import { describe, expect, it, vi } from 'vitest';
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

  it.each([
    { timeBasis: 'source' as const, truncated: false },
    { timeBasis: 'recorded' as const, truncated: false },
    { timeBasis: 'source' as const, truncated: true },
    { timeBasis: 'recorded' as const, truncated: true },
  ])(
    '$timeBasis 翻页复用统计快照（truncated=$truncated），兼容旧游标',
    async ({ timeBasis, truncated }) => {
      const ctx = await buildTestContext();
      const accountId = ctx.user.defaultAccountId;
      const content = {
        tradeIds: [],
        adviceFeedback: { outcome: 'ignored' as const },
        triggerFeedback: null,
        note: null,
      };
      const views = [];
      for (let index = 0; index < 3; index += 1) {
        const occurredAt = new Date(`2026-09-0${index + 1}T00:00:00Z`);
        const saved = await ctx.repos.decisionReview.commit({
          accountId,
          requestId: `page-request-${index}`,
          requestHash: `page-hash-${index}`,
          expectedRevision: 0,
          review: {
            id: `page-review-${index}`,
            accountId,
            subject: { kind: 'advice', id: `page-advice-${index}` },
            stockId: '002594.SZ',
            sourceOccurredAt: occurredAt,
            context: {
              schemaVersion: 1,
              capturedAt: occurredAt,
              sourceDataAsOf: null,
              captureOrigin: 'user',
              source: {},
              contextHash: `page-context-${index}`,
            },
            createdAt: occurredAt,
          },
          content,
          contentHash: `page-content-${index}`,
          tradeFactHashes: {},
          changeNote: null,
          recordedAt: occurredAt,
        });
        views.push(saved.result);
      }
      const method = timeBasis === 'source' ? 'list' : 'listActivity';
      const query = vi.spyOn(ctx.repos.decisionReview, method);
      const firstView = views[0];
      if (firstView === undefined) throw new Error('missing seeded review');
      const statistics = truncated ? Array.from({ length: 10001 }, () => firstView) : views;
      query.mockResolvedValueOnce(statistics);
      const first = await listDecisionReviewsTool.execute({ accountId, timeBasis, limit: 1 }, ctx);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.data.nextCursor).not.toBeNull();
      if (first.data.nextCursor === null) return;
      expect(first.data.total).toBe(truncated ? null : 3);
      expect(first.data.coverage).toEqual({
        status: truncated ? 'partial' : 'complete',
        processed: truncated ? 10000 : 3,
        knownTotal: truncated ? 10001 : 3,
        truncated,
      });
      expect(query.mock.calls.map(([filter]) => filter.limit)).toEqual([10001, 2]);

      query.mockClear();
      const next = await listDecisionReviewsTool.execute(
        { accountId, timeBasis, limit: 1, cursor: first.data.nextCursor },
        ctx,
      );
      expect(next.ok).toBe(true);
      if (!next.ok) return;
      expect(next.data.records.map((view) => view.review.id)).toEqual(['page-review-1']);
      expect(next.data.total).toBe(first.data.total);
      expect(next.data.coverage).toEqual(first.data.coverage);
      expect(next.data.throughSequence).toBe(first.data.throughSequence);
      expect(query.mock.calls.map(([filter]) => filter.limit)).toEqual([2]);

      const legacy = JSON.parse(Buffer.from(first.data.nextCursor, 'base64url').toString('utf8'));
      delete legacy.knownTotal;
      query.mockClear();
      query.mockResolvedValueOnce(statistics);
      const resumed = await listDecisionReviewsTool.execute(
        {
          accountId,
          timeBasis,
          limit: 1,
          cursor: Buffer.from(JSON.stringify(legacy)).toString('base64url'),
        },
        ctx,
      );
      expect(resumed.ok).toBe(true);
      if (!resumed.ok) return;
      expect(resumed.data.records).toEqual(next.data.records);
      expect(resumed.data.total).toBe(first.data.total);
      expect(resumed.data.coverage).toEqual(first.data.coverage);
      expect(query.mock.calls.map(([filter]) => filter.limit)).toEqual([10001, 2]);
      expect(resumed.data.nextCursor).not.toBeNull();
      if (resumed.data.nextCursor === null) return;
      query.mockClear();
      const last = await listDecisionReviewsTool.execute(
        { accountId, timeBasis, limit: 1, cursor: resumed.data.nextCursor },
        ctx,
      );
      expect(last.ok && last.data.records.map((view) => view.review.id)).toEqual(['page-review-0']);
      expect(last.ok && last.data.nextCursor).toBeNull();
      expect(query.mock.calls.map(([filter]) => filter.limit)).toEqual([2]);

      query.mockClear();
      const invalid = await listDecisionReviewsTool.execute(
        {
          accountId,
          timeBasis,
          cursor: Buffer.from(JSON.stringify({ ...legacy, knownTotal: 10002 })).toString(
            'base64url',
          ),
        },
        ctx,
      );
      expect(invalid).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
      expect(query).not.toHaveBeenCalled();
    },
  );
});
