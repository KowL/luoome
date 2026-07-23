import type { Account } from '../entity/account.js';
import type { Advice, AdviceOutcome, AdviceQuery } from '../entity/advice.js';
import type { Holding } from '../entity/holding.js';
import type { Notification, NotificationResult } from '../entity/notification.js';
import type { DailyBar, Quote } from '../entity/quote.js';
import type { Stock } from '../entity/stock.js';
import type { GroupMemberSnapshot, StockGroup } from '../entity/stock-group.js';
import type { StockPool, WatchRule, WatchTrigger } from '../entity/stock-pool.js';
import type { Tactic, TacticSignal } from '../entity/tactic.js';
import type { Trade } from '../entity/trade.js';
import type { WatchRun } from '../entity/watch-run.js';

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

export interface RepositoryRegistry {
  readonly account: AccountRepository;
  readonly stock: StockRepository;
  readonly holding: HoldingRepository;
  readonly trade: TradeRepository;
  readonly advice: AdviceRepository;
  /** v0.2 起；MarketDataManager 等会调 save / latestByStock。 */
  readonly quote: QuoteRepository;
  /** v0.2 起；MarketDataManager fetchDailyBars 命中本地缓存时直接走 findInRange。 */
  readonly dailyBar: DailyBarRepository;
  /** v0.3 起；run_tactic / list_tactics 用。 */
  readonly tactic: TacticRepository;
  /** v0.3 起；send_notification 落库 + 复盘查询。 */
  readonly notification: NotificationRepository;
  /** v0.6 起；股票池 CRUD（list_stock_pools / create_stock_pool / ...）。 */
  readonly stockPool: StockPoolRepository;
  /** v0.6 起；盯盘触发持久化 + cooldown 查询（intraday-watch workflow 用）。 */
  readonly watchTrigger: WatchTriggerRepository;
  /** MVP-1：每轮 watch 心跳/结果，无触发时也可观测。 */
  readonly watchRun: WatchRunRepository;
  /** 分组化起（docs/stock-group-design.md §2）；股票分组 CRUD。 */
  readonly stockGroup: StockGroupRepository;
  /** 分组化起；分组成员快照（只增不改；watch hot path 只读 currentMembers）。 */
  readonly groupMember: GroupMemberRepository;
}

/**
 * 战法仓储（v0.3 起）。
 * 内存中默认装载 5 个 builtin 战法（BUILTIN_TACTICS）；user 战法由
 * save_user_tactic 显式落库。query() 主要给 list_tactics / run_tactic 用。
 */
export interface TacticRepository {
  save(tactic: Tactic): Promise<void>;
  findById(id: string): Promise<Tactic | null>;
  /** tag 过滤（如 'momentum'）；缺省返回全部。 */
  list(filter?: {
    readonly tag?: Tactic['tag'];
    readonly source?: Tactic['source'];
  }): Promise<readonly Tactic[]>;
  /** 战法运行时写入信号历史；按 ts 倒序。 */
  saveSignal(signal: TacticSignal): Promise<void>;
  signalsByTactic(tacticId: string, since?: Date): Promise<readonly TacticSignal[]>;
  signalsByStock(stockId: string, since?: Date): Promise<readonly TacticSignal[]>;
}

/**
 * 股票池仓储（v0.6 起，docs/intraday-watch-design.md §2）。
 * Key 用 pool.id（slug 唯一）。
 */
export interface StockPoolRepository {
  save(pool: StockPool): Promise<void>;
  findById(id: string): Promise<StockPool | null>;
  /** 默认全部；enabledOnly=true 仅返回 enabled=true。 */
  list(enabledOnly?: boolean): Promise<readonly StockPool[]>;
  remove(id: string): Promise<void>;
}

/**
 * 股票分组仓储（docs/stock-group-design.md §2）。
 * Key 用 group.id（slug 唯一）。
 */
export interface StockGroupRepository {
  save(group: StockGroup): Promise<void>;
  findById(id: string): Promise<StockGroup | null>;
  /** 默认全部；enabledOnly=true 仅返回 enabled=true。 */
  list(enabledOnly?: boolean): Promise<readonly StockGroup[]>;
  remove(id: string): Promise<void>;
}

/**
 * 分组成员快照仓储（docs/stock-group-design.md §1/§2）。
 * - 快照只增不改：一次刷新 = 一批（同一 refreshId），历史批次全保留（复盘 / 成员变化检测用）
 * - 当前成员语义 = 最新 refreshId 那一批；holdings resolver 是活视图，不写快照
 */
export interface GroupMemberRepository {
  /** 批量写入一批快照（通常同 refreshId）；同 id 重复写入忽略。 */
  saveBatch(snapshots: readonly GroupMemberSnapshot[]): Promise<void>;
  /** 当前成员：最新 refreshId 那一批（按 stockId 升序）；无快照返回空数组。 */
  currentMembers(groupId: string): Promise<readonly GroupMemberSnapshot[]>;
  /** 历史批次（含当前批），按 createdAt 倒序；since 过滤（createdAt ≥ since）。 */
  listHistory(groupId: string, since?: Date): Promise<readonly GroupMemberSnapshot[]>;
  /** 最新 refreshId；无快照返回 null。 */
  latestRefreshId(groupId: string): Promise<string | null>;
}

/**
 * 盯盘触发仓储（v0.6 起）。
 * - 每次 watch 评估 fire 的 trigger 都写入；被 cooldown 抑制的也写（notified=false），便于事后复盘"今天压了多少条"。
 * - lastForKey 用于通知 cooldown 查询（since = now − cooldownMinutes），只返回
 *   notified=true 的真实通知；notify=false 的试跑审计不能占后续通知冷却。
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
   * cooldown 查询：找 (poolId, stockId, ruleKind) 维度最近一条；since 通常 = now − cooldownMinutes。
   * 任意一个 stockId / ruleKind 为空都不命中（避免跨池误判）。
   */
  lastForKey(
    key: {
      readonly poolId: string;
      readonly stockId: string;
      readonly ruleKind: WatchRule['kind'];
    },
    since: Date,
  ): Promise<WatchTrigger | null>;
  /** 最近触发（CLI / TUI / MCP 展示用）。 */
  listRecent(opts?: {
    readonly poolId?: string;
    readonly since?: Date;
    readonly limit?: number;
  }): Promise<readonly WatchTrigger[]>;
  remove(id: string): Promise<void>;
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
