import type { Account } from '../entity/account.js';
import type { AccountFacts } from '../entity/account-facts.js';
import type { Advice, AdviceOutcome, AdviceOutcomeQuery, AdviceQuery } from '../entity/advice.js';
import type { AlertPlan } from '../entity/alert-plan.js';
import type { ChatMessage, ChatSession } from '../entity/chat-session.js';
import type { DecisionReview, DecisionReviewSubject } from '../entity/decision-review.js';
import type { Holding } from '../entity/holding.js';
import type { LimitUpLadder, LimitUpLadderSource } from '../entity/limit-up-ladder.js';
import type {
  MarketSnapshotBatch,
  MarketSnapshotBatchPublishResult,
} from '../entity/market-snapshot-batch.js';
import type { MinuteBar, MinuteBarInterval } from '../entity/minute-bar.js';
import type { Notification, NotificationResult } from '../entity/notification.js';
import type {
  PortfolioCashFlow,
  PortfolioCorporateAction,
  PortfolioPerformanceSnapshot,
} from '../entity/portfolio-performance.js';
import type { DailyBar, DailyBarRevision, Quote } from '../entity/quote.js';
import type { Report, ReportKind, ReportStatus } from '../entity/report.js';
import type {
  ResearchAvailability,
  ResearchDocumentIndex,
  ResearchDocumentKind,
} from '../entity/research-vault.js';
import type {
  SectorCatalogEntry,
  SectorCatalogState,
  SectorChangeEvent,
  SectorKind,
  SectorSyncApplyInput,
  SectorSyncApplySummary,
  StockSectorMembership,
  StockSectorMembershipView,
} from '../entity/sector-catalog.js';
import type { SignalObservation, SignalObservationStatus } from '../entity/signal-observation.js';
import type { Stock } from '../entity/stock.js';
import type {
  MarketCoverage,
  StockUniverseApplySummary,
  StockUniverseMember,
  StockUniverseSnapshot,
  StockUniverseSyncRun,
} from '../entity/stock-universe.js';
import type {
  Strategy,
  StrategyResult,
  StrategyRun,
  StrategyRunBundle,
  StrategyRunPublicationStatus,
  StrategyRunScope,
  StrategySignal,
  StrategyVersion,
} from '../entity/strategy.js';
import type { StrictBacktestRun } from '../entity/strategy-backtest.js';
import type {
  StrategyWatchlistSubscription,
  StrategyWatchlistSubscriptionStatus,
} from '../entity/strategy-watchlist-subscription.js';
import type { Trade } from '../entity/trade.js';
import type { TradingPlan, TradingPlanQuery } from '../entity/trading-plan.js';
import type {
  DeliveryStatus,
  TriggerFeedback,
  WatchRuleState,
  WatchTrigger,
} from '../entity/watch-trigger.js';
import type {
  MembershipSnapshot,
  Watchlist,
  WatchlistKind,
  WatchlistMember,
  WatchlistMemberSource,
  WatchlistSyncCommit,
  WatchlistSyncRun,
} from '../entity/watchlist.js';
import type { WorkflowRun } from '../entity/workflow-run.js';
import type { HoldingCashAdjustment } from '../portfolio/ledger.js';
import type {
  TradingPlanBudgetLimits,
  TradingPlanBudgetResult,
} from '../portfolio/trading-plan-budget.js';
import type { ResearchSearchHit } from '../research-vault.js';
import type { StrategyDailyCycleAuditQuery } from '../strategy/daily-cycle-audit.js';

/**
 * Repository 接口（ARCHITECTURE §2.5 / §4.3）。
 * core 只定义接口；Drizzle 实现与 in-memory 实现在 packages/db。
 */

export interface AccountRepository {
  save(account: Account): Promise<void>;
  ensureSingleDefault(account: Account): Promise<Account>;
  updateName(id: string, name: string): Promise<Account | null>;
  findById(id: string): Promise<Account | null>;
  list(): Promise<Account[]>;
  remove(id: string): Promise<void>;
}

/**
 * 账户事实写入：把「账户现金余额」与账本事实（交易 / 持仓 / 资金流水）作为**一次原子提交**。
 *
 * 现金是账户上的余额字段，若与交易分开写，崩溃或失败会留下「持仓变了、钱没变」的漂移，
 * 而分母错了比没有分母更危险。所有改动账户事实的写路径都必须走这里，不要各自 save。
 */
export interface LedgerRepository {
  /** 交易 + 持仓 + 账户余额一起提交（买入扣现金、卖出加现金，按成交价，不计手续费）。 */
  applyTrade(input: {
    readonly previousHolding: Holding | null;
    readonly trade: Trade;
    readonly holding: Holding;
  }): Promise<void>;
  /** 持仓改动（登记 / 纠错 / 平仓）+ 账户余额一起提交（按持仓成本差额结算）。 */
  applyHolding(input: {
    readonly previousHolding: Holding | null;
    readonly holding: Holding;
    readonly occurredAt: Date;
  }): Promise<void>;
  /** 资金流水 + 账户余额一起提交（入金/转入/分红为增，出金/转出/费/税为减）。 */
  applyCashFlow(input: { readonly flow: PortfolioCashFlow }): Promise<void>;
  listHoldingAdjustments(accountId: string): Promise<readonly HoldingCashAdjustment[]>;
}

