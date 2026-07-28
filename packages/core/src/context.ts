import type {
  LimitUpLadder,
  LimitUpLadderDiff,
  LimitUpLadderQuery,
} from './entity/limit-up-ladder.js';
import type { NotificationPayload } from './entity/notification.js';
import type { DailyBar, DateRange, IndexQuote, Quote } from './entity/quote.js';
import type { Exchange } from './entity/stock.js';
import type { EventImportance, StockEventKind, StockEventStatus } from './entity/stock-event.js';
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
  /**
   * 大盘指数实时行情（可选实现）。
   * 数据源不支持指数行情时不实现该方法；调用方按「不支持」降级处理
   * （fetch_index_quotes tool 返回 { indices: [], unsupported: true }）。
   */
  fetchIndexQuotes?(): Promise<readonly IndexQuote[]>;
  /**
   * 全市场快照（可选实现；分组刷新 / run_tactic scope=all-stocks 的候选全集来源）。
   * 数据源不支持时不实现该方法；未实现或抛错时调用方降级本地 StockRepository。
   */
  fetchMarketSnapshot?(): Promise<readonly MarketSnapshotItem[]>;
}

/** 股票搜索候选（外部数据源统一形状；id = '<code>.<EXCHANGE>'）。 */
export interface StockSearchCandidate {
  readonly id: string;
  readonly code: string;
  readonly exchange: Exchange;
  readonly name: string;
}

/** 全市场快照条目（id 约定同 StockSearchCandidate）；close/changePct 缺失表示无报价。 */
export interface MarketSnapshotItem {
  readonly id: string;
  readonly code: string;
  readonly exchange: Exchange;
  readonly name: string;
  readonly close?: number;
  readonly changePct?: number;
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

/** Agent 可调用工具的 SDK 无关投影；具体 ToolLoopAgent 类型只存在于 adapters。 */
export interface AgentCallableTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  execute(input: unknown): Promise<{
    readonly ok: boolean;
    readonly output: unknown;
  }>;
}

export interface AgentToolTrace {
  readonly toolName: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly ok: boolean;
  readonly durationMs: number;
}

export interface AgentTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface AgentRuntimeRequest {
  readonly instructions: string;
  readonly prompt: string;
  readonly outputSchema: unknown;
  readonly tools: readonly AgentCallableTool[];
}

export interface AgentRuntimeResult {
  readonly output: unknown;
  readonly trace: readonly AgentToolTrace[];
  readonly usedTools: readonly string[];
  readonly totalUsage: AgentTokenUsage;
}

/** 多步 agent runtime 的 core 侧投影；禁止出现 AI SDK 类型。 */
export interface AgentRuntimeLike {
  readonly name: string;
  run(request: AgentRuntimeRequest): Promise<AgentRuntimeResult>;
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
  /** Phase 2：可选多步 agent runtime；测试或未配置 surface 可不注入。 */
  readonly agent?: AgentRuntimeLike;
  /** v0.3 起；send_notification tool 用。装配时由 CLI/MCP 注入。 */
  readonly notification?: NotificationManagerLike;
  /**
   * ruo 迁移 Phase 1B（docs/ddd/ruo-feature-migration-detailed-design.md §4.1）：公司事件数据源。
   * 装配时注入；未配置（数据源选型未定，开放问题 1）时为空数组 → sync-stock-events 记 syncedStocks=0。
   */
  readonly eventProviders?: readonly StockEventProviderLike[];
  /**
   * 连板天梯 manager（Phase 1，docs/ddd/limit-up-ladder-detailed-design.md §8）。
   * 顶层字段（与 notification / eventProviders 同级），因为 limit-up-ladder
   * 是日级批量快照而不是实时 quote 流，与 `adapters.market` 语义不同。
   * tools 层通过 ctx.limitUpLadder.fetchLadder / compareLadder 访问。
   */
  readonly limitUpLadder?: LimitUpLadderManagerLike;
  readonly user: {
    readonly id: string;
    readonly defaultAccountId: string;
  };
  readonly clock: () => Date;
  readonly logger: Logger;
}

/**
 * 公司事件数据源（ruo 迁移 §4.1）。原始字段差异封装在实现内；输出结构对齐 StockEvent（无 id / stale）。
 */
export interface ExternalStockEvent {
  readonly stockId: string;
  readonly kind: StockEventKind;
  readonly title: string;
  readonly description?: string;
  readonly occursAt: Date;
  readonly allDay?: boolean;
  readonly importance: EventImportance;
  readonly status?: StockEventStatus;
  /** 幂等键：provider 侧稳定 id。 */
  readonly externalId: string;
  readonly sourceUrl?: string;
  readonly observedAt?: Date;
}

export interface StockEventProviderLike {
  readonly name: string;
  readonly supportedKinds: readonly StockEventKind[];
  fetchEvents(input: {
    readonly stockIds: readonly string[];
    readonly kinds?: readonly StockEventKind[];
    readonly windowDays: number;
  }): Promise<readonly ExternalStockEvent[]>;
}

/**
 * 连板天梯 manager 投影（Phase 1）。
 * - core 不依赖 adapters；返回类型直接是 core 的 LimitUpLadder（manager 内部已组装为最终快照）
 * - 失败/不可用 → 返回 { ok: false, error }，调用方按 ToolError 协议转译
 */
export interface LimitUpLadderResultLike {
  readonly ok: boolean;
  readonly data?: LimitUpLadder;
  readonly error?: {
    readonly kind: 'adapter_error';
    readonly adapter: 'limit-up-ladder';
    readonly message: string;
    readonly recoverable: boolean;
  };
}

export interface LimitUpLadderCompareResultLike {
  readonly ok: boolean;
  readonly data?: {
    readonly curr: LimitUpLadder;
    readonly prev: LimitUpLadder;
    readonly diff: LimitUpLadderDiff;
  };
  readonly error?: {
    readonly kind: string;
    readonly adapter: string;
    readonly message: string;
    readonly recoverable: boolean;
  };
}

export interface LimitUpLadderManagerLike {
  readonly name: 'limit-up-ladder';
  fetchLadder(query: LimitUpLadderQuery): Promise<LimitUpLadderResultLike>;
  compareLadder(
    date: string,
    prevDate: string,
    query: Omit<LimitUpLadderQuery, 'date'>,
  ): Promise<LimitUpLadderCompareResultLike>;
}
