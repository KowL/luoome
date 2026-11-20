import { readFileSync, writeFileSync } from 'node:fs';
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
  DragonTigerFlowManagerLike,
  DragonTigerManagerLike,
  LimitUpBoardAdapterLike,
  LimitUpLadderManagerLike,
  LimitUpMarketManagerLike,
  Logger,
  ManagedPluginId,
  MarketDumpAdapterLike,
  NewsManagerLike,
  NorthboundFlowManagerLike,
  RepositoryRegistry,
  SectorCatalogAdapterLike,
  SectorQuoteManagerLike,
  StockUniverseManagerLike,
  ToolContext,
  ToolResult,
} from '@luoome/core';
import { MANAGED_PLUGIN_IDS } from '@luoome/core';
import { createMemoryRepositories, seedData } from '@luoome/db/memory';
import { saveDecisionReviewTool } from '@luoome/toolkit/tools/decision-review.js';
import { createPluginExecutionPolicy } from '../plugin-policy.js';

export interface BuildTestContextOptions {
  readonly executionPolicy?: ToolContext['executionPolicy'];
  readonly clock?: () => Date;
  readonly marketTimestampSource?: 'upstream' | 'retrieval';
  readonly logger?: Logger;
  readonly advices?: readonly Advice[];
  /** 可选注入连板天梯 manager（Phase 2 接入 web API 测试）。 */
  readonly limitUpLadder?: LimitUpLadderManagerLike;
  /** 可选注入涨停市场看板 manager。 */
  readonly limitUpMarket?: LimitUpMarketManagerLike;
  /** 可选注入龙虎榜 manager。 */
  readonly dragonTiger?: DragonTigerManagerLike;
  /** 可选注入龙虎榜资金流向拓扑 manager。 */
  readonly dragonTigerFlow?: DragonTigerFlowManagerLike;
  /** 可选注入北向资金历史流 manager。 */
  readonly northboundFlow?: NorthboundFlowManagerLike;
  /** 可选注入财经要闻 manager。 */
  readonly news?: NewsManagerLike;
  /** 可选注入行业板块行情 manager。 */
  readonly sectorQuote?: SectorQuoteManagerLike;
  readonly stockUniverse?: StockUniverseManagerLike;
  /** 可选注入行业 / 概念目录数据源（同步 tool 用）。 */
  readonly sectorCatalog?: SectorCatalogAdapterLike;
  readonly ashareSentiment?: AShareSentimentManagerLike;
  readonly marketDump?: MarketDumpAdapterLike;
  readonly limitUpBoard?: LimitUpBoardAdapterLike;
}

const createSilentLogger = (): Logger => {
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
};

const defaultBusinessClock = (): Date => new Date(Math.max(DEFAULT_TEST_NOW.getTime(), Date.now()));

/** 测试夹具：直接改写 `plugins.json` 的启用位（生产侧没有写入接口）。 */
export const setPluginEnabled = (path: string, id: ManagedPluginId, enabled: boolean) => {
  const raw = (() => {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as {
        version: 1;
        entries: Record<string, { enabled: boolean }>;
      };
    } catch {
      return { version: 1 as const, entries: {} as Record<string, { enabled: boolean }> };
    }
  })();
  raw.entries[id] = { enabled };
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
};

export const createTestPluginControl = (home: string, enabled: readonly ManagedPluginId[] = []) => {
  const path = join(home, 'plugins.json');
  const store = new PluginConfigStore(path);
  writeFileSync(
    path,
    `${JSON.stringify({
      version: 1,
      entries: Object.fromEntries(
        MANAGED_PLUGIN_IDS.map((id) => [id, { enabled: enabled.includes(id) }]),
      ),
    })}\n`,
  );
  const set = (id: ManagedPluginId, enabled: boolean) => setPluginEnabled(path, id, enabled);
  return {
    store,
    set,
    path,
    initial: { version: 1 as const, entries: {} },
    executionPolicy: createPluginExecutionPolicy(
      store,
      new Set(['read', 'advice', 'write', 'external']),
    ),
  };
};

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
    ...(opts.limitUpMarket === undefined ? {} : { limitUpMarket: opts.limitUpMarket }),
    ...(opts.dragonTiger === undefined ? {} : { dragonTiger: opts.dragonTiger }),
    ...(opts.dragonTigerFlow === undefined ? {} : { dragonTigerFlow: opts.dragonTigerFlow }),
    ...(opts.northboundFlow === undefined ? {} : { northboundFlow: opts.northboundFlow }),
    ...(opts.news === undefined ? {} : { news: opts.news }),
    ...(opts.sectorQuote === undefined ? {} : { sectorQuote: opts.sectorQuote }),
    ...(opts.ashareSentiment === undefined ? {} : { ashareSentiment: opts.ashareSentiment }),
  };
  const ctx: ToolContext = {
    executionPolicy:
      opts.executionPolicy ??
      createPluginExecutionPolicy(
        { isEnabled: () => true },
        new Set(['read', 'advice', 'write', 'external']),
      ),
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
      ...(opts.sectorCatalog === undefined ? {} : { sectorCatalog: opts.sectorCatalog }),
      ...(opts.marketDump === undefined ? {} : { marketDump: opts.marketDump }),
      ...(opts.limitUpBoard === undefined ? {} : { limitUpBoard: opts.limitUpBoard }),
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
    reportDelivery?: { reportId: string; attemptId: string };
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
    if (input.reportDelivery !== undefined)
      await repos.report.completeDelivery({
        ...input.reportDelivery,
        notificationId: id,
        now: notification.sentAt,
      });
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

import { join } from 'node:path';
import { PluginConfigStore } from '@luoome/adapters';
