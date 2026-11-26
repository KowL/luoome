import {
  analyzeForumPosts,
  dateInShanghai,
  deriveForumConsistency,
  deriveForumPostsPercentile,
  derivePopularityPercentile,
  FORUM_EXCERPT_LIMIT,
  FORUM_MARKET_SUBJECT_ID,
  type ForumDigest,
  type ForumDigestCollectionItem,
  type ForumDigestCollectionSummary,
  type ForumDigestCollectorLike,
  type ForumManagerLike,
  forumDigestWindow,
  type StockBriefPhase,
  type ToolContext,
} from '@luoome/core';

/**
 * 股吧讨论采集服务（宿主窄端口与 collect_forum_digest tool 共用）。
 *
 * - 候选股由调用方给出（论坛不扩池）；市场摘要总在候选集之外单独采集；
 * - 采集失败只写入 coverage=unavailable 的摘要并返回 availability，不抛错、不阻塞建议；
 * - 每只股票最多 2 页列表（约 160 帖）+ 1 次人气排名；市场 1 次榜单。HTTP 有界；
 * - `business.forum` 未启用时直接跳过，不触网。
 */

export const FORUM_COLLECTION_MAX_STOCKS = 12;
export const FORUM_CONCURRENCY = 2;
export const FORUM_POST_PAGES = 2;
export const FORUM_HOT_LIST_SIZE = 100;
export const FORUM_HISTORY_LOOKBACK_DAYS = 20;

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const unavailableDigest = (input: {
  readonly subjectKind: 'market' | 'stock';
  readonly subjectId: string;
  readonly tradingDate: string;
  readonly phase: StockBriefPhase;
  readonly reason: string;
  readonly source: string;
  readonly now: Date;
  readonly window: { readonly start: Date; readonly end: Date };
  readonly consistencyReason: string;
}): ForumDigest => {
  const window = input.window;
  return {
    id: `forum-digest-${input.subjectKind}-${input.subjectId}-${input.tradingDate}-${input.phase}`,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    tradingDate: input.tradingDate,
    phase: input.phase,
    source: input.source,
    dataAsOf: input.now,
    windowStart: window.start,
    windowEnd: window.end,
    coverage: {
      status: 'unavailable',
      fetchedPosts: 0,
      windowPosts: 0,
      effectivePosts: 0,
      mediaPosts: 0,
      removed: {
        outsideWindow: 0,
        duplicate: 0,
        promotional: 0,
        instructionLike: 0,
        empty: 0,
        nonUser: 0,
      },
      reasons: [input.reason],
    },
    quality: { level: 'insufficient', reasons: [input.reason] },
    attention: {
      posts: 0,
      authors: 0,
      replies: 0,
      clicks: 0,
      likes: 0,
      topAuthorShare: 0,
    },
    stance: null,
    excerpts: [],
    consistency: {
      status: 'unknown',
      basis: [],
      reasons: [input.consistencyReason],
    },
    missing: [
      { dimension: 'posts', reason: input.reason },
      { dimension: 'stance', reason: '采集不可用，不发布多空倾向' },
      { dimension: 'consistency', reason: input.consistencyReason },
    ],
    createdAt: input.now,
    updatedAt: input.now,
  };
};

/** 当日行情涨跌幅；行情不是当日（陈旧）时返回 undefined，不用旧数据冒充今天。 */
export const tradingDayQuoteChangePct = async (
  ctx: ToolContext,
  stockId: string,
  tradingDate: string,
): Promise<number | undefined> => {
  const quote = await ctx.repos.quote.latestByStock(stockId);
  if (quote === null) return undefined;
  const observedAt = quote.observedAt ?? quote.ts;
  if (observedAt === undefined || dateInShanghai(observedAt) !== tradingDate) return undefined;
  const prevClose = quote.prevClose;
  if (prevClose === undefined || prevClose <= 0) return undefined;
  return ((quote.close - prevClose) / prevClose) * 100;
};

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
};

const exchangeOf = (securityCode: string): 'sh' | 'sz' | 'other' => {
  const prefix = securityCode.slice(0, 2).toUpperCase();
  if (prefix === 'SH') return 'sh';
  if (prefix === 'SZ') return 'sz';
  return 'other';
};

