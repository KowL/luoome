import {
  DEFAULT_TEST_NOW,
  FakeLLMAdapter,
  FakeMarketAdapter,
  fixedTestClock,
  TEST_ACCOUNT,
  TEST_ACCOUNTS,
  TEST_HOLDINGS,
  TEST_STOCKS,
  TEST_TRADES,
  testAdviceFor,
} from '@luoome/adapters/testing';
import type {
  Advice,
  AShareSentimentManagerLike,
  DecisionReview,
  DragonTigerManagerLike,
  LimitUpLadderManagerLike,
  Logger,
  NewsManagerLike,
  NorthboundFlowManagerLike,
  RepositoryRegistry,
  SectorQuoteManagerLike,
  StockUniverseManagerLike,
  ToolContext,
  ToolResult,
} from '@luoome/core';
import { createMemoryRepositories, seedData } from '@luoome/db/memory';
import { saveDecisionReviewTool } from '../tools/decision-review.js';

export interface BuildTestContextOptions {
  readonly clock?: () => Date;
  readonly marketTimestampSource?: 'upstream' | 'retrieval';
  readonly logger?: Logger;
  readonly advices?: readonly Advice[];
  /** 可选注入连板天梯 manager（Phase 2 接入 web API 测试）。 */
  readonly limitUpLadder?: LimitUpLadderManagerLike;
  /** 可选注入龙虎榜 manager。 */
  readonly dragonTiger?: DragonTigerManagerLike;
  /** 可选注入北向资金历史流 manager。 */
  readonly northboundFlow?: NorthboundFlowManagerLike;
  /** 可选注入财经要闻 manager。 */
  readonly news?: NewsManagerLike;
  /** 可选注入行业板块行情 manager。 */
  readonly sectorQuote?: SectorQuoteManagerLike;
  readonly stockUniverse?: StockUniverseManagerLike;
  readonly ashareSentiment?: AShareSentimentManagerLike;
}

const createSilentLogger = (): Logger => {
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
};

const defaultBusinessClock = (): Date => new Date(Math.max(DEFAULT_TEST_NOW.getTime(), Date.now()));

/** Deterministic, in-memory context for automated tests only. */
export const buildTestContext = async (
  opts: BuildTestContextOptions = {},
): Promise<ToolContext> => {
  const businessClock = opts.clock ?? defaultBusinessClock;
  const marketClock = opts.clock ?? fixedTestClock;
  const repos = createMemoryRepositories();
  await seedData(repos, {
    accounts: TEST_ACCOUNTS,
    stocks: TEST_STOCKS,
    holdings: TEST_HOLDINGS,
    trades: TEST_TRADES,
  });
  const advices = opts.advices ?? [
    testAdviceFor('002594.SZ', marketClock),
    testAdviceFor('600519.SH', marketClock),
  ];
  if (advices.length > 0) {
    await seedData(repos, { advices });
  }

  const marketIntel = {
    ...(opts.limitUpLadder === undefined ? {} : { limitUpLadder: opts.limitUpLadder }),
    ...(opts.dragonTiger === undefined ? {} : { dragonTiger: opts.dragonTiger }),
    ...(opts.northboundFlow === undefined ? {} : { northboundFlow: opts.northboundFlow }),
    ...(opts.news === undefined ? {} : { news: opts.news }),
    ...(opts.sectorQuote === undefined ? {} : { sectorQuote: opts.sectorQuote }),
    ...(opts.ashareSentiment === undefined ? {} : { ashareSentiment: opts.ashareSentiment }),
  };
  const ctx: ToolContext = {
    repos,
    adapters: {
      market: new FakeMarketAdapter({
        clock: marketClock,
        ...(opts.marketTimestampSource === undefined
          ? {}
          : { timestampSource: opts.marketTimestampSource }),
      }),
      llm: new FakeLLMAdapter(),
      ...(opts.stockUniverse === undefined ? {} : { stockUniverse: opts.stockUniverse }),
      notification: createTestNotificationManager(repos),
      ...(Object.keys(marketIntel).length === 0 ? {} : { marketIntel }),
    },
    user: { id: 'test-user', defaultAccountId: TEST_ACCOUNT.id },
    clock: businessClock,
    logger: opts.logger ?? createSilentLogger(),
  };
  return ctx;
};