export interface StockRepository {
  save(stock: Stock): Promise<void>;
  findById(id: string): Promise<Stock | null>;
  findByCode(code: string): Promise<Stock | null>;
  /** 按代码 / 名称模糊搜索，供 search_stocks tool 使用。 */
  search(query: string): Promise<Stock[]>;
  remove(id: string): Promise<void>;
}

export interface StockUniverseRepository {
  applySnapshot(input: {
    readonly syncId: string;
    readonly snapshot: StockUniverseSnapshot;
    readonly appliedAt: Date;
  }): Promise<StockUniverseApplySummary>;
  latestSuccessfulSync(input?: {
    readonly source?: string;
    readonly coverage?: MarketCoverage;
  }): Promise<StockUniverseSyncRun | null>;
  listCurrent(input: {
    readonly coverage: MarketCoverage;
    readonly status?: 'active' | 'missing' | 'all';
  }): Promise<readonly Stock[]>;
  /** 当前目录成员及其聚合挂牌状态（停牌 / 退市用于标记状态，不删除身份）。 */
  listCurrentMembers(input: {
    readonly coverage: MarketCoverage;
  }): Promise<readonly StockUniverseMember[]>;
  /** P2 PIT universe：只选择 observedAt 不晚于目标时点的成功快照。 */
  latestSnapshotAtOrBefore(input: {
    readonly coverage: MarketCoverage;
    readonly asOf: Date;
  }): Promise<StockUniverseSyncRun | null>;
  listSnapshotMembers(syncId: string): Promise<readonly Stock[]>;
}

/** 行业 / 概念目录与多对多成分；变更走 append-only 记录，不覆盖历史。 */
export interface SectorCatalogRepository {
  /** 一次同步原子提交：目录、成分、状态与变更记录；同 syncId 重放返回原摘要。 */
  applySync(input: SectorSyncApplyInput): Promise<SectorSyncApplySummary>;
  /** 按股票反查当前所属行业与概念，含来源与时点。 */
  listByStock(input: {
    readonly stockIds: readonly string[];
    readonly kinds?: readonly SectorKind[];
    readonly includeMissing?: boolean;
  }): Promise<readonly StockSectorMembershipView[]>;
  /** 按板块读取成分；默认只返回 active 成分。 */
  listBySector(input: {
    readonly sectorId: string;
    readonly includeMissing?: boolean;
  }): Promise<readonly StockSectorMembership[]>;
  /** 一次读取多个板块的成分（榜单按 kind 批量取成分，避免逐板块查询）；默认只返回 active 成分。 */
  listBySectors(input: {
    readonly sectorIds: readonly string[];
    readonly includeMissing?: boolean;
  }): Promise<readonly StockSectorMembership[]>;
  listSectors(input?: {
    readonly kinds?: readonly SectorKind[];
    readonly state?: SectorCatalogState | 'all';
  }): Promise<readonly SectorCatalogEntry[]>;
  listChanges(input?: {
    readonly sectorId?: string;
    readonly stockId?: string;
  }): Promise<readonly SectorChangeEvent[]>;
}

/** 已审计的按交易日涨停天梯 PIT 快照；replay 只允许读取此仓储。 */
export interface LimitUpLadderSnapshotRepository {
  save(snapshot: LimitUpLadder): Promise<void>;
  findByDate(input: {
    readonly date: string;
    readonly source: LimitUpLadderSource;
  }): Promise<LimitUpLadder | null>;
}

/** 盘中全市场批次：按采样时点不可变发布，重复发布同一批次不产生第二份。 */
export interface MarketSnapshotBatchRepository {
  /** 幂等发布；同批次已存在时保留首次发布内容并返回 created=false。 */
  publish(batch: MarketSnapshotBatch): Promise<MarketSnapshotBatchPublishResult>;
  findById(id: string): Promise<MarketSnapshotBatch | null>;
  /** 最近一个已发布批次（按采样时点倒序）。 */
  findLatest(input?: { readonly coverage?: MarketCoverage }): Promise<MarketSnapshotBatch | null>;
  /**
   * 指定交易日、指定采样时点容差内的最近批次（昨日同时点对比用）。
   * 超出容差返回 null，不拿相邻时点的批次冒充同一时刻。
   */
  findNearestAt(input: {
    readonly coverage?: MarketCoverage;
    readonly tradingDate: string;
    readonly sampledAt: Date;
    readonly toleranceMs: number;
  }): Promise<MarketSnapshotBatch | null>;
  /**
   * 指定交易日、某个时点及之前最近的已发布批次（盘中榜锚点与窗口起点用）。
   * 不跨交易日取值；该日没有更早批次时返回 null。
   */
  findAtOrBefore(input: {
    readonly coverage?: MarketCoverage;
    readonly tradingDate: string;
    readonly sampledAt: Date;
  }): Promise<MarketSnapshotBatch | null>;
  /**
   * 指定交易日全部已发布批次，按采样时点升序（板块详情走势用）。
   * 只返回该交易日；没有批次时返回空数组，不跨交易日补齐。
   */
  listByTradingDate(input: {
    readonly coverage?: MarketCoverage;
    readonly tradingDate: string;
  }): Promise<MarketSnapshotBatch[]>;
}

