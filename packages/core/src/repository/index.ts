import type { Account } from '../entity/account.js';
import type { Advice, AdviceOutcome, AdviceQuery } from '../entity/advice.js';
import type { Holding } from '../entity/holding.js';
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
}