export const seedTestStockUniverse = async (
  ctx: ToolContext,
  input: {
    readonly syncId?: string;
    readonly observedAt?: Date;
    readonly limit?: number;
  } = {},
): Promise<void> => {
  const observedAt = input.observedAt ?? new Date('2026-07-28T08:00:00.000Z');
  const stocks = TEST_STOCKS.filter(
    (stock) => stock.exchange === 'SH' || stock.exchange === 'SZ',
  ).slice(0, input.limit);
  await ctx.repos.stockUniverse.applySnapshot({
    syncId: input.syncId ?? 'sync-test-stock-universe',
    appliedAt: observedAt,
    snapshot: {
      source: 'test-universe',
      coverage: 'CN_A_SHARES_SH_SZ',
      observedAt,
      complete: true,
      reportedTotal: stocks.length,
      entries: stocks.map((stock) => ({
        stockId: stock.id,
        code: stock.code,
        exchange: stock.exchange,
        name: stock.name,
        listingStatus: 'listed' as const,
        ...(stock.industry === undefined ? {} : { industry: stock.industry }),
      })),
    },
  });
};

/** 为 active 测试目录预置规范 qfq 日线，供 localDataOnly 的盘外研究刷新使用。 */
export const seedTestDailyBars = async (ctx: ToolContext): Promise<void> => {
  const stocks = await ctx.repos.stockUniverse.listCurrent({
    coverage: 'CN_A_SHARES_SH_SZ',
    status: 'active',
  });
  const end = ctx.clock();
  const start = new Date(end.getTime() - 365 * 86_400_000);
  for (const stock of stocks) {
    const bars = await ctx.adapters.market.fetchDailyBars(stock.id, { start, end });
    await ctx.repos.dailyBar.saveMany(bars);
  }
};

const createTestNotificationManager = (repos: RepositoryRegistry) => ({
  async send(input: {
    id?: string;
    channel: 'feishu' | 'log';
    payload: {
      title: string;
      content: string;
      level: 'info' | 'warn' | 'error' | 'success';
      atMobiles?: string[];
    };
    adviceId?: string;
    tacticSignalId?: string;
  }): Promise<{ notification: unknown }> {
    const id = input.id ?? `test-notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const existing = input.id === undefined ? null : await repos.notification.findById(id);
    if (existing?.result === 'success' || existing?.result === 'suppressed')
      return { notification: existing };
    const notification = {
      id,
      channel: input.channel,
      payload: input.payload,
      result: 'success' as const,
      ...(input.adviceId !== undefined ? { adviceId: input.adviceId } : {}),
      ...(input.tacticSignalId !== undefined ? { tacticSignalId: input.tacticSignalId } : {}),
      sentAt: new Date(),
    };
    await repos.notification.save(notification);
    return { notification };
  },
});

/** 测试夹具：AdviceOutcome 现由 save_decision_review 的 content.adviceFeedback 表达。 */
export const recordAdviceOutcomeForTest = {
  execute: async (
    input: {
      readonly adviceId: string;
      readonly accountId?: string;
      readonly outcome: 'followed' | 'partially_followed' | 'ignored';
      readonly tradeIds?: readonly string[];
      readonly pnl?: number;
      readonly benchmarkPnl?: number;
      readonly holdingHours?: number;
      readonly notes?: string;
    },
    ctx: ToolContext,
  ): Promise<ToolResult<{ review: DecisionReview }>> =>
    saveDecisionReviewTool.execute(
      {
        ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
        subject: { kind: 'advice', id: input.adviceId },
        content: {
          tradeIds: [...(input.tradeIds ?? [])],
          adviceFeedback: {
            outcome: input.outcome,
            ...(input.pnl === undefined ? {} : { pnl: input.pnl }),
            ...(input.benchmarkPnl === undefined ? {} : { benchmarkPnl: input.benchmarkPnl }),
            ...(input.holdingHours === undefined ? {} : { holdingHours: input.holdingHours }),
          },
          lessonTags: [],
          note: input.notes ?? null,
        },
      },
      ctx,
    ),
};