export interface HoldingRepository {
  save(holding: Holding): Promise<void>;
  findById(id: string): Promise<Holding | null>;
  findByAccountAndStock(accountId: string, stockId: string): Promise<Holding | null>;
  listByAccount(accountId: string): Promise<Holding[]>;
  remove(id: string): Promise<void>;
}

export interface TradeRepository {
  save(trade: Trade): Promise<void>;
  findById(id: string): Promise<Trade | null>;
  listByAccount(
    accountId: string,
    filter?: {
      readonly stockId?: string;
      /** 包含起点，筛选先于排序和截取。 */
      readonly executedAtFrom?: Date;
      readonly order?: 'asc' | 'desc';
      readonly limit?: number;
    },
  ): Promise<Trade[]>;
  remove(id: string): Promise<void>;
}

export interface DecisionReviewRepository {
  findBySubject(input: {
    readonly accountId: string;
    readonly subject: DecisionReviewSubject;
  }): Promise<DecisionReview | null>;
  findById(input: {
    readonly accountId: string;
    readonly id: string;
  }): Promise<DecisionReview | null>;
  /** 按最近更新时间倒序；since 含起点、until 不含终点。 */
  list(input: {
    readonly accountId: string;
    readonly stockId?: string;
    readonly subjectKind?: DecisionReviewSubject['kind'];
    readonly subjectId?: string;
    readonly since?: Date;
    readonly until?: Date;
    readonly cursor?: { readonly updatedAt: Date; readonly id: string };
    readonly limit?: number;
  }): Promise<readonly DecisionReview[]>;
  /** (account, subject) 唯一：已存在时保留原 id/createdAt 并整体替换内容。 */
  save(review: DecisionReview): Promise<DecisionReview>;
}

export interface PortfolioCashFlowRepository {
  save(flow: PortfolioCashFlow): Promise<void>;
  findById(id: string): Promise<PortfolioCashFlow | null>;
  listByAccount(accountId: string, from?: Date, to?: Date): Promise<PortfolioCashFlow[]>;
  remove(id: string): Promise<void>;
}

export interface PortfolioCorporateActionRepository {
  save(action: PortfolioCorporateAction): Promise<void>;
  findById(id: string): Promise<PortfolioCorporateAction | null>;
  listByAccount(accountId: string, from?: Date, to?: Date): Promise<PortfolioCorporateAction[]>;
  remove(id: string): Promise<void>;
}

export interface PortfolioPerformanceSnapshotRepository {
  save(snapshot: PortfolioPerformanceSnapshot): Promise<void>;
  findById(id: string): Promise<PortfolioPerformanceSnapshot | null>;
  findByFingerprint(input: {
    readonly accountId: string;
    readonly from: Date;
    readonly to: Date;
    readonly inputFingerprint: string;
  }): Promise<PortfolioPerformanceSnapshot | null>;
  listByAccount(
    accountId: string,
    limit?: number,
  ): Promise<readonly PortfolioPerformanceSnapshot[]>;
  /** 查询与区间有重叠的快照，按计算时间倒序，供长区间审计避免只取最新快照。 */
  listByAccountAndRange(
    accountId: string,
    from: Date,
    to: Date,
    limit?: number,
  ): Promise<readonly PortfolioPerformanceSnapshot[]>;
  remove(id: string): Promise<void>;
}

/**
 * 行情快照仓储（v0.2 起）。
 * price_snapshots 表 (stockId, ts) 复合主键 → 同 ts 重复写入视为覆盖。
 * 主要给 sync_quotes / fetch_quote 等 external 工具写库做历史回放。
 */
export interface QuoteRepository {
  save(quote: Quote): Promise<void>;
  /** 单只股票的最新快照；since 缺省返回最新一条。 */
  latestByStock(stockId: string, since?: Date): Promise<Quote | null>;
  /** 多只股票的最新快照（一次查全表，按 stockId 聚合取 max(ts)）。 */
  latestByStocks(stockIds: readonly string[]): Promise<Map<string, Quote>>;
  /** 区间查询（按 ts 升序），供 K 线 / 自定义窗口使用。 */
  listInRange(stockId: string, from: Date, to: Date): Promise<Quote[]>;
  removeInRange(stockId: string, before: Date): Promise<number>;
}

/**
 * 日线仓储（v0.2 起）。
 * daily_bars 表 (stockId, date) 复合主键 → 同日重复写入视为覆盖。
 * 行情 adapter 用它做 1 小时级缓存（避免每次 analyze 都打远端）。
 */
export interface DailyBarRepository {
  saveMany(bars: readonly DailyBar[]): Promise<void>;
  /** 取区间内日线（按 date 升序）；无缓存时返回空数组，由 adapter 决定是否回源。 */
  findInRange(stockId: string, from: Date, to: Date): Promise<DailyBar[]>;
  /** 取 ≤ to 的最近 N 根日线（按 date 降序取 N，再升序返回）。 */
  latestBefore(stockId: string, to: Date, count: number): Promise<DailyBar[]>;
  removeInRange(stockId: string, before: Date): Promise<number>;
  saveRevisions(revisions: readonly DailyBarRevision[]): Promise<void>;
  listRevisions(input: {
    readonly stockId: string;
    readonly from?: Date;
    readonly to?: Date;
    readonly recordedAt?: Date;
  }): Promise<readonly DailyBarRevision[]>;
  /** 横截面研究批量读取 PIT revision；实现内部负责 SQLite 参数分块并保持稳定排序。 */
  listRevisionsForStocks(input: {
    readonly stockIds: readonly string[];
    readonly from?: Date;
    readonly to?: Date;
    readonly recordedAt?: Date;
  }): Promise<readonly DailyBarRevision[]>;
}