const buildMarketDigest = async (input: {
  readonly ctx: ToolContext;
  readonly manager: ForumManagerLike | undefined;
  readonly tradingDate: string;
  readonly phase: StockBriefPhase;
  readonly now: Date;
}): Promise<ForumDigest> => {
  const window = forumDigestWindow(input.tradingDate, input.phase);
  const source = input.manager?.sources[0] ?? 'eastmoney';
  if (input.manager === undefined) {
    return unavailableDigest({
      subjectKind: 'market',
      subjectId: FORUM_MARKET_SUBJECT_ID,
      tradingDate: input.tradingDate,
      phase: input.phase,
      reason: '未配置股吧数据源（marketIntel.forum）',
      source,
      now: input.now,
      window,
      consistencyReason: '没有市场广度事实，无法判断盘面情绪',
    });
  }
  const result = await input.manager.fetchHotList(FORUM_HOT_LIST_SIZE);
  if (!result.ok) {
    return unavailableDigest({
      subjectKind: 'market',
      subjectId: FORUM_MARKET_SUBJECT_ID,
      tradingDate: input.tradingDate,
      phase: input.phase,
      reason: result.error.message,
      source,
      now: input.now,
      window,
      consistencyReason: '人气榜不可用，无法判断市场广度',
    });
  }
  const rows = result.data.rows;
  if (rows.length === 0) {
    return unavailableDigest({
      subjectKind: 'market',
      subjectId: FORUM_MARKET_SUBJECT_ID,
      tradingDate: input.tradingDate,
      phase: input.phase,
      reason: '人气榜返回空列表',
      source,
      now: input.now,
      window,
      consistencyReason: '人气榜为空，无法判断市场广度',
    });
  }
  const exchanges = { sh: 0, sz: 0, other: 0 };
  for (const row of rows) exchanges[exchangeOf(row.code)] += 1;
  const rankChanges = rows.flatMap((row) => (row.rankChange === undefined ? [] : [row.rankChange]));
  return {
    id: `forum-digest-market-${input.tradingDate}-${input.phase}`,
    subjectKind: 'market',
    subjectId: FORUM_MARKET_SUBJECT_ID,
    tradingDate: input.tradingDate,
    phase: input.phase,
    source,
    dataAsOf: result.data.fetchedAt,
    windowStart: window.start,
    windowEnd: window.end,
    coverage: {
      status: 'ok',
      fetchedPosts: rows.length,
      windowPosts: 0,
      effectivePosts: 0,
      mediaPosts: 0,
      removed: {
        outsideWindow: 0,
        duplicate: 0,
        promotional: 0,
        instructionLike: 0,
        empty: 0,
        nonUser: 0,
      },
      reasons: [],
    },
    quality: {
      level: 'insufficient',
      reasons: ['市场级只采集人气榜广度，不基于全市场逐帖样本发布多空倾向'],
    },
    attention: {
      posts: 0,
      authors: 0,
      replies: 0,
      clicks: 0,
      likes: 0,
      topAuthorShare: 0,
    },
    breadth: {
      hotListSize: rows.length,
      hotListExchanges: exchanges,
      rankChangeMedian: median(rankChanges),
    },
    stance: null,
    excerpts: [],
    consistency: {
      status: 'unknown',
      basis: [
        `人气榜前 ${rows.length} 名：沪 ${exchanges.sh} / 深 ${exchanges.sz}${exchanges.other === 0 ? '' : ` / 其它 ${exchanges.other}`}`,
        rankChanges.length === 0 ? '榜单未返回名次变化' : `名次变化中位数 ${median(rankChanges)}`,
      ],
      reasons: ['市场级不发布多空倾向，广度只作为盘面情绪的旁证'],
    },
    missing: [
      {
        dimension: 'stance',
        reason: '市场级未采集逐帖样本，不发布多空倾向',
      },
    ],
    createdAt: input.now,
    updatedAt: input.now,
  };
};

