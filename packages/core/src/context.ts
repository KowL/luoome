import type { NotificationPayload } from './entity/notification.js';
import type { DailyBar, DateRange, Quote } from './entity/quote.js';
import type { Exchange } from './entity/stock.js';
import type { RepositoryRegistry } from './repository/index.js';

/**
 * core 不能 import adapters 包（ARCHITECTURE §3 依赖方向），
 * 因此这里定义结构化接口；packages/adapters 的实现天然满足之。
 */

/** 行情数据源（ARCHITECTURE §4.7 MarketDataAdapter 的 core 侧投影）。 */
export interface MarketDataAdapterLike {
  readonly name: string;
  fetchQuote(stockCode: string): Promise<Quote>;
  batchQuote(stockCodes: readonly string[]): Promise<Map<string, Quote>>;
  fetchDailyBars(stockCode: string, range: DateRange): Promise<DailyBar[]>;
  /**
   * 外部数据源股票搜索（v0.8 起，可选实现）。
   * search_stocks tool 优先走它；未实现或抛错时降级本地 StockRepository。
   */
  searchStocks?(query: string): Promise<StockSearchCandidate[]>;
}

/** 股票搜索候选（外部数据源统一形状；id = '<code>.<EXCHANGE>'）。 */
export interface StockSearchCandidate {
  readonly id: string;
  readonly code: string;
  readonly exchange: Exchange;
  readonly name: string;
}

/** LLM 调用请求（ARCHITECTURE §6.3：system + schema + data）。 */
export interface LLMGenerateRequest {
  readonly system: string;
  /** Zod schema（schema-constrained decoding）。 */
  readonly schema?: unknown;
  readonly data: unknown;
}

/** LLM 适配器的 core 侧投影。 */
export interface LLMAdapterLike {
  readonly name: string;
  generate<T = unknown>(request: LLMGenerateRequest): Promise<T>;
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * 所有 tool / workflow handler 收到的 ctx（ARCHITECTURE §4.8）。
 * ctx 是唯一被允许注入依赖的方式。
 */
/**
 * NotificationManager 投影（v0.3 起；core 不依赖 adapters 包）：
 * - adapters 包提供 NotificationManager 实现；core 仅暴露 send 接口。
 */
export interface NotificationManagerLike {
  send(input: {
    readonly channel: 'feishu' | 'log';
    readonly payload: NotificationPayload;
    readonly adviceId?: string;
    readonly tacticSignalId?: string;
  }): Promise<{ readonly notification: unknown }>;
}

export interface ToolContext {
  readonly repos: RepositoryRegistry;
  readonly adapters: {
    readonly market: MarketDataAdapterLike;
    readonly llm: LLMAdapterLike;
  };
  /** v0.3 起；send_notification tool 用。装配时由 CLI/MCP 注入。 */
  readonly notification?: NotificationManagerLike;
  readonly user: {
    readonly id: string;
    readonly defaultAccountId: string;
  };
  readonly clock: () => Date;
  readonly logger: Logger;
}
