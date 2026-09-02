import type { Account } from '../entity/account.js';
import type { Advice, AdviceOutcome, AdviceOutcomeQuery, AdviceQuery } from '../entity/advice.js';
import type { AlertPlan } from '../entity/alert-plan.js';
import type { ChatMessage, ChatSession } from '../entity/chat-session.js';
import type { FinancialFact, FinancialVintage } from '../entity/fundamental.js';
import type { Holding } from '../entity/holding.js';
import type { LimitUpLadder, LimitUpLadderSource } from '../entity/limit-up-ladder.js';
import type { MinuteBar, MinuteBarInterval } from '../entity/minute-bar.js';
import type { Notification, NotificationResult } from '../entity/notification.js';
import type {
  PortfolioCashFlow,
  PortfolioCorporateAction,
  PortfolioPerformanceSnapshot,
} from '../entity/portfolio-performance.js';
import type { DailyBar, Quote } from '../entity/quote.js';
import type { Report, ReportKind, ReportStatus } from '../entity/report.js';
import type {
  ResearchChunkEmbedding,
  ResearchEmbeddingIndexState,
  ResearchEmbeddingModelIdentity,
} from '../entity/research-embedding.js';
import type {
  ResearchHypothesisVersion,
  ResearchHypothesisVersionStatus,
} from '../entity/research-hypothesis.js';
import type {
  ResearchAvailability,
  ResearchDocumentChunk,
  ResearchDocumentIndex,
  ResearchDocumentKind,
  ResearchSubjectLink,
  ResearchTopicDocument,
  ResearchTopicIndex,
  ResearchTopicKind,
  ResearchVaultSyncRun,
} from '../entity/research-vault.js';
import type { SignalObservation, SignalObservationStatus } from '../entity/signal-observation.js';
import type { Stock } from '../entity/stock.js';
import type { StockEvent, StockEventKind, StockEventStatus } from '../entity/stock-event.js';
import type {
  MarketCoverage,
  StockUniverseApplySummary,
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
import type {
  StrategyAutonomyAction,
  StrategyAutonomyActionKind,
  StrategyAutonomyActionStatus,
} from '../entity/strategy-autonomy-action.js';
import type { StrictBacktestMarketFact, StrictBacktestRun } from '../entity/strategy-backtest.js';
import type {
  DailyBarRevision,
  StrategyDataCheckpoint,
  StrategyDataCheckpointMember,
  StrategyEvaluationDay,
  StrategyEvaluationSession,
} from '../entity/strategy-checkpoint.js';
import type { StrategySchedule } from '../entity/strategy-schedule.js';
import type {
  StrategyWatchlistSubscription,
  StrategyWatchlistSubscriptionStatus,
} from '../entity/strategy-watchlist-subscription.js';
import type { Trade } from '../entity/trade.js';
import type { WatchRun } from '../entity/watch-run.js';
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
import type { ResearchSearchHit } from '../research-vault.js';
import type { StrategyDailyCycleAuditQuery } from '../strategy/daily-cycle-audit.js';
import type {
  FundamentalScoreResult,
  FundamentalScoreRun,
  FundamentalScoreRunCommit,
  FundamentalScoreVersion,
} from '../strategy/fundamental-factor.js';

/**
 * Repository 接口（ARCHITECTURE §2.5 / §4.3）。
 * core 只定义接口；Drizzle 实现与 in-memory 实现在 packages/db。
 */

export interface AccountRepository {
  save(account: Account): Promise<void>;
  findById(id: string): Promise<Account | null>;
  list(): Promise<Account[]>;
  remove(id: string): Promise<void>;
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
  /** P2 PIT universe：只选择 observedAt 不晚于目标时点的成功快照。 */
  latestSnapshotAtOrBefore(input: {
    readonly coverage: MarketCoverage;
    readonly asOf: Date;
  }): Promise<StockUniverseSyncRun | null>;
  listSnapshotMembers(syncId: string): Promise<readonly Stock[]>;
}

/** 已审计的按交易日涨停天梯 PIT 快照；replay 只允许读取此仓储。 */
export interface LimitUpLadderSnapshotRepository {
  save(snapshot: LimitUpLadder): Promise<void>;
  findByDate(input: {
    readonly date: string;
    readonly source: LimitUpLadderSource;
  }): Promise<LimitUpLadder | null>;
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
  listByAccount(accountId: string): Promise<Trade[]>;
  remove(id: string): Promise<void>;
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
export interface FinancialFactRepository {
  appendMany(facts: readonly FinancialFact[]): Promise<void>;
  listRevisions(input: {
    readonly stockIds: readonly string[];
    readonly metricIds?: readonly string[];
    readonly from?: Date;
    readonly to?: Date;
    readonly recordedAt?: Date;
  }): Promise<readonly FinancialFact[]>;
  resolveVintage(input: {
    readonly stockIds: readonly string[];
    readonly metricIds: readonly string[];
    readonly asOf: Date;
    readonly policy: 'strict-pit-v1';
  }): Promise<FinancialVintage>;
}

/**
 * Immutable, append-only score-version snapshots. A second save for an
 * existing id must either be an identical idempotent replay or be rejected;
 * published/retired definitions are never updated in place.
 */
export interface FundamentalScoreVersionRepository {
  save(version: FundamentalScoreVersion): Promise<void>;
  findById(id: string): Promise<FundamentalScoreVersion | null>;
  list(input?: {
    readonly status?: FundamentalScoreVersion['status'];
  }): Promise<readonly FundamentalScoreVersion[]>;
}

/**
 * Append-only score-run audit facts. `saveStarted` creates the only mutable
 * lifecycle state; `commit` atomically moves it once to a terminal status and
 * stores results only for `committed`. unavailable/failed terminal commits
 * retain their run reason but expose no consumable results.
 */
export interface FundamentalScoreRunRepository {
  saveStarted(run: FundamentalScoreRun): Promise<void>;
  commit(input: FundamentalScoreRunCommit): Promise<void>;
  findById(id: string): Promise<FundamentalScoreRun | null>;
  list(input?: {
    readonly scoreVersionId?: string;
    readonly status?: FundamentalScoreRun['status'];
    readonly asOf?: Date;
    readonly limit?: number;
  }): Promise<readonly FundamentalScoreRun[]>;
  listResults(runId: string): Promise<readonly FundamentalScoreResult[]>;
}

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

export interface ReportRepository {
  upsertForPeriod(report: Report): Promise<Report>;
  findById(id: string): Promise<Report | null>;
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
    readonly limit?: number;
  }): Promise<readonly Report[]>;
  setDeliveryStatus(id: string, status: DeliveryStatus): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface RepositoryRegistry {
  readonly account: AccountRepository;
  readonly stock: StockRepository;
  /** 本地股票目录完整快照与同步审计。 */
  readonly stockUniverse: StockUniverseRepository;
  /** 历史 Strategy replay 使用的真实天梯 PIT 快照。 */
  readonly limitUpLadderSnapshot: LimitUpLadderSnapshotRepository;
  readonly holding: HoldingRepository;
  readonly trade: TradeRepository;
  readonly portfolioCashFlow: PortfolioCashFlowRepository;
  readonly portfolioCorporateAction: PortfolioCorporateActionRepository;
  readonly portfolioPerformanceSnapshot: PortfolioPerformanceSnapshotRepository;
  readonly advice: AdviceRepository;
  /** A 股个性化简报历史；按 kind/scope/period 逻辑键幂等更新。 */
  readonly report: ReportRepository;
  /** v0.2 起；MarketDataManager 等会调 save / latestByStock。 */
  readonly quote: QuoteRepository;
  /** v0.2 起；MarketDataManager fetchDailyBars 命中本地缓存时直接走 findInRange。 */
  readonly dailyBar: DailyBarRepository;
  /** Phase 3 P3-1：append-only 基本面 PIT facts 与 strict vintage resolver。 */
  readonly financialFact: FinancialFactRepository;
  /** Phase 3 P3-2：不可变基本面 score version 快照。 */
  readonly fundamentalScoreVersion: FundamentalScoreVersionRepository;
  /** Phase 3 P3-2：一次性 terminal commit 的基本面 score run/results。 */
  readonly fundamentalScoreRun: FundamentalScoreRunRepository;
  /** Market View Phase 4：独立 raw 分钟 OHLCV，默认保留 30 天。 */
  readonly minuteBar: MinuteBarRepository;
  /** Phase 6：信号后的事实表现观察，不包含回测交易。 */
  readonly signalObservation: SignalObservationRepository;
  /** Strategy 目标模型身份与不可变版本；W1 起内部可读写，W2 才开放 tools。 */
  readonly strategy: StrategyRepository;
  /** Phase B：可修改的策略自动运行配置与多实例 lease。 */
  readonly strategySchedule: StrategyScheduleRepository;
  /** Strategy 运行、结果和信号。 */
  readonly strategyRun: StrategyRunRepository;
  /** P1 盘后 Strategy 日线输入 checkpoint。 */
  readonly strategyDataCheckpoint: StrategyDataCheckpointRepository;
  /** P2 历史评估 session/day 进度。 */
  readonly strategyEvaluation: StrategyEvaluationRepository;
  /** 严格回测运行与 PIT 可成交性/公司行动事实；与 operational/evaluation run 隔离。 */
  readonly strategyBacktest: StrategyBacktestRepository;
  readonly strategyWatchlistSubscription: StrategyWatchlistSubscriptionRepository;
  /** M2-S0：Strategy 自主管理动作（提议/发布/暂停）审计。 */
  readonly strategyAutonomyAction: StrategyAutonomyActionRepository;
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
  readonly watchRun: WatchRunRepository;
  readonly researchIndex: ResearchIndexRepository;
  readonly researchEmbedding: ResearchEmbeddingRepository;
  readonly researchVaultSyncRun: ResearchVaultSyncRunRepository;
  readonly researchHypothesisVersion: ResearchHypothesisVersionRepository;
  /** ruo 迁移 Phase 1B；公司事件（幂等 upsert by (provider, externalId)）。 */
  readonly stockEvent: StockEventRepository;
  /** ruo 迁移 Phase 1C；workflow 运行审计。 */
  readonly workflowRun: WorkflowRunRepository;
  /** Web AI 对话：账户隔离的会话与 UI message parts。 */
  readonly chat: ChatRepository;
}

export interface ResearchTopicQuery {
  readonly kind?: ResearchTopicKind;
  readonly subject?: string;
  readonly tags?: readonly string[];
  readonly includeArchived?: boolean;
  readonly availability?: ResearchAvailability;
  readonly limit?: number;
  readonly cursor?: string;
}
export interface ResearchDocumentQuery {
  readonly topicId?: string;
  readonly subject?: string;
  readonly kind?: ResearchDocumentKind;
  readonly tags?: readonly string[];
  readonly availability?: ResearchAvailability;
  readonly limit?: number;
  readonly cursor?: string;
  readonly publishedFrom?: Date;
  readonly publishedTo?: Date;
}
export interface ResearchSearchQuery {
  readonly text: string;
  readonly topicId?: string;
  readonly subject?: string;
  readonly kind?: ResearchDocumentKind;
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
export interface ResearchIndexRepository {
  applyIndexBatch(input: {
    readonly vaultId: string;
    readonly completeness: 'complete' | 'partial';
    readonly topics: readonly ResearchTopicIndex[];
    readonly documents: readonly ResearchDocumentIndex[];
    readonly topicDocuments: readonly ResearchTopicDocument[];
    readonly subjectLinks: readonly ResearchSubjectLink[];
    readonly chunks: readonly ResearchDocumentChunk[];
    readonly seenTopicIds: ReadonlySet<string>;
    readonly seenDocumentIds: ReadonlySet<string>;
    readonly indexedAt: Date;
  }): Promise<ResearchIndexApplySummary>;
  findTopic(id: string): Promise<ResearchTopicIndex | null>;
  findDocument(id: string): Promise<ResearchDocumentIndex | null>;
  listTopics(query: ResearchTopicQuery): Promise<readonly ResearchTopicIndex[]>;
  listDocuments(query: ResearchDocumentQuery): Promise<readonly ResearchDocumentIndex[]>;
  searchCapability(): ResearchSearchCapability;
  searchDocuments(query: ResearchSearchQuery): Promise<readonly ResearchSearchHit[]>;
  listChunks(input?: {
    readonly documentIds?: readonly string[];
  }): Promise<readonly ResearchDocumentChunk[]>;
  listStockSubjectKeys(): Promise<readonly string[]>;
  listSubjectLinks(input?: {
    readonly ownerKind?: ResearchSubjectLink['ownerKind'];
    readonly ownerId?: string;
    readonly subjectKind?: ResearchSubjectLink['subjectKind'];
    readonly subjectKey?: string;
  }): Promise<readonly ResearchSubjectLink[]>;
  listTopicDocuments(topicId: string): Promise<readonly ResearchTopicDocument[]>;
}
export interface ResearchVaultSyncRunRepository {
  save(run: ResearchVaultSyncRun): Promise<void>;
  findById(id: string): Promise<ResearchVaultSyncRun | null>;
  list(vaultId: string, limit?: number): Promise<readonly ResearchVaultSyncRun[]>;
}

export interface ResearchHypothesisVersionRepository {
  /** 创建新的 active 版本，并在同一事务内将该 Topic 旧 active 版本标记为 superseded。 */
  create(version: ResearchHypothesisVersion): Promise<void>;
  findById(id: string): Promise<ResearchHypothesisVersion | null>;
  list(input?: {
    readonly topicId?: string;
    readonly status?: ResearchHypothesisVersionStatus;
    readonly limit?: number;
  }): Promise<readonly ResearchHypothesisVersion[]>;
}

export interface ResearchEmbeddingRepository {
  listPending(input: {
    readonly identity: ResearchEmbeddingModelIdentity;
    readonly limit: number;
  }): Promise<readonly ResearchDocumentChunk[]>;
  saveMany(embeddings: readonly ResearchChunkEmbedding[]): Promise<void>;
  deleteInvalid(identity: ResearchEmbeddingModelIdentity): Promise<number>;
  inspect(
    identity: ResearchEmbeddingModelIdentity,
    now: Date,
  ): Promise<ResearchEmbeddingIndexState>;
  saveState(state: ResearchEmbeddingIndexState): Promise<void>;
  findState(identity: ResearchEmbeddingModelIdentity): Promise<ResearchEmbeddingIndexState | null>;
  searchSimilar(input: {
    readonly identity: ResearchEmbeddingModelIdentity;
    readonly vector: readonly number[];
    readonly topicId?: string;
    readonly subject?: string;
    readonly kind?: ResearchDocumentKind;
    readonly limit: number;
  }): Promise<readonly ResearchSearchHit[]>;
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
  listMessages(sessionId: string, limit?: number): Promise<readonly ChatMessage[]>;
}

export interface StrategyRepository {
  create(strategy: Strategy): Promise<void>;
  /** 删除 Strategy 身份及版本；调用方须先清理运行与调度数据。 */
  remove(strategyId: string): Promise<void>;
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
}

export interface StrategyRunRepository {
  /** 获取正式运行的 fencing token；租约不存在或仍有效时返回 null。 */
  acquireRunLeaseToken(input: {
    readonly strategyId: string;
    readonly strategyVersionId: string;
    readonly owner: string;
    readonly runId?: string;
    readonly now: Date;
    readonly leaseUntil: Date;
  }): Promise<StrategyLeaseToken | null>;
  renewRunLease(input: {
    readonly token: StrategyLeaseToken;
    readonly now: Date;
    readonly leaseUntil: Date;
  }): Promise<boolean>;
  releaseRunLease(input: {
    readonly strategyId: string;
    readonly strategyVersionId: string;
    readonly owner: string;
    readonly fence?: number;
  }): Promise<void>;
  commitRunWithFence(input: {
    readonly token: StrategyLeaseToken;
    readonly now: Date;
    readonly bundle: StrategyRunBundle;
  }): Promise<'committed' | 'lease-lost'>;
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

export interface StrategyScheduleRepository {
  save(schedule: StrategySchedule): Promise<void>;
  removeByStrategyId(strategyId: string): Promise<void>;
  findById(id: string): Promise<StrategySchedule | null>;
  findByStrategyId(strategyId: string): Promise<StrategySchedule | null>;
  list(input?: { readonly enabledOnly?: boolean }): Promise<readonly StrategySchedule[]>;
  /** 原子抢占已到期且 lease 可用的配置；返回值只包含抢占成功的行。 */
  claimDue(input: {
    readonly now: Date;
    readonly owner: string;
    readonly leaseUntil: Date;
    readonly limit: number;
  }): Promise<readonly StrategySchedule[]>;
  claimDueWithFence(input: {
    readonly now: Date;
    readonly owner: string;
    readonly leaseUntil: Date;
    readonly limit: number;
  }): Promise<readonly StrategyScheduleClaim[]>;
  renewClaim(input: {
    readonly id: string;
    readonly owner: string;
    readonly fence: number;
    readonly now: Date;
    readonly leaseUntil: Date;
  }): Promise<boolean>;
  /** 只有当前 lease owner 可完成抢占；每次 tick 最多补跑一次并把 nextRunAt 推进到未来。 */
  finishClaim(input: {
    readonly id: string;
    readonly owner: string;
    readonly fence?: number;
    readonly nextRunAt: Date;
    readonly updatedAt: Date;
    readonly lastRunId?: string;
  }): Promise<void>;
}

export interface StrategyLeaseToken {
  readonly strategyId: string;
  readonly strategyVersionId: string;
  readonly owner: string;
  readonly fence: number;
  readonly leaseUntil: Date;
  readonly runId?: string;
}

export interface StrategyScheduleLeaseToken {
  readonly scheduleId: string;
  readonly owner: string;
  readonly fence: number;
  readonly leaseUntil: Date;
}

export interface StrategyScheduleClaim {
  readonly schedule: StrategySchedule;
  readonly token: StrategyScheduleLeaseToken;
}

export interface StrategyDataCheckpointRepository {
  saveStarted(checkpoint: StrategyDataCheckpoint): Promise<void>;
  commit(input: {
    readonly checkpoint: StrategyDataCheckpoint;
    readonly members: readonly StrategyDataCheckpointMember[];
  }): Promise<void>;
  findById(id: string): Promise<StrategyDataCheckpoint | null>;
  listMembers(id: string): Promise<readonly StrategyDataCheckpointMember[]>;
  latestUsableAtOrBefore(input: {
    readonly coverage: MarketCoverage;
    readonly asOf: Date;
    readonly universeSyncId: string;
  }): Promise<StrategyDataCheckpoint | null>;
}

export interface StrategyEvaluationRepository {
  saveSession(session: StrategyEvaluationSession): Promise<void>;
  findSessionById(id: string): Promise<StrategyEvaluationSession | null>;
  saveDay(day: StrategyEvaluationDay): Promise<void>;
  findDay(input: {
    readonly sessionId: string;
    readonly dataAsOf: Date;
  }): Promise<StrategyEvaluationDay | null>;
  listDays(sessionId: string): Promise<readonly StrategyEvaluationDay[]>;
}

export interface StrategyBacktestRepository {
  saveRun(run: StrictBacktestRun): Promise<void>;
  findRunById(id: string): Promise<StrictBacktestRun | null>;
  listRuns(input?: {
    readonly strategyId?: string;
    readonly limit?: number;
  }): Promise<readonly StrictBacktestRun[]>;
  saveMarketFacts(facts: readonly StrictBacktestMarketFact[]): Promise<void>;
  listMarketFacts(input: {
    readonly stockIds: readonly string[];
    readonly from: Date;
    readonly to: Date;
    readonly recordedAt?: Date;
  }): Promise<readonly StrictBacktestMarketFact[]>;
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

/**
 * M2-S0：Strategy 自主管理动作审计（docs/ddd/strategy-ai-lifecycle-detailed-design.md §2/§4）。
 * save 为按 id 的 upsert；状态转移走 updateStatus 的 expectedStatus 乐观并发，防止并发转移互相覆盖。
 */
export interface StrategyAutonomyActionRepository {
  save(action: StrategyAutonomyAction): Promise<void>;
  findById(id: string): Promise<StrategyAutonomyAction | null>;
  /** 按 createdAt 倒序（id 倒序决胜）；limit 在排序后截断。 */
  list(filter?: {
    readonly strategyId?: string;
    readonly kind?: StrategyAutonomyActionKind;
    readonly status?: StrategyAutonomyActionStatus;
    readonly since?: Date;
    readonly limit?: number;
  }): Promise<readonly StrategyAutonomyAction[]>;
  /**
   * 仅当当前 status === expectedStatus 才完成转移；动作不存在或状态已被并发修改时返回 null。
   * 转移必须是状态机（§2.2）内的边，否则抛 InvariantError；completedAt/lastError/attempts 为随转移携带的补丁。
   */
  updateStatus(input: {
    readonly id: string;
    readonly expectedStatus: StrategyAutonomyActionStatus;
    readonly status: StrategyAutonomyActionStatus;
    readonly updatedAt: Date;
    readonly completedAt?: Date;
    readonly lastError?: string;
    readonly attempts?: number;
  }): Promise<StrategyAutonomyAction | null>;
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
  saveSyncRun(run: WatchlistSyncRun): Promise<void>;
  saveSnapshots(rows: readonly MembershipSnapshot[]): Promise<void>;
  listSyncRuns(watchlistId: string, limit?: number): Promise<readonly WatchlistSyncRun[]>;
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

/**
 * 盯盘触发仓储（v0.6 起，v0.7 策略预警扩展）。
 * - 每次 watch 评估 fire 的 trigger 都写入；被 cooldown 抑制的也写（deliveryStatus 标记），便于事后复盘"今天压了多少条"。
 * - lastForKey 用于通知 cooldown 查询（since = now − cooldownMinutes），只返回
 *   deliveryStatus ∈ ATTEMPTED（sent / failed / fallback-log）的真实通知；试跑审计（notified=false 等）不能占后续通知冷却。
 * - countAttemptedSince 每日上限（方案 / 全局）计数用，poolId=null 为全局。
 */
export interface WatchTriggerRepository {
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
  /** 最近触发（CLI / TUI / MCP 展示用）。 */
  listRecent(opts?: {
    readonly poolId?: string;
    readonly since?: Date;
    readonly limit?: number;
    readonly deliveryStatus?: readonly DeliveryStatus[];
    readonly ruleId?: string;
    /** event-date 去重：按关联事件过滤。 */
    readonly eventId?: string;
  }): Promise<readonly WatchTrigger[]>;
  /**
   * 统计 since 以来 ATTEMPTED 状态的触发数。poolId 缺省 / null 为全局计数（每日上限用）。
   */
  countAttemptedSince(since: Date, poolId?: string | null): Promise<number>;
  /**
   * 发送后回写：批量更新 deliveryStatus + 可选 notificationId；is-notified 自动按 ATTEMPTED 判定。
   */
  setDeliveryStatus(
    ids: readonly string[],
    status: DeliveryStatus,
    notificationId?: string,
  ): Promise<void>;
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

/** 每轮 watch 的运行审计；save 同 id 为 upsert（running → terminal）。 */
export interface WatchRunRepository {
  save(run: WatchRun): Promise<void>;
  findById(id: string): Promise<WatchRun | null>;
  latest(): Promise<WatchRun | null>;
  listRecent(limit?: number): Promise<readonly WatchRun[]>;
  remove(id: string): Promise<void>;
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

/**
 * 公司事件仓储（ruo 迁移 Phase 1B，docs/.../§3.2 / §7.2）。
 *
 * 幂等：upsertByExternal 按 (provider, externalId) 冲突时更新，不存在时插入。
 * listUpcoming 供 evaluate-event-rules 求值窗口扫描。
 */
export interface StockEventRepository {
  save(event: StockEvent): Promise<void>;
  findById(id: string): Promise<StockEvent | null>;
  /** 按 (provider, externalId) 查（幂等 upsert 前置查询）。 */
  findByExternal(provider: string, externalId: string): Promise<StockEvent | null>;
  /**
   * 幂等 upsert：按 (provider, externalId) 命中则更新可变字段（title/occursAt/status/importance/stale...），
   * 否则插入。返回 'inserted' | 'updated'。
   */
  upsertByExternal(event: StockEvent): Promise<'inserted' | 'updated'>;
  list(opts?: {
    readonly stockId?: string;
    readonly kinds?: readonly StockEventKind[];
    readonly status?: StockEventStatus;
    readonly from?: Date;
    readonly to?: Date;
    readonly importance?: StockEvent['importance'];
    readonly limit?: number;
  }): Promise<readonly StockEvent[]>;
  /** 求值窗口扫描：某股票 [from, to] 内 status='scheduled' 的事件（kinds / 最低重要性过滤）。 */
  listUpcoming(
    stockId: string,
    from: Date,
    to: Date,
    opts?: {
      readonly kinds?: readonly StockEventKind[];
      readonly minImportance?: StockEvent['importance'];
    },
  ): Promise<readonly StockEvent[]>;
  /** 存在手工事件的股票 id 集合（同步范围计算用）。 */
  listStockIdsWithEvents(): Promise<readonly string[]>;
  /** provider 抓取失败时批量标记 stale（保留旧数据）。返回受影响条数。 */
  markStaleByProvider(provider: string): Promise<number>;
  remove(id: string): Promise<void>;
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