const buildStockDigest = async (input: {
  readonly ctx: ToolContext;
  readonly manager: ForumManagerLike | undefined;
  readonly stockId: string;
  readonly code: string;
  readonly tradingDate: string;
  readonly phase: StockBriefPhase;
  readonly now: Date;
}): Promise<ForumDigest> => {
  const window = forumDigestWindow(input.tradingDate, input.phase);
  const source = input.manager?.sources[0] ?? 'eastmoney';
  const quoteChangePct = await tradingDayQuoteChangePct(
    input.ctx,
    input.stockId,
    input.tradingDate,
  );
  if (input.manager === undefined) {
    return unavailableDigest({
      subjectKind: 'stock',
      subjectId: input.stockId,
      tradingDate: input.tradingDate,
      phase: input.phase,
      reason: '未配置股吧数据源（marketIntel.forum）',
      source,
      now: input.now,
      window,
      consistencyReason: '没有讨论样本，无法与盘面交叉验证',
    });
  }
  const posts = await input.manager.fetchPosts({ code: input.code, pages: FORUM_POST_PAGES });
  if (!posts.ok) {
    return unavailableDigest({
      subjectKind: 'stock',
      subjectId: input.stockId,
      tradingDate: input.tradingDate,
      phase: input.phase,
      reason: posts.error.message,
      source,
      now: input.now,
      window,
      consistencyReason: '没有讨论样本，无法与盘面交叉验证',
    });
  }
  const analysis = analyzeForumPosts({
    subjectKind: 'stock',
    posts: posts.data.posts,
    window,
    code: input.code,
  });
  const [popularity, history] = await Promise.all([
    input.manager.fetchPopularity(input.stockId).catch(() => null),
    input.ctx.repos.forumDigest
      .history({
        subjectKind: 'stock',
        subjectId: input.stockId,
        before: input.tradingDate,
        limit: FORUM_HISTORY_LOOKBACK_DAYS,
      })
      .catch(() => []),
  ]);
  const popularityData = popularity?.ok === true ? popularity.data : undefined;
  const marketStockCount = popularityData?.marketStockCount;
  const percentile =
    popularityData === undefined
      ? undefined
      : derivePopularityPercentile(popularityData.rank, marketStockCount);
  const historyPosts = history
    .filter((row) => row.coverage.status === 'ok')
    .map((row) => row.attention.posts);
  const ownHistory = deriveForumPostsPercentile({
    posts: analysis.attention.posts,
    historyPosts,
    windowDays: FORUM_HISTORY_LOOKBACK_DAYS,
  });
  const missing = [...analysis.missing];
  if (popularityData === undefined) {
    missing.push({
      dimension: 'popularity',
      reason: popularity?.ok === false ? popularity.error.message : '人气排名不可用',
    });
  }
  const consistency = deriveForumConsistency({
    stance: analysis.stance,
    ...(quoteChangePct === undefined ? {} : { quoteChangePct }),
  });
  if (consistency.status === 'unknown') {
    missing.push({
      dimension: 'consistency',
      reason: consistency.reasons.join('；') || '无法与盘面交叉验证',
    });
  }
  return {
    id: `forum-digest-stock-${input.stockId}-${input.tradingDate}-${input.phase}`,
    subjectKind: 'stock',
    subjectId: input.stockId,
    tradingDate: input.tradingDate,
    phase: input.phase,
    source,
    dataAsOf: posts.data.fetchedAt,
    windowStart: window.start,
    windowEnd: window.end,
    coverage: analysis.coverage,
    quality: analysis.quality,
    attention: {
      ...analysis.attention,
      ...(popularityData === undefined
        ? {}
        : {
            popularity: {
              rank: popularityData.rank,
              ...(popularityData.rankChange === undefined
                ? {}
                : { rankChange: popularityData.rankChange }),
              ...(marketStockCount === undefined ? {} : { marketStockCount }),
              ...(percentile === undefined ? {} : { percentile }),
              ...(popularityData.calcTime === undefined
                ? {}
                : { calcTime: popularityData.calcTime }),
            },
          }),
      ownHistory,
    },
    stance: analysis.stance,
    excerpts: analysis.excerpts.slice(0, FORUM_EXCERPT_LIMIT),
    consistency,
    missing,
    createdAt: input.now,
    updatedAt: input.now,
  };
};

const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await run(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => worker()),
  );
  return results;
};

interface CollectOptions {
  readonly enabled: boolean;
  readonly now: () => Date;
}

/**
 * 采集市场 + 候选股的讨论摘要并落库。
 * 单票失败只写 unavailable 摘要；整体永不抛错（除非写库本身失败）。
 */
