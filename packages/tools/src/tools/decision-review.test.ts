import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';
import { listDecisionReviewsTool, saveDecisionReviewTool } from './decision-review.js';

const adviceSubject = async (ctx: Awaited<ReturnType<typeof buildTestContext>>) => {
  const advice = (await ctx.repos.advice.query({ includeExpired: true, limit: 1 }))[0];
  if (!advice) throw new Error('advice fixture missing');
  return { kind: 'advice' as const, id: advice.id };
};

describe('save_decision_review', () => {
  it('upserts one review per subject and keeps the original creation time', async () => {
    const ctx = await buildTestContext();
    const subject = await adviceSubject(ctx);
    const first = await saveDecisionReviewTool.execute(
      {
        subject,
        content: {
          tradeIds: [],
          adviceFeedback: { outcome: 'followed', pnl: 12.5 },
          lessonTags: ['按计划'],
          note: '首次复盘',
        },
      },
      ctx,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.review.accountId).toBe(ctx.user.defaultAccountId);
    expect(first.data.review.subject).toEqual(subject);
    expect(first.data.review.content.lessonTags).toEqual(['按计划']);
    expect(first.data.review.content.adviceFeedback).toEqual({ outcome: 'followed', pnl: 12.5 });

    const second = await saveDecisionReviewTool.execute(
      {
        subject,
        content: {
          tradeIds: [],
          adviceFeedback: null,
          lessonTags: ['按计划', '复盘再改'],
          note: null,
        },
      },
      ctx,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.review.id).toBe(first.data.review.id);
    expect(second.data.review.createdAt.toISOString()).toBe(
      first.data.review.createdAt.toISOString(),
    );
    expect(second.data.review.content.note).toBeNull();
    expect(second.data.review.content.lessonTags).toEqual(['按计划', '复盘再改']);

    const list = await listDecisionReviewsTool.execute(
      { subjectKind: 'advice', subjectId: subject.id },
      ctx,
    );
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data.records).toHaveLength(1);
    expect(list.data.records[0]?.content.note).toBeNull();
  });

  it('rejects empty content, dangling subjects and dangling trade links', async () => {
    const ctx = await buildTestContext();
    const subject = await adviceSubject(ctx);
    const empty = await saveDecisionReviewTool.execute(
      {
        subject,
        content: { tradeIds: [], adviceFeedback: null, lessonTags: [], note: null },
      },
      ctx,
    );
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.error.kind).toBe('invalid_input');

    const missing = await saveDecisionReviewTool.execute(
      {
        subject: { kind: 'advice', id: 'missing-advice' },
        content: { tradeIds: [], adviceFeedback: null, lessonTags: [], note: '复盘' },
      },
      ctx,
    );
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.kind).toBe('not_found');

    const dangling = await saveDecisionReviewTool.execute(
      {
        subject,
        content: {
          tradeIds: ['missing-trade'],
          adviceFeedback: null,
          lessonTags: [],
          note: '复盘',
        },
      },
      ctx,
    );
    expect(dangling.ok).toBe(false);
    if (dangling.ok) return;
    expect(dangling.error.kind).toBe('not_found');
  });

  it('only accepts advice feedback on advice reviews', async () => {
    const ctx = await buildTestContext();
    const trades = await ctx.repos.trade.listByAccount(ctx.user.defaultAccountId);
    const trade = trades[0];
    if (trade === undefined) throw new Error('trade fixture missing');
    const saved = await saveDecisionReviewTool.execute(
      {
        subject: { kind: 'trade', id: trade.id },
        content: {
          tradeIds: [trade.id],
          adviceFeedback: { outcome: 'ignored' },
          lessonTags: [],
          note: '成交复盘',
        },
      },
      ctx,
    );
    expect(saved.ok).toBe(false);
    if (saved.ok) return;
    expect(saved.error.kind).toBe('invalid_input');
  });
});

describe('list_decision_reviews', () => {
  it('returns newest updated reviews first and paginates with a filter-bound cursor', async () => {
    const ctx = await buildTestContext();
    const advices = await ctx.repos.advice.query({ includeExpired: true, limit: 2 });
    const [first, second] = advices;
    if (first === undefined || second === undefined) throw new Error('advice fixture missing');
    for (const advice of [first, second]) {
      const saved = await saveDecisionReviewTool.execute(
        {
          subject: { kind: 'advice', id: advice.id },
          content: { tradeIds: [], adviceFeedback: null, lessonTags: [], note: advice.id },
        },
        ctx,
      );
      expect(saved.ok).toBe(true);
    }
    const page = await listDecisionReviewsTool.execute({ limit: 1 }, ctx);
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.data.records).toHaveLength(1);
    expect(page.data.nextCursor).not.toBeNull();
    const next = await listDecisionReviewsTool.execute(
      { limit: 1, cursor: page.data.nextCursor ?? '' },
      ctx,
    );
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.data.records).toHaveLength(1);
    expect(next.data.records[0]?.id).not.toBe(page.data.records[0]?.id);
    expect(next.data.nextCursor).toBeNull();

    const otherFilter = await listDecisionReviewsTool.execute(
      { limit: 1, cursor: page.data.nextCursor ?? '', stockId: '600519.SH' },
      ctx,
    );
    expect(otherFilter.ok).toBe(false);
    if (otherFilter.ok) return;
    expect(otherFilter.error.kind).toBe('invalid_input');
  });
});