/**
 * Append-only 基本面事实修订仓储；PIT vintage 选择仍由 core strict resolver 定义。
 * 实现必须同时提供 Drizzle/SQLite 与 in-memory 版本，并保持查询排序和副本语义一致。
 */
/** 独立分钟行情仓储；不读取或投影 PriceSnapshot。 */
export interface MinuteBarRepository {
  saveMany(bars: readonly MinuteBar[]): Promise<void>;
  findInRange(
    stockId: string,
    interval: MinuteBarInterval,
    from: Date,
    to: Date,
  ): Promise<MinuteBar[]>;
  latestSession(stockId: string, interval: MinuteBarInterval): Promise<MinuteBar[]>;
  /** 全局保留期清理；返回实际删除行数。 */
  removeBefore(before: Date): Promise<number>;
}

export interface AdviceRepository {
  save(advice: Advice): Promise<void>;
  findById(id: string): Promise<Advice | null>;
  query(filter: AdviceQuery): Promise<Advice[]>;
  recordOutcome(adviceId: string, outcome: AdviceOutcome): Promise<void>;
  findOutcome(adviceId: string): Promise<AdviceOutcome | null>;
  listOutcomes(filter?: AdviceOutcomeQuery): Promise<AdviceOutcome[]>;
  /** 删除建议并级联删除其 outcome（advice_outcomes 无 FK，两实现都显式清理）；id 不存在时为幂等空操作。 */
  remove(id: string): Promise<void>;
}

/** 逐股结构化计划版本；版本 immutable，active 状态切换由新版本替代表达。 */
export interface TradingPlanRepository {
  save(plan: TradingPlan): Promise<void>;
  /** 在同一持久化事务内核对账户事实、读取当前计划预算并条件写入 active 版本。 */
  saveIfBudgetAvailable(input: {
    readonly plan: TradingPlan;
    readonly facts: AccountFacts;
    readonly stocks: ReadonlyMap<string, Stock>;
    readonly limits: TradingPlanBudgetLimits;
    readonly asOf: Date;
  }): Promise<
    | { readonly saved: true; readonly budget: TradingPlanBudgetResult }
    | {
        readonly saved: false;
        readonly reason: 'budget-exceeded';
        readonly budget: TradingPlanBudgetResult;
      }
    | { readonly saved: false; readonly reason: 'account-facts-changed' }
  >;
  findByVersionId(versionId: string): Promise<TradingPlan | null>;
  list(query?: TradingPlanQuery): Promise<readonly TradingPlan[]>;
  latestByPlanId(planId: string): Promise<TradingPlan | null>;
  remove(versionId: string): Promise<void>;
}