export const collectForumDigests = async (
  ctx: ToolContext,
  input: {
    readonly tradingDate: string;
    readonly phase: StockBriefPhase;
    readonly stockIds: readonly string[];
  },
  options: CollectOptions,
): Promise<ForumDigestCollectionSummary> => {
  if (!options.enabled) {
    return {
      tradingDate: input.tradingDate,
      phase: input.phase,
      items: [
        {
          subjectKind: 'market',
          subjectId: FORUM_MARKET_SUBJECT_ID,
          coverage: 'unavailable',
          reason: 'business.forum 未启用',
        },
      ],
    };
  }
  const manager = ctx.adapters.marketIntel?.forum;
  const now = options.now();
  const stockIds = [
    ...new Set(input.stockIds.map((id) => id.trim()).filter((id) => id.length > 0)),
  ];
  const bounded = stockIds.slice(0, FORUM_COLLECTION_MAX_STOCKS);

  const marketDigest = await buildMarketDigest({
    ctx,
    manager,
    tradingDate: input.tradingDate,
    phase: input.phase,
    now,
  });
  const savedMarket = await ctx.repos.forumDigest.upsert(marketDigest);
  const items: ForumDigestCollectionItem[] = [
    {
      subjectKind: 'market',
      subjectId: FORUM_MARKET_SUBJECT_ID,
      digestId: savedMarket.id,
      coverage: savedMarket.coverage.status,
      ...(savedMarket.coverage.status === 'ok'
        ? {}
        : { reason: savedMarket.coverage.reasons.join('；') || '市场摘要不可用' }),
    },
  ];

  const digests = await mapWithConcurrency(bounded, FORUM_CONCURRENCY, async (stockId) => {
    const stock = await ctx.repos.stock.findById(stockId);
    if (stock === null) {
      return {
        stockId,
        digest: null,
        reason: `标的不存在：${stockId}`,
      } as const;
    }
    const digest = await buildStockDigest({
      ctx,
      manager,
      stockId,
      code: stock.code,
      tradingDate: input.tradingDate,
      phase: input.phase,
      now,
    }).catch((error: unknown) => ({
      ...unavailableDigest({
        subjectKind: 'stock' as const,
        subjectId: stockId,
        tradingDate: input.tradingDate,
        phase: input.phase,
        reason: `讨论采集失败：${errorText(error)}`,
        source: manager?.sources[0] ?? 'eastmoney',
        now,
        window: forumDigestWindow(input.tradingDate, input.phase),
        consistencyReason: '没有讨论样本，无法与盘面交叉验证',
      }),
    }));
    return { stockId, digest } as const;
  });

  for (const entry of digests) {
    if (entry.digest === null) {
      items.push({
        subjectKind: 'stock',
        subjectId: entry.stockId,
        coverage: 'unavailable',
        reason: entry.reason,
      });
      continue;
    }
    const saved = await ctx.repos.forumDigest.upsert(entry.digest);
    items.push({
      subjectKind: 'stock',
      subjectId: saved.subjectId,
      digestId: saved.id,
      coverage: saved.coverage.status,
      ...(saved.coverage.status === 'ok'
        ? {}
        : { reason: saved.coverage.reasons.join('；') || '讨论不可用' }),
    });
  }

  return { tradingDate: input.tradingDate, phase: input.phase, items };
};

/**
 * 宿主窄端口：只读 `business.forum` 开关，采集失败不抛错。
 *
 * 接受 ctx 或 ctx getter：宿主组装根常常需要「ctx 里再放端口」，用 getter 可避免循环引用。
 */
export const createForumDigestCollector = (
  source: ToolContext | (() => ToolContext),
  now?: () => Date,
): ForumDigestCollectorLike => {
  const ctxOf = typeof source === 'function' ? source : () => source;
  return {
    get enabled(): boolean {
      return ctxOf().executionPolicy?.isEnabled('business.forum') ?? false;
    },
    collect: (input) => {
      const ctx = ctxOf();
      return collectForumDigests(ctx, input, {
        enabled: ctx.executionPolicy?.isEnabled('business.forum') ?? false,
        now: now ?? ctx.clock,
      });
    },
  };
};
