import { describe, expect, it } from 'bun:test';
import type { ForumDigest, ForumPostSample } from '@luoome/core';
import {
  analyzeForumPosts,
  deriveForumConsistency,
  deriveForumPostsPercentile,
  forumDigestWindow,
} from '@luoome/core';
import { createDrizzleRepos } from '../../client.js';

const at = (time: string): Date => new Date(`2026-11-26T${time}+08:00`);

const post = (index: number, overrides: Partial<ForumPostSample> = {}): ForumPostSample => ({
  postId: `p-${index}`,
  title: `第 ${index} 帖：继续看多，加仓等突破`,
  content: '业绩稳定，突破前高再加仓。',
  author: `作者${index}`,
  authorId: `u-${index}`,
  publishedAt: at('10:00'),
  postType: 'user',
  clicks: 100 + index,
  replies: index,
  likes: index % 3,
  ...overrides,
});

const buildDigest = (input: {
  readonly subjectKind: 'market' | 'stock';
  readonly subjectId: string;
  readonly tradingDate?: string;
  readonly phase?: 'premarket' | 'post-market';
  readonly posts?: readonly ForumPostSample[];
  readonly breadth?: boolean;
}): ForumDigest => {
  const tradingDate = input.tradingDate ?? '2026-11-26';
  const phase = input.phase ?? 'post-market';
  const window = forumDigestWindow(tradingDate, phase);
  const posts = input.posts ?? Array.from({ length: 10 }, (_, index) => post(index));
  const analysis = analyzeForumPosts({
    subjectKind: input.subjectKind,
    posts,
    window,
  });
  const now = at('15:30');
  return {
    id: `digest-${input.subjectKind}-${input.subjectId}-${tradingDate}-${phase}`,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    tradingDate,
    phase,
    source: 'eastmoney',
    dataAsOf: now,
    windowStart: window.start,
    windowEnd: window.end,
    coverage: analysis.coverage,
    quality: analysis.quality,
    attention: {
      ...analysis.attention,
      ownHistory: deriveForumPostsPercentile({
        posts: analysis.attention.posts,
        historyPosts: [3, 4, 6, 9, 12],
        windowDays: 20,
      }),
    },
    ...(input.breadth === true
      ? {
          breadth: {
            hotListSize: 100,
            hotListExchanges: { sh: 41, sz: 59, other: 0 },
            rankChangeMedian: 2,
            marketStockCount: 5581,
          },
        }
      : {}),
    stance: analysis.stance,
    excerpts: [...analysis.excerpts],
    consistency: deriveForumConsistency({ stance: analysis.stance, quoteChangePct: 1.2 }),
    missing: [...analysis.missing],
    createdAt: now,
    updatedAt: now,
  };
};

describe('ForumDigestRepository', () => {
  it('upserts by (subjectKind, subjectId, tradingDate, phase) and keeps the first createdAt', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      const repos = handle.repos;
      const first = await repos.forumDigest.upsert(
        buildDigest({ subjectKind: 'stock', subjectId: '600519.SH' }),
      );
      expect(first.stance).not.toBeNull();
      expect(first.excerpts.length).toBeGreaterThan(0);
      expect(first.excerpts[0]?.untrusted).toBe(true);

      const updated = await repos.forumDigest.upsert({
        ...buildDigest({ subjectKind: 'stock', subjectId: '600519.SH' }),
        id: 'second-id',
        dataAsOf: at('16:00'),
        updatedAt: at('16:00'),
        consistency: deriveForumConsistency({
          stance: null,
          quoteChangePct: 1.2,
        }),
      });
      expect(updated.id).toBe(first.id);
      expect(updated.createdAt.getTime()).toBe(first.createdAt.getTime());
      expect(updated.updatedAt.getTime()).toBe(at('16:00').getTime());
      expect(updated.consistency.status).toBe('unknown');

      const rows = await repos.forumDigest.findByDay({ tradingDate: '2026-11-26' });
      expect(rows).toHaveLength(1);
      const found = await repos.forumDigest.find({
        subjectKind: 'stock',
        subjectId: '600519.SH',
        tradingDate: '2026-11-26',
        phase: 'post-market',
      });
      expect(found?.consistency.status).toBe('unknown');
    } finally {
      handle.close();
    }
  });

  it('separates market and stock digests, filters by day and returns history before a date', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      const repos = handle.repos;
      await repos.forumDigest.upsert(
        buildDigest({ subjectKind: 'market', subjectId: 'market', breadth: true }),
      );
      await repos.forumDigest.upsert(buildDigest({ subjectKind: 'stock', subjectId: '600519.SH' }));
      await repos.forumDigest.upsert(
        buildDigest({
          subjectKind: 'stock',
          subjectId: '600519.SH',
          tradingDate: '2026-11-25',
        }),
      );
      await repos.forumDigest.upsert(
        buildDigest({
          subjectKind: 'stock',
          subjectId: '000001.SZ',
          tradingDate: '2026-11-25',
          phase: 'premarket',
        }),
      );

      const day = await repos.forumDigest.findByDay({ tradingDate: '2026-11-26' });
      expect(day.map((row) => row.subjectKind).sort()).toEqual(['market', 'stock']);
      expect(day.find((row) => row.subjectKind === 'market')?.breadth?.hotListSize).toBe(100);

      const stocks = await repos.forumDigest.findByDay({
        tradingDate: '2026-11-25',
        subjectKinds: ['stock'],
        subjectIds: ['600519.SH'],
      });
      expect(stocks).toHaveLength(1);
      expect(stocks[0]?.subjectId).toBe('600519.SH');

      const history = await repos.forumDigest.history({
        subjectKind: 'stock',
        subjectId: '600519.SH',
        before: '2026-11-26',
      });
      expect(history.map((row) => row.tradingDate)).toEqual(['2026-11-25']);
      expect(
        await repos.forumDigest.history({
          subjectKind: 'stock',
          subjectId: '600519.SH',
          before: '2026-11-25',
        }),
      ).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it('rejects publishing stance without passing the quality gate', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      const digest = buildDigest({
        subjectKind: 'stock',
        subjectId: '600519.SH',
        posts: [post(0), post(1)],
      });
      expect(digest.stance).toBeNull();
      const saved = await handle.repos.forumDigest.upsert(digest);
      expect(saved.stance).toBeNull();
      expect(saved.missing.map((item) => item.dimension)).toContain('stance');

      await expect(
        handle.repos.forumDigest.upsert({
          ...digest,
          stance: {
            direction: 'bullish',
            bullish: 8,
            bearish: 0,
            neutral: 0,
            classified: 8,
            bullishShare: 1,
            bearishShare: 0,
            divergence: false,
          },
        }),
      ).rejects.toThrow(/质量门|有效样本/);
    } finally {
      handle.close();
    }
  });
});
