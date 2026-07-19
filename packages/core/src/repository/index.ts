import type { Account } from '../entity/account.js';
import type { Advice, AdviceOutcome, AdviceQuery } from '../entity/advice.js';
import type { Holding } from '../entity/holding.js';
import type { DailyBar, Quote } from '../entity/quote.js';
import type { Stock } from '../entity/stock.js';
import type { Trade } from '../entity/trade.js';

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
}