export interface ReportRepository {
  upsertForPeriod(report: Report): Promise<Report>;
  findById(id: string): Promise<Report | null>;
  findByPeriodVersion(input: {
    readonly kind: ReportKind;
    readonly scopeKey: string;
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly version: number;
  }): Promise<Report | null>;
  findByPeriod(input: {
    readonly kind: ReportKind;
    readonly scopeKey: string;
    readonly periodStart: string;
    readonly periodEnd: string;
  }): Promise<Report | null>;
  list(input?: {
    readonly kind?: ReportKind;
    readonly scopeKey?: string;
    readonly from?: string;
    readonly to?: string;
    readonly status?: ReportStatus;
    readonly latestOnly?: boolean;
    readonly limit?: number;
  }): Promise<readonly Report[]>;
  claimDelivery(input: {
    readonly id: string;
    readonly attemptId: string;
    readonly now: Date;
    readonly stalePendingBefore: Date;
    readonly failedRetryBefore: Date;
  }): Promise<boolean>;
  finishDelivery(input: {
    readonly id: string;
    readonly attemptId: string;
    readonly status: 'sent' | 'fallback-log' | 'failed';
    readonly now: Date;
  }): Promise<boolean>;
  setDeliveryStatus(id: string, status: DeliveryStatus): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface RepositoryRegistry {
  readonly account: AccountRepository;
  /** 账户事实的原子写入（现金余额 + 交易/持仓/流水）。 */
  readonly ledger: LedgerRepository;
  readonly stock: StockRepository;
  /** 本地股票目录完整快照与同步审计。 */
  readonly stockUniverse: StockUniverseRepository;
  /** 行业 / 概念目录与多对多成分（盘前同步的事实链）。 */
  readonly sectorCatalog: SectorCatalogRepository;
  /** 历史 Strategy replay 使用的真实天梯 PIT 快照。 */
  readonly limitUpLadderSnapshot: LimitUpLadderSnapshotRepository;
  /** 盘中全市场快照批次（不可变、按采样时点去重）。 */
  readonly marketSnapshotBatch: MarketSnapshotBatchRepository;
  readonly holding: HoldingRepository;
  readonly trade: TradeRepository;
  readonly decisionReview: DecisionReviewRepository;
  readonly portfolioCashFlow: PortfolioCashFlowRepository;
  readonly portfolioCorporateAction: PortfolioCorporateActionRepository;
  readonly portfolioPerformanceSnapshot: PortfolioPerformanceSnapshotRepository;
  readonly advice: AdviceRepository;
  readonly tradingPlan: TradingPlanRepository;
  /** A 股个性化简报历史；按 kind/scope/period 逻辑键幂等更新。 */
  readonly report: ReportRepository;
  /** v0.2 起；MarketDataManager 等会调 save / latestByStock。 */
  readonly quote: QuoteRepository;
  /** v0.2 起；MarketDataManager fetchDailyBars 命中本地缓存时直接走 findInRange。 */
  readonly dailyBar: DailyBarRepository;
  /** Market View Phase 4：独立 raw 分钟 OHLCV，默认保留 30 天。 */
  readonly minuteBar: MinuteBarRepository;
  /** Phase 6：信号后的事实表现观察，不包含回测交易。 */
  readonly signalObservation: SignalObservationRepository;
  /** Strategy 目标模型身份与不可变版本；W1 起内部可读写，W2 才开放 tools。 */
  readonly strategy: StrategyRepository;
  /** Strategy 运行、结果和信号。 */
  readonly strategyRun: StrategyRunRepository;
  /** 严格回测运行；事实直接读 daily_bars。 */
  readonly strategyBacktest: StrategyBacktestRepository;
  readonly strategyWatchlistSubscription: StrategyWatchlistSubscriptionRepository;
  readonly watchlist: WatchlistRepository;
  readonly watchlistMember: WatchlistMemberRepository;
  readonly alertPlan: AlertPlanRepository;
  /** v0.3 起；send_notification 落库 + 复盘查询。 */
  readonly notification: NotificationRepository;
  /** v0.6 起；盯盘触发持久化 + cooldown 查询（intraday-watch workflow 用）。 */
  readonly watchTrigger: WatchTriggerRepository;
  /** v0.7 策略预警；边沿状态机持久化 + 批量加载。 */
  readonly watchRuleState: WatchRuleStateRepository;
  /** MVP-1：每轮 watch 心跳/结果，无触发时也可观测。 */
  readonly researchIndex: ResearchIndexRepository;
  /** ruo 迁移 Phase 1C；workflow 运行审计。 */
  readonly workflowRun: WorkflowRunRepository;
  /** Web AI 对话：账户隔离的会话与 UI message parts。 */
  readonly chat: ChatRepository;
}

export interface ResearchDocumentQuery {
  readonly kind?: ResearchDocumentKind;
  readonly tags?: readonly string[];
  readonly availability?: ResearchAvailability;
  readonly stockCode?: string;
  readonly publishedFrom?: Date;
  readonly publishedTo?: Date;
  readonly limit?: number;
  readonly cursor?: string;
}
export interface ResearchSearchQuery {
  readonly text: string;
  readonly kind?: ResearchDocumentKind;
  readonly stockCode?: string;
  readonly limit?: number;
}
export type ResearchSearchCapability = 'fts' | 'metadata';
export interface ResearchIndexApplySummary {
  readonly added: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly missing: number;
  readonly invalid: number;
  readonly conflicts: number;
}
/**
 * 研究笔记索引：`research_document_index` 单表 + FTS5 派生索引。
 * 没有 topic / hypothesis / subject-link / chunk / embedding / 同步运行表。
 */
export interface ResearchIndexRepository {
  applyIndexBatch(input: {
    readonly vaultId: string;
    readonly completeness: 'complete' | 'partial';
    readonly documents: readonly ResearchDocumentIndex[];
    /** 本地 Markdown 正文（documentId → 文本）；仅写 FTS，不落普通表。 */
    readonly contents?: Readonly<Record<string, string>>;
    readonly seenDocumentIds: ReadonlySet<string>;
    readonly indexedAt: Date;
  }): Promise<ResearchIndexApplySummary>;
  findDocument(id: string): Promise<ResearchDocumentIndex | null>;
  listDocuments(query: ResearchDocumentQuery): Promise<readonly ResearchDocumentIndex[]>;
  /** FTS5 可用返回 'fts'；虚拟表不可用时退化为 metadata 检索。 */
  searchCapability(): ResearchSearchCapability;
  searchDocuments(query: ResearchSearchQuery): Promise<readonly ResearchSearchHit[]>;
  /** 文档显式关联的股票代码去重列表（替代 subject-link 表）。 */
  listStockCodes(): Promise<readonly string[]>;
}

export interface SignalObservationRepository {
  save(observation: SignalObservation): Promise<void>;
  findById(id: string): Promise<SignalObservation | null>;
  /** 按来源批量读取全部观察；不受通用 list 的默认分页上限影响。 */
  listBySources(input: {
    readonly sourceKind?: SignalObservation['sourceKind'];
    readonly sourceIds: readonly string[];
    readonly horizons?: readonly SignalObservation['horizon'][];
  }): Promise<readonly SignalObservation[]>;
  list(input?: {
    readonly status?: SignalObservationStatus;
    readonly sourceKind?: SignalObservation['sourceKind'];
    readonly sourceIds?: readonly string[];
    readonly horizons?: readonly SignalObservation['horizon'][];
    readonly from?: Date;
    readonly to?: Date;
    readonly dueBefore?: Date;
    readonly retryReadyAt?: Date;
    readonly order?: 'due-first' | 'baseline-desc';
    readonly limit?: number;
  }): Promise<readonly SignalObservation[]>;
  removeBySources(
    sourceKind: SignalObservation['sourceKind'],
    sourceIds: readonly string[],
  ): Promise<void>;
}

export interface ChatRepository {
  saveSession(session: ChatSession): Promise<void>;
  findSessionById(id: string): Promise<ChatSession | null>;
  listSessions(accountId: string, limit?: number): Promise<readonly ChatSession[]>;
  removeSession(id: string): Promise<void>;
  saveMessage(message: ChatMessage): Promise<void>;
  /** 仅插入新 messageId；重复 ID 返回 false，永不覆盖已保存内容。 */
  insertMessageIfAbsent(message: ChatMessage): Promise<boolean>;
  findMessageById(sessionId: string, messageId: string): Promise<ChatMessage | null>;
  /** 原子替换 parts；并发确认只有一个调用能认领草案，且不改变消息的时间顺序。 */
  compareAndSetMessageParts(
    message: ChatMessage,
    expectedParts: ChatMessage['parts'],
  ): Promise<boolean>;
  listMessages(sessionId: string, limit?: number): Promise<readonly ChatMessage[]>;
}

export interface StrategyRepository {
  create(strategy: Strategy): Promise<void>;
  /** 删除 Strategy 身份及版本；调用方须先清理运行数据。 */
  remove(strategyId: string): Promise<void>;
  /** 更新自动运行调度字段；缺省字段不修改，null 表示清除。 */
  updateSchedule(
    strategyId: string,
    schedule: {
      readonly scheduleCron?: string | null;
      readonly lastScheduledAt?: Date | null;
    },
    at: Date,
  ): Promise<void>;
  findById(id: string): Promise<Strategy | null>;
  list(filter?: {
    readonly status?: Strategy['status'];
    readonly owner?: Strategy['owner'];
  }): Promise<readonly Strategy[]>;
  createVersion(version: StrategyVersion): Promise<void>;
  setVersionValidation(
    versionId: string,
    validation: {
      readonly status: 'valid' | 'invalid';
      readonly errors: readonly string[];
    },
  ): Promise<void>;
  findVersionById(id: string): Promise<StrategyVersion | null>;
  listVersions(strategyId: string): Promise<readonly StrategyVersion[]>;
  /**
   * 切换到同 Strategy 下「已发布且 valid」的 version（回滚/换版本用）。
   * 不允许激活未 publish 的版本；只改 Strategy.currentVersionId 并置 status=active，不动 publishedAt。
   */
  activateVersion(strategyId: string, versionId: string, at: Date): Promise<void>;
  /**
   * 首发语义：给 valid version 补 publishedAt（已发布则保留原值），同时切 currentVersionId 并置 status=active。
   * 与 activateVersion 的差异就在「是否允许未 publish 版本」：publish 允许并负责签发，activate 拒绝。
   */
  publishVersion(strategyId: string, versionId: string, at: Date): Promise<void>;
  pause(strategyId: string, at: Date): Promise<void>;
  resume(strategyId: string, at: Date): Promise<void>;
  /**
   * 归档为终态（M2 §9.1）：只允许 paused 的用户 Strategy；无自动恢复路径，
   * 用户只可人工复制重建。调度清理由调用方（archive_strategy tool）负责。
   */
  archive(strategyId: string, at: Date): Promise<void>;
}

export interface StrategyRunRepository {
  findLatestPublishedRun(strategyId: string): Promise<StrategyRun | null>;
  findPreviousPublishedRun(input: {
    readonly strategyId: string;
    readonly beforeStartedAt: Date;
    readonly beforeRunId: string;
  }): Promise<StrategyRun | null>;
  findRunById(id: string): Promise<StrategyRun | null>;
  listRuns(filter?: {
    readonly strategyId?: string;
    readonly status?: StrategyRun['status'];
    readonly scope?: StrategyRunScope;
    readonly publication?: StrategyRunPublicationStatus;
    readonly since?: Date;
    readonly until?: Date;
    /** 按 startedAt 倒序取前 N 条，避免全量拉取。 */
    readonly limit?: number;
  }): Promise<readonly StrategyRun[]>;
  listResults(runId: string): Promise<readonly StrategyResult[]>;
  /** 按运行批量读取结果；空 runIds 返回空数组。 */
  listResultsByRuns(runIds: readonly string[]): Promise<readonly StrategyResult[]>;
  signalsByRun(runId: string): Promise<readonly StrategySignal[]>;
  /** 按运行批量读取信号；空 runIds 返回空数组。 */
  signalsByRuns(runIds: readonly string[]): Promise<readonly StrategySignal[]>;
  /** 按 signal id 批量读取信号；不存在的 id 被忽略。 */
  signalsByIds(signalIds: readonly string[]): Promise<readonly StrategySignal[]>;
  signalsByStrategy(strategyId: string, since?: Date): Promise<readonly StrategySignal[]>;
  signalsByStock(stockId: string, since?: Date): Promise<readonly StrategySignal[]>;
  /** 写入可见的 running 记录；runId 重复必须拒绝。 */
  saveStartedRun(run: StrategyRun): Promise<void>;
  /** 终态 run 与其 facts 原子提交；只允许新增终态或更新同一条 running。 */
  commitRun(bundle: StrategyRunBundle): Promise<void>;
  /** 删除指定 Strategy 的运行、结果、信号与正式运行租约。 */
  removeByStrategyId(strategyId: string): Promise<void>;
}

export interface StrategyBacktestRepository {
  saveRun(run: StrictBacktestRun): Promise<void>;
  findRunById(id: string): Promise<StrictBacktestRun | null>;
  listRuns(input?: {
    readonly strategyId?: string;
    readonly limit?: number;
  }): Promise<readonly StrictBacktestRun[]>;
}

export interface StrategyWatchlistSubscriptionRepository {
  save(subscription: StrategyWatchlistSubscription): Promise<void>;
  findById(id: string): Promise<StrategyWatchlistSubscription | null>;
  findActive(input: {
    readonly strategyId: string;
    readonly watchlistId: string;
  }): Promise<StrategyWatchlistSubscription | null>;
  list(filter?: {
    readonly strategyId?: string;
    readonly watchlistId?: string;
    readonly status?: StrategyWatchlistSubscriptionStatus;
  }): Promise<readonly StrategyWatchlistSubscription[]>;
}

export interface WatchlistRepository {
  save(watchlist: Watchlist): Promise<void>;
  findById(id: string): Promise<Watchlist | null>;
  list(filter?: {
    readonly enabledOnly?: boolean;
    readonly kind?: WatchlistKind;
  }): Promise<readonly Watchlist[]>;
  archive(id: string, at: Date): Promise<void>;
}

export interface WatchlistMemberRepository {
  saveMember(member: WatchlistMember): Promise<void>;
  findMember(watchlistId: string, stockId: string): Promise<WatchlistMember | null>;
  listMembers(
    watchlistId: string,
    filter?: {
      readonly stage?: WatchlistMember['stage'];
      readonly priority?: WatchlistMember['priority'];
      readonly includeArchived?: boolean;
    },
  ): Promise<readonly WatchlistMember[]>;
  saveSource(source: WatchlistMemberSource): Promise<void>;
  listSources(memberId: string, includeEnded?: boolean): Promise<readonly WatchlistMemberSource[]>;
  currentSource(memberId: string, sourceKey: string): Promise<WatchlistMemberSource | null>;
  /** 原子写入一批手工成员及其来源；任一项失败时整批不落库。 */
  commitManualMembers(
    rows: readonly {
      readonly member: WatchlistMember;
      readonly source: WatchlistMemberSource;
    }[],
  ): Promise<void>;
  /** §6：同步运行改记 workflow_runs（workflowName='watchlist-sync'），此处是读模型 façade。 */
  saveSyncRun(run: WatchlistSyncRun): Promise<void>;
  listSyncRuns(watchlistId: string, limit?: number): Promise<readonly WatchlistSyncRun[]>;
  /** §6：变更明细存于 workflow_runs.outputSummary.changes，此处按 run id 还原（只读）。 */
  listSnapshots(syncRunId: string): Promise<readonly MembershipSnapshot[]>;
  commitWatchlistSync(input: WatchlistSyncCommit): Promise<WatchlistSyncRun>;
}

export interface AlertPlanRepository {
  save(plan: AlertPlan): Promise<void>;
  findById(id: string): Promise<AlertPlan | null>;
  list(filter?: {
    readonly enabledOnly?: boolean;
    readonly watchlistId?: string;
  }): Promise<readonly AlertPlan[]>;
  remove(id: string): Promise<void>;
}

export interface WatchTriggerSummary {
  readonly priorityCounts: Readonly<Record<string, number>>;
  readonly deliveryStatusCounts: Readonly<Record<string, number>>;
  readonly feedbackCounts: Readonly<Record<string, number>>;
  readonly stocks: readonly {
    readonly stockId: string;
    readonly count: number;
    readonly maxPriority: WatchTrigger['priority'];
    readonly latest: WatchTrigger;
  }[];
}

/**
 * 盯盘触发仓储（v0.6 起，v0.7 策略预警扩展）。
 * - 每次 watch 评估 fire 的 trigger 都写入；被 cooldown 抑制的也写（deliveryStatus 标记），便于事后复盘"今天压了多少条"。
 * - lastForKey 用于通知 cooldown 查询（since = now − cooldownMinutes），只返回
 *   deliveryStatus ∈ ATTEMPTED（sent / failed / fallback-log）的真实通知；试跑审计（notified=false 等）不能占后续通知冷却。
 * - countAttemptedSince 每日上限（方案 / 全局）计数用，poolId=null 为全局。
 */
export interface WatchTriggerRepository {
  commitEvaluation(input: {
    readonly now: Date;
    readonly triggers: readonly WatchTrigger[];
    readonly auditTriggers?: readonly WatchTrigger[];
    readonly states: readonly WatchRuleState[];
    readonly invalidatePending?: {
      readonly triggerIds: readonly string[];
      readonly reason: string;
    };
  }): Promise<void>;
  /** 发送前持久化尝试，崩溃留下 pending 供有限重试。 */
  beginDelivery(ids: readonly string[], at: Date): Promise<boolean>;
  save(trigger: WatchTrigger): Promise<void>;
  findById(id: string): Promise<WatchTrigger | null>;
  /** 审计 / 复盘：按 createdAt 倒序。 */
  listByPool(
    poolId: string,
    opts?: { readonly since?: Date; readonly limit?: number },
  ): Promise<readonly WatchTrigger[]>;
  /**
   * cooldown 查询：找 (poolId, stockId, ruleId) 维度最近一条；since 通常 = now − cooldownMinutes。
   * 任意一个 stockId / ruleId 为空都不命中（避免跨池误判）。
   */
  lastForKey(
    key: {
      readonly poolId: string;
      readonly stockId: string;
      readonly ruleId: string;
    },
    since: Date,
  ): Promise<WatchTrigger | null>;
  /** 先筛选和排序再分页；总数与结果取自同一读取快照，同优先级按 createdAt/id 倒序。 */
  query(input: {
    readonly accountId?: string;
    readonly alertPlanId?: string;
    readonly poolId?: string;
    readonly stockId?: string;
    readonly ruleKind?: WatchTrigger['ruleKind'];
    readonly ruleId?: string;
    readonly notified?: boolean;
    readonly priority?: WatchTrigger['priority'];
    readonly feedback?: NonNullable<WatchTrigger['feedback']> | 'unreviewed';
    readonly deliveryStatus?: readonly DeliveryStatus[];
    readonly triggerType?: WatchTrigger['triggerType'];
    readonly since?: Date;
    readonly until?: Date;
    readonly offset: number;
    readonly limit: number;
    readonly includeSummary?: boolean;
    readonly orderBy?: 'recent' | 'priority';
  }): Promise<{
    readonly triggers: readonly WatchTrigger[];
    readonly total: number;
    readonly summary?: WatchTriggerSummary;
  }>;
  /** 最近触发（CLI / TUI / MCP 展示用）。 */
  listRecent(opts?: {
    readonly poolId?: string;
    readonly since?: Date;
    readonly limit?: number;
    readonly deliveryStatus?: readonly DeliveryStatus[];
    readonly ruleId?: string;
    /** 存量 event-date 触发：按关联事件过滤。 */
    readonly eventId?: string;
  }): Promise<readonly WatchTrigger[]>;
  /**
   * 统计 since 以来触发的投递尝试数（含已开始的 pending 与重试）；旧 ATTEMPTED 记录计一次。
   * poolId 缺省 / null 为全局计数。
   */
  countAttemptedSince(since: Date, poolId?: string | null): Promise<number>;
  /**
   * 发送后回写：批量更新 deliveryStatus、可选 notificationId 和实际结束时间；is-notified 自动按 ATTEMPTED 判定。
   */
  setDeliveryStatus(
    ids: readonly string[],
    status: DeliveryStatus,
    notificationId?: string,
    completedAt?: Date,
  ): Promise<boolean>;
  /** 用户反馈（set_watch_trigger_feedback 写入）。 */
  setFeedback(id: string, feedback: TriggerFeedback, at: Date): Promise<void>;
  remove(id: string): Promise<void>;
}

/**
 * 边沿状态机表（v0.7 策略预警，docs/ddd/strategy-watchlist-unification-detailed-design.md §3.5 / §5）。
 * 仅 (poolId, stockId, ruleId) 维度的 active 状态；不替代 watch_triggers 历史。
 */
export interface WatchRuleStateRepository {
  /** 取该池所有规则的当前状态；一般 watch 流程批量加载以减少查询。 */
  listByPool(poolId: string): Promise<readonly WatchRuleState[]>;
  /** upsert；同 (poolId, stockId, ruleId) 覆盖。 */
  upsert(state: WatchRuleState): Promise<void>;
  /** 批量 upsert（一次 watch 评估后批量写回）。 */
  upsertMany(states: readonly WatchRuleState[]): Promise<void>;
  /** pool 删除时级联清理（§14 倾向）。 */
  removeByPool(poolId: string): Promise<void>;
}

/**
 * 通知仓储（v0.3 起）。
 * 软关联 adviceId / tacticSignalId：通知失败 / 重复发送排查用。
 */
export interface NotificationRepository {
  save(notification: Notification): Promise<void>;
  findById(id: string): Promise<Notification | null>;
  listByAdvice(adviceId: string): Promise<readonly Notification[]>;
  listBySignal(tacticSignalId: string): Promise<readonly Notification[]>;
  listRecent(filter?: {
    readonly channel?: Notification['channel'];
    readonly result?: NotificationResult;
    readonly since?: Date;
    readonly limit?: number;
  }): Promise<readonly Notification[]>;
}

/** Workflow 运行审计仓储（ruo 迁移 Phase 1C，docs/.../§3.4）。save 同 id 为 upsert（running → terminal）。 */
export interface WorkflowRunRepository {
  save(run: WorkflowRun): Promise<void>;
  findById(id: string): Promise<WorkflowRun | null>;
  listRecent(opts?: {
    readonly workflowName?: string;
    readonly status?: WorkflowRun['status'];
    readonly since?: Date;
    readonly limit?: number;
  }): Promise<readonly WorkflowRun[]>;
  /** Strategy 日循环专用审计查询；归属与 dataAsOf 过滤必须先于 limit/offset。 */
  listStrategyDailyCycleAudits(
    query?: StrategyDailyCycleAuditQuery,
  ): Promise<readonly WorkflowRun[]>;
  remove(id: string): Promise<void>;
}
