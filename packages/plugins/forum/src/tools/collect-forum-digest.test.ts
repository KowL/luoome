import {
  type ForumHotListSnapshot,
  type ForumManagerLike,
  type ForumPopularitySnapshot,
  type ForumPostsSnapshot,
  money,
  type Quote,
  stockCode,
  type ToolContext,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { createDrizzleRepos } from '../../../../db/src/client.js';
import { collectForumDigests } from '../internal/collect.js';
import { collectForumDigestTool } from './collect-forum-digest.js';

const NOW = new Date('2026-11-26T07:40:00.000Z');
const TRADING_DATE = '2026-11-26';
const STOCK_ID = '600519.SH';

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const post = (index: number) => ({
  postId: `p-${index}`,
  title: `第 ${index} 帖 看多，突破后加仓`,
  content: '量能够了。',
  author: `作者${index}`,
  authorId: `u-${index}`,
  publishedAt: new Date(`${TRADING_DATE}T${String(9 + (index % 5)).padStart(2, '0')}:00:00+08:00`),
  postType: 'user' as const,
  clicks: 100 + index,
  replies: index,
});

class FakeForumManager implements ForumManagerLike {
  readonly name = 'forum' as const;
  readonly sources = ['eastmoney'];
  postsCalls = 0;
  popularityCalls = 0;
  hotListCalls = 0;

  constructor(
    private readonly options: {
      readonly posts?: ForumPostsSnapshot;
      readonly postsError?: string;
      readonly popularity?: ForumPopularitySnapshot;
      readonly hotList?: ForumHotListSnapshot;
    } = {},
  ) {}

  fetchPosts(): Promise<{ ok: true; data: ForumPostsSnapshot }> {
    this.postsCalls += 1;
    if (this.options.postsError !== undefined) {
      throw new Error(this.options.postsError);
    }
    return Promise.resolve({
      ok: true,
      data: this.options.posts ?? {
        code: '600519',
        posts: Array.from({ length: 10 }, (_, index) => post(index)),
        fetchedAt: NOW,
        pagesFetched: 2,
        warnings: [],
      },
    });
  }

  fetchPopularity(): Promise<{ ok: true; data: ForumPopularitySnapshot }> {
    this.popularityCalls += 1;
    return Promise.resolve({
      ok: true,
      data: this.options.popularity ?? {
        code: STOCK_ID,
        rank: 88,
        rankChange: -46,
        marketStockCount: 5581,
        calcTime: new Date('2026-11-26T07:36:00.000Z'),
        fetchedAt: NOW,
      },
    });
  }

  fetchHotList(): Promise<{ ok: true; data: ForumHotListSnapshot }> {
    this.hotListCalls += 1;
    return Promise.resolve({
      ok: true,
      data: this.options.hotList ?? {
        rows: [
          { code: 'SZ002242', rank: 1, rankChange: 0 },
          { code: 'SH600519', rank: 2, rankChange: 5 },
          { code: 'SZ000001', rank: 3, rankChange: -2 },
        ],
        fetchedAt: NOW,
      },
    });
  }

  status(): readonly [] {
    return [];
  }
}

const makeContext = async (
  forum: ForumManagerLike | undefined,
  options: { readonly enabled?: boolean; readonly quote?: Quote | null } = {},
): Promise<{ ctx: ToolContext; close: () => void }> => {
  const handle = createDrizzleRepos(':memory:');
  await handle.repos.stock.save({
    id: STOCK_ID,
    code: stockCode('600519'),
    exchange: 'SH',
    name: '贵州茅台',
  });
  if (options.quote !== null) {
    await handle.repos.quote.save(
      options.quote ?? {
        stockId: STOCK_ID,
        observedAt: new Date('2026-11-26T07:00:00.000Z'),
        fetchedAt: new Date('2026-11-26T07:00:00.000Z'),
        timestampSource: 'retrieval' as const,
        ts: new Date('2026-11-26T07:00:00.000Z'),
        open: money(100),
        high: money(103),
        low: money(99),
        close: money(102),
        prevClose: money(100),
        volume: 1_000_000,
        source: 'test',
      },
    );
  }
  const enabled = options.enabled ?? true;
  const ctx = {
    repos: handle.repos,
    adapters: {
      market: { name: 'test' },
      llm: {},
      ...(forum === undefined ? {} : { marketIntel: { forum } }),
    },
    user: { id: 'test-user', defaultAccountId: '' },
    clock: () => NOW,
    logger: silentLogger,
    executionPolicy: {
      isEnabled: (id: string) => (id === 'business.forum' ? enabled : false),
      bind() {
        return this;
      },
      authorizeTool: () => null,
      assertTool: () => undefined,
      scopeKey: (name: string) => name,
      runTool: (_name: string, operation: () => Promise<unknown>) => operation(),
      runPlugin: (_id: string, operation: () => Promise<unknown>) => operation(),
    },
  } as unknown as ToolContext;
  return { ctx, close: () => handle.close() };
};

describe('collectForumDigests', () => {
  it('writes market breadth + stock digest with popularity and same-day quote consistency', async () => {
    const manager = new FakeForumManager();
    const { ctx, close } = await makeContext(manager);
    try {
      const summary = await collectForumDigests(
        ctx,
        { tradingDate: TRADING_DATE, phase: 'post-market', stockIds: [STOCK_ID] },
        { enabled: true, now: () => NOW },
      );
      expect(summary.items.map((item) => item.subjectKind).sort()).toEqual(['market', 'stock']);
      expect(summary.items.every((item) => item.coverage === 'ok')).toBe(true);
      expect(manager.hotListCalls).toBe(1);
      expect(manager.postsCalls).toBe(1);

      const market = await ctx.repos.forumDigest.find({
        subjectKind: 'market',
        subjectId: 'market',
        tradingDate: TRADING_DATE,
        phase: 'post-market',
      });
      expect(market?.breadth).toEqual({
        hotListSize: 3,
        hotListExchanges: { sh: 1, sz: 2, other: 0 },
        rankChangeMedian: 0,
      });
      expect(market?.stance).toBeNull();

      const stock = await ctx.repos.forumDigest.find({
        subjectKind: 'stock',
        subjectId: STOCK_ID,
        tradingDate: TRADING_DATE,
        phase: 'post-market',
      });
      expect(stock?.stance?.direction).toBe('bullish');
      expect(stock?.attention.popularity?.rank).toBe(88);
      expect(stock?.attention.popularity?.percentile).toBeCloseTo(1 - 87 / 5581, 10);
      expect(stock?.attention.ownHistory?.postsPercentile).toBeNull();
      expect(stock?.consistency.status).toBe('aligned');
      expect(stock?.excerpts.length).toBeLessThanOrEqual(5);
      expect(stock?.excerpts.every((item) => item.untrusted && item.title.length <= 120)).toBe(
        true,
      );
    } finally {
      close();
    }
  });

  it('degrades to unavailable digests without throwing when the source fails', async () => {
    const manager = new FakeForumManager({ postsError: 'HTTP 502' });
    manager.fetchPosts = () => Promise.reject(new Error('HTTP 502'));
    const { ctx, close } = await makeContext(manager);
    try {
      const summary = await collectForumDigests(
        ctx,
        { tradingDate: TRADING_DATE, phase: 'post-market', stockIds: [STOCK_ID] },
        { enabled: true, now: () => NOW },
      );
      const stockItem = summary.items.find((item) => item.subjectKind === 'stock');
      expect(stockItem?.coverage).toBe('unavailable');
      expect(stockItem?.reason).toContain('HTTP 502');
      const stock = await ctx.repos.forumDigest.find({
        subjectKind: 'stock',
        subjectId: STOCK_ID,
        tradingDate: TRADING_DATE,
        phase: 'post-market',
      });
      expect(stock?.coverage.status).toBe('unavailable');
      expect(stock?.stance).toBeNull();
      expect(stock?.consistency.status).toBe('unknown');
    } finally {
      close();
    }
  });

  it('skips without any network access when the plugin is disabled', async () => {
    const manager = new FakeForumManager();
    const { ctx, close } = await makeContext(manager, { enabled: false });
    try {
      const summary = await collectForumDigests(
        ctx,
        { tradingDate: TRADING_DATE, phase: 'post-market', stockIds: [STOCK_ID] },
        { enabled: false, now: () => NOW },
      );
      expect(summary.items).toHaveLength(1);
      expect(summary.items[0]?.reason).toContain('未启用');
      expect(manager.postsCalls + manager.hotListCalls + manager.popularityCalls).toBe(0);
      expect(await ctx.repos.forumDigest.findByDay({ tradingDate: TRADING_DATE })).toEqual([]);
    } finally {
      close();
    }
  });

  it('withholds consistency when the cached quote is not from the trading day', async () => {
    const manager = new FakeForumManager();
    const staleQuote: Quote = {
      stockId: STOCK_ID,
      observedAt: new Date('2026-11-25T07:00:00.000Z'),
      fetchedAt: new Date('2026-11-25T07:00:00.000Z'),
      timestampSource: 'retrieval',
      ts: new Date('2026-11-25T07:00:00.000Z'),
      open: money(100),
      high: money(103),
      low: money(99),
      close: money(102),
      prevClose: money(100),
      volume: 1_000_000,
      source: 'test',
    };
    const { ctx, close } = await makeContext(manager, { quote: staleQuote });
    try {
      await collectForumDigests(
        ctx,
        { tradingDate: TRADING_DATE, phase: 'post-market', stockIds: [STOCK_ID] },
        { enabled: true, now: () => NOW },
      );
      const stock = await ctx.repos.forumDigest.find({
        subjectKind: 'stock',
        subjectId: STOCK_ID,
        tradingDate: TRADING_DATE,
        phase: 'post-market',
      });
      expect(stock?.consistency.status).toBe('unknown');
      expect(stock?.consistency.reasons.join()).toContain('缺少当日涨跌幅');
    } finally {
      close();
    }
  });
});

describe('collect_forum_digest tool', () => {
  it('declares write + external capabilities and resolves stock codes to ids', async () => {
    expect(collectForumDigestTool.sideEffect).toBe('write');
    expect(collectForumDigestTool.requiredCapabilities).toEqual(['write', 'external']);
    const manager = new FakeForumManager();
    const { ctx, close } = await makeContext(manager);
    try {
      const result = await collectForumDigestTool.execute(
        { tradingDate: TRADING_DATE, stockIds: ['600519'] },
        ctx,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.items.some((item) => item.subjectId === STOCK_ID)).toBe(true);
      expect(result.data.tradingDate).toBe(TRADING_DATE);
      expect(result.data.phase).toBe('post-market');
    } finally {
      close();
    }
  });
});
