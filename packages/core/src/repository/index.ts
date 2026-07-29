import type { Account } from '../entity/account.js';
import type { Advice, AdviceOutcome, AdviceQuery } from '../entity/advice.js';
import type { AlertPlan } from '../entity/alert-plan.js';
import type { ChatMessage, ChatSession } from '../entity/chat-session.js';
import type { Holding } from '../entity/holding.js';
import type { Notification, NotificationResult } from '../entity/notification.js';
import type { DailyBar, Quote } from '../entity/quote.js';
import type { Report, ReportKind, ReportStatus } from '../entity/report.js';
import type { ResearchNote, ResearchNoteKind } from '../entity/research-note.js';
import type { SignalObservation, SignalObservationStatus } from '../entity/signal-observation.js';
import type { Stock } from '../entity/stock.js';
import type { StockEvent, StockEventKind, StockEventStatus } from '../entity/stock-event.js';
import type {
  DeliveryStatus,
  TriggerFeedback,
  WatchRuleState,
  WatchTrigger,
} from '../entity/stock-pool.js';
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
  StrategySignal,
  StrategyVersion,
} from '../entity/strategy.js';
import type { Trade } from '../entity/trade.js';
import type { WatchRun } from '../entity/watch-run.js';
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
}

export interface AdviceRepository {
  save(advice: Advice): Promise<void>;
  findById(id: string): Promise<Advice | null>;
  query(filter: AdviceQuery): Promise<Advice[]>;
  recordOutcome(adviceId: string, outcome: AdviceOutcome): Promise<void>;
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
}

export interface RepositoryRegistry {
  readonly account: AccountRepository;
  readonly stock: StockRepository;
  /** 本地股票目录完整快照与同步审计。 */
  readonly stockUniverse: StockUniverseRepository;
  readonly holding: HoldingRepository;
  readonly trade: TradeRepository;
  readonly advice: AdviceRepository;
  /** A 股个性化简报历史；按 kind/scope/period 逻辑键幂等更新。 */
  readonly report: ReportRepository;
  /** v0.2 起；MarketDataManager 等会调 save / latestByStock。 */
  readonly quote: QuoteRepository;
  /** v0.2 起；MarketDataManager fetchDailyBars 命中本地缓存时直接走 findInRange。 */
  readonly dailyBar: DailyBarRepository;
  /** Phase 6：信号后的事实表现观察，不包含回测交易。 */
  readonly signalObservation: SignalObservationRepository;
  /** Strategy 目标模型身份与不可变版本；W1 起内部可读写，W2 才开放 tools。 */
  readonly strategy: StrategyRepository;
  /** Strategy 运行、结果和信号。 */
  readonly strategyRun: StrategyRunRepository;
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
  /** ruo 迁移 Phase 1A；研究档案笔记 CRUD + thesis 版本链。 */
  readonly researchNote: ResearchNoteRepository;
  /** ruo 迁移 Phase 1B；公司事件（幂等 upsert by (provider, externalId)）。 */
  readonly stockEvent: StockEventRepository;
  /** ruo 迁移 Phase 1C；workflow 运行审计。 */
  readonly workflowRun: WorkflowRunRepository;
  /** Web AI 对话：账户隔离的会话与 UI message parts。 */
  readonly chat: ChatRepository;
}

export interface SignalObservationRepository {
  save(observation: SignalObservation): Promise<void>;
  findById(id: string): Promise<SignalObservation | null>;
  list(input?: {
    readonly status?: SignalObservationStatus;
    readonly sourceKind?: SignalObservation['sourceKind'];
    readonly from?: Date;
    readonly to?: Date;
    readonly limit?: number;
  }): Promise<readonly SignalObservation[]>;
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
  save(strategy: Strategy): Promise<void>;
  findById(id: string): Promise<Strategy | null>;
  list(filter?: {
    readonly status?: Strategy['status'];
    readonly owner?: Strategy['owner'];
  }): Promise<readonly Strategy[]>;
  saveVersion(version: StrategyVersion): Promise<void>;
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
}

export interface StrategyRunRepository {
  saveRun(run: StrategyRun): Promise<void>;
  findRunById(id: string): Promise<StrategyRun | null>;
  listRuns(filter?: {
    readonly strategyId?: string;
    readonly status?: StrategyRun['status'];
    readonly since?: Date;
    /** 按 startedAt 倒序取前 N 条，避免全量拉取。 */
    readonly limit?: number;
  }): Promise<readonly StrategyRun[]>;
  saveResults(results: readonly StrategyResult[]): Promise<void>;
  listResults(runId: string): Promise<readonly StrategyResult[]>;
  saveSignals(signals: readonly StrategySignal[]): Promise<void>;
  signalsByStrategy(strategyId: string, since?: Date): Promise<readonly StrategySignal[]>;
  signalsByStock(stockId: string, since?: Date): Promise<readonly StrategySignal[]>;
  /** 终态 run 与其 results/signals 原子提交。 */
  commitRun(bundle: {
    readonly run: StrategyRun;
    readonly results: readonly StrategyResult[];
    readonly signals: readonly StrategySignal[];
  }): Promise<void>;
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
 * 研究档案笔记仓储（ruo 迁移 Phase 1A，docs/ddd/ruo-feature-migration-detailed-design.md §3.1 / §7.1）。
 *
 * thesis 版本链：save 一条 active=true 的 thesis 时，同 stockId 其它 thesis 必须置 active=false
 * （实现层事务保证）。deactivateTheses 供 tool / repo 在插入新版本前停用旧版本。
 */
export interface ResearchNoteRepository {
  save(note: ResearchNote): Promise<void>;
  findById(id: string): Promise<ResearchNote | null>;
  /** 按股票列出；kind / activeOnly / since 过滤，按 createdAt 倒序。 */
  listByStock(
    stockId: string,
    opts?: {
      readonly kind?: ResearchNoteKind;
      readonly activeOnly?: boolean;
      readonly since?: Date;
      readonly limit?: number;
    },
  ): Promise<readonly ResearchNote[]>;
  /** 存在研究档案的股票 id 集合（盘后日线相关范围计算用）。 */
  listStockIdsWithNotes(): Promise<readonly string[]>;
  /** 停用某股票全部 active thesis（插入新版本前调用）；返回被停用的条数。 */
  deactivateTheses(stockId: string): Promise<number>;
  remove(id: string): Promise<void>;
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
  remove(id: string): Promise<void>;
}
