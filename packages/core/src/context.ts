import type { DailyBar, DateRange, Quote } from './entity/quote.js';
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
}

/** LLM 调用请求（ARCHITECTURE §6.3：system + schema + data）。 */
export interface LLMGenerateRequest {
  readonly system: string;
  /** Zod schema（schema-constrained decoding），v0.1 mock 可忽略。 */
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
export interface ToolContext {
  readonly repos: RepositoryRegistry;
  readonly adapters: {
    readonly market: MarketDataAdapterLike;
    readonly llm: LLMAdapterLike;
  };
  readonly user: {
    readonly id: string;
    readonly defaultAccountId: string;
  };
  readonly clock: () => Date;
  readonly logger: Logger;
}
