import { describe, expect, it } from 'bun:test';
import { DecisionReviewSchema } from '@luoome/core';
import { createDrizzleRepos } from '../client.js';

const reviewOf = (
  overrides: Partial<Parameters<typeof DecisionReviewSchema.parse>[0]> = {},
): ReturnType<typeof DecisionReviewSchema.parse> =>
  DecisionReviewSchema.parse({
    id: 'review-1',
    accountId: 'account-1',
    subject: { kind: 'advice', id: 'advice-1' },
    stockId: '002594.SZ',
    content: {
      tradeIds: ['trade-1'],
      adviceFeedback: { outcome: 'followed', pnl: 12.5 },
      lessonTags: ['追高'],
      note: '复盘结论',
    },
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  });

describe('DecisionReviewRepository [drizzle]', () => {
  it('round-trips content_json and keeps one row per (account, subject)', async () => {
    const handle = createDrizzleRepos(':memory:');
    const repos = handle.repos;
    try {
      const first = reviewOf();
      const saved = await repos.decisionReview.save(first);
      expect(saved).toEqual(first);
      expect(
        await repos.decisionReview.findBySubject({
          accountId: 'account-1',
          subject: first.subject,
        }),
      ).toEqual(first);
      expect(await repos.decisionReview.findById({ accountId: 'account-1', id: first.id })).toEqual(
        first,
      );

      const updated = reviewOf({
        id: 'review-replaced-id',
        content: {
          tradeIds: [],
          adviceFeedback: null,
          lessonTags: ['止损'],
          note: null,
        },
        createdAt: new Date('2026-09-05T00:00:00Z'),
        updatedAt: new Date('2026-09-06T00:00:00Z'),
      });
      const second = await repos.decisionReview.save(updated);
      expect(second.id).toBe(first.id);
      expect(second.createdAt).toEqual(first.createdAt);
      expect(second.updatedAt).toEqual(updated.updatedAt);
      expect(second.content).toEqual(updated.content);
      expect(await repos.decisionReview.list({ accountId: 'account-1' })).toHaveLength(1);
    } finally {
      handle.close();
    }
  });

  it('filters by subject/stock and paginates by update time', async () => {
    const handle = createDrizzleRepos(':memory:');
    const repos = handle.repos;
    try {
      const base = new Date('2026-09-10T00:00:00Z');
      const at = (hours: number) => new Date(base.getTime() + hours * 3_600_000);
      const rows = [
        reviewOf({
          id: 'review-advice-late',
          subject: { kind: 'advice', id: 'advice-a' },
          updatedAt: at(2),
          createdAt: at(2),
        }),
        reviewOf({
          id: 'review-plan',
          subject: { kind: 'trading-plan', id: 'plan-version-1' },
          stockId: '600519.SH',
          content: { tradeIds: [], adviceFeedback: null, lessonTags: [], note: '计划复盘' },
          createdAt: at(1),
          updatedAt: at(1),
        }),
        reviewOf({
          id: 'review-advice-early',
          subject: { kind: 'advice', id: 'advice-b' },
          stockId: null,
          createdAt: at(0),
          updatedAt: at(0),
        }),
      ];
      for (const row of rows) await repos.decisionReview.save(row);

      const all = await repos.decisionReview.list({ accountId: 'account-1' });
      expect(all.map((item) => item.id)).toEqual([
        'review-advice-late',
        'review-plan',
        'review-advice-early',
      ]);
      expect(
        (await repos.decisionReview.list({ accountId: 'account-1', subjectKind: 'advice' })).map(
          (item) => item.id,
        ),
      ).toEqual(['review-advice-late', 'review-advice-early']);
      expect(
        (await repos.decisionReview.list({ accountId: 'account-1', stockId: '600519.SH' })).map(
          (item) => item.id,
        ),
      ).toEqual(['review-plan']);
      expect(
        (
          await repos.decisionReview.list({
            accountId: 'account-1',
            since: at(0),
            until: at(1),
          })
        ).map((item) => item.id),
      ).toEqual(['review-advice-early']);

      const firstPage = await repos.decisionReview.list({ accountId: 'account-1', limit: 2 });
      expect(firstPage.map((item) => item.id)).toEqual(['review-advice-late', 'review-plan']);
      const cursorSource = firstPage[1];
      if (cursorSource === undefined) throw new Error('missing page cursor fixture');
      const secondPage = await repos.decisionReview.list({
        accountId: 'account-1',
        limit: 2,
        cursor: { updatedAt: cursorSource.updatedAt, id: cursorSource.id },
      });
      expect(secondPage.map((item) => item.id)).toEqual(['review-advice-early']);
    } finally {
      handle.close();
    }
  });

  it('isolates reviews by account', async () => {
    const handle = createDrizzleRepos(':memory:');
    const repos = handle.repos;
    try {
      const review = reviewOf();
      await repos.decisionReview.save(review);
      expect(
        await repos.decisionReview.findBySubject({
          accountId: 'account-2',
          subject: review.subject,
        }),
      ).toBeNull();
      expect(
        await repos.decisionReview.findById({ accountId: 'account-2', id: review.id }),
      ).toBeNull();
      expect(await repos.decisionReview.list({ accountId: 'account-2' })).toEqual([]);
      expect(
        await repos.decisionReview.findBySubject({
          accountId: 'account-1',
          subject: { kind: 'advice', id: 'missing-advice' },
        }),
      ).toBeNull();
    } finally {
      handle.close();
    }
  });
});
