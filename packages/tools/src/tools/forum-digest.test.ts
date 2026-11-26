import {
  analyzeForumPosts,
  deriveForumConsistency,
  deriveForumPostsPercentile,
  FORUM_MARKET_SUBJECT_ID,
  type ForumDigest,
  ForumDigestSchema,
  forumDigestWindow,
} from '@luoome/core';
import { forumOnlyEvidenceViolations } from '@luoome/plugin-analysis/internal/build-advice.js';
import { getForumDigestTool } from '@luoome/toolkit/tools/get-forum-digest.js';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';

const TRADING_DATE = '2026-11-25';
const at = (time: string): Date => new Date(`${TRADING_DATE}T${time}+08:00`);
const POST = (index: number) => ({
  postId: `p-${index}`,
  title: `第 ${index} 帖 继续看多，突破后加仓`,
  content: '量能够了。',
  author: `作者${index}`,
  authorId: `u-${index}`,
  publishedAt: at('10:00'),
  postType: 'user' as const,
  replies: index,
  clicks: 100,
});

const digest = (input: {
  readonly subjectKind: 'market' | 'stock';
  readonly subjectId: string;
  readonly posts?: readonly ReturnType<typeof POST>[];
}): ForumDigest => {
  const window = forumDigestWindow(TRADING_DATE, 'post-market');
  const analysis = analyzeForumPosts({
    subjectKind: input.subjectKind,
    posts: input.posts ?? [],
    window,
  });
  const now = at('15:30');
  return {
    id: `digest-${input.subjectKind}-${input.subjectId}`,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    tradingDate: TRADING_DATE,
    phase: 'post-market',
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
        historyPosts: [2, 4, 6, 8, 10],
        windowDays: 20,
      }),
    },
    ...(input.subjectKind === 'market'
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

describe('get_forum_digest', () => {
  it('returns market breadth plus requested stock digests and explicit missing reasons', async () => {
    const ctx = await buildTestContext({ clock: () => at('15:30') });
    await ctx.repos.forumDigest.upsert(
      digest({ subjectKind: 'market', subjectId: FORUM_MARKET_SUBJECT_ID }),
    );
    await ctx.repos.forumDigest.upsert(
      digest({
        subjectKind: 'stock',
        subjectId: '600519.SH',
        posts: Array.from({ length: 10 }, (_, index) => POST(index)),
      }),
    );

    const result = await getForumDigestTool.execute(
      { date: TRADING_DATE, stockIds: ['600519.SH', '000001.SZ'] },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.market?.breadth?.hotListSize).toBe(100);
    expect(result.data.stocks.map((row) => row.subjectId)).toEqual(['600519.SH']);
    expect(result.data.stocks[0]?.stance?.direction).toBe('bullish');
    expect(result.data.missing).toEqual([
      expect.objectContaining({ subjectKind: 'stock', subjectId: '000001.SZ' }),
    ]);
    expect(ForumDigestSchema.safeParse(result.data.stocks[0]).success).toBe(true);
    expect(getForumDigestTool.sideEffect).toBe('read');
  });

  it('returns null market and no stocks when nothing was collected', async () => {
    const ctx = await buildTestContext({ clock: () => at('15:30') });
    const result = await getForumDigestTool.execute(
      { date: TRADING_DATE, stockId: '600519.SH', phase: 'premarket' },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.market).toBeNull();
    expect(result.data.stocks).toEqual([]);
    expect(result.data.missing.map((item) => item.subjectKind).sort()).toEqual(['market', 'stock']);
  });
});

describe('forum evidence guard (buy/sell must not rest on forum alone)', () => {
  it('rejects buy/sell when every evidence line cites the forum', () => {
    const violations = forumOnlyEvidenceViolations({
      decision: 'buy',
      evidence: ['股吧偏多 72%', '讨论热度上升，人气榜前 100'],
      discussionsAvailable: true,
      nonForumSections: ['quote', 'indicators'],
    });
    expect(violations.join()).toContain('不能只引用股吧讨论');
  });

  it('accepts buy/sell with at least one non-forum fact and watch without one', () => {
    expect(
      forumOnlyEvidenceViolations({
        decision: 'sell',
        evidence: ['股吧偏空 65%', '收盘价 102.4 低于 MA20 103.1'],
        discussionsAvailable: true,
        nonForumSections: ['quote', 'indicators'],
      }),
    ).toEqual([]);
    expect(
      forumOnlyEvidenceViolations({
        decision: 'watch',
        evidence: ['股吧偏多 72%'],
        discussionsAvailable: true,
        nonForumSections: ['quote'],
      }),
    ).toEqual([]);
  });

  it('rejects buy/sell when nothing but the forum is available that day', () => {
    const violations = forumOnlyEvidenceViolations({
      decision: 'buy',
      evidence: ['股吧偏多 72%'],
      discussionsAvailable: true,
      nonForumSections: [],
    });
    expect(violations.join()).toContain('只能降级为 watch/avoid');
  });

  it('is a no-op when no discussion digest is available', () => {
    expect(
      forumOnlyEvidenceViolations({
        decision: 'buy',
        evidence: ['股吧偏多 72%'],
        discussionsAvailable: false,
        nonForumSections: [],
      }),
    ).toEqual([]);
  });
});
