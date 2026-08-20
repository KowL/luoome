import type { AShareSentimentSnapshot } from './entity/ashare-sentiment.js';
import type {
  LimitUpLadder,
  LimitUpLadderDiff,
  LimitUpLadderQuery,
} from './entity/limit-up-ladder.js';
import type { MarketSnapshot, MarketSnapshotItem } from './entity/market-snapshot.js';
import type { MinuteBar, MinuteBarInterval } from './entity/minute-bar.js';
import type { NotificationPayload } from './entity/notification.js';
import type { DailyBar, DateRange, IndexQuote, IntradayMinute, Quote } from './entity/quote.js';
import type { Exchange } from './entity/stock.js';
import type { EventImportance, StockEventKind, StockEventStatus } from './entity/stock-event.js';
import type { MarketCoverage, StockUniverseSnapshot } from './entity/stock-universe.js';
import type { ToolErrorKind } from './error/index.js';
import type { RepositoryRegistry } from './repository/index.js';
import type {
  ResearchEmbeddingAdapterLike,
  ResearchRemoteImportAdapterLike,
  ResearchVaultAdapterLike,
} from './research-vault.js';
import type { SideEffect } from './types/side-effect.js';

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
  /** 外部数据源股票搜索；不支持时以 unsupported_capability 拒绝。 */
  searchStocks(query: string): Promise<StockSearchCandidate[]>;
  /** 大盘指数实时行情；不支持时以 unsupported_capability 拒绝。 */
  fetchIndexQuotes(): Promise<readonly IndexQuote[]>;
  /** 当日分时分钟序列（瞬态视图，不落库）；不支持时以 unsupported_capability 拒绝。 */
  fetchIntradayMinutes(stockId: string): Promise<readonly IntradayMinute[]>;
  /** 当前交易日的原生分钟 OHLCV；不支持时以 unsupported_capability 拒绝。 */
  fetchMinuteBars(stockId: string, interval: MinuteBarInterval): Promise<readonly MinuteBar[]>;
  /** 全市场快照；不支持时以 unsupported_capability 拒绝。 */
  fetchMarketSnapshot(): Promise<readonly MarketSnapshotItem[]>;
  /** 带来源、时间和分页完整性信封的全市场快照；不支持时以 unsupported_capability 拒绝。 */
  fetchMarketSnapshotEnvelope?(): Promise<MarketSnapshot>;
  /** 启用数据源与能力的动态库存及进程内健康观测。 */
  marketSourceStatus(): readonly MarketSourceStatus[];
}

export interface MarketSourceStatus {
  readonly dataset:
    | 'quote'
    | 'daily-bars'
    | 'search'
    | 'market-snapshot'
    | 'market-snapshot-envelope'
    | 'realtime-index'
    | 'delayed-index'
    | 'intraday-minutes'
    | 'minute-bars'
    | 'stock-universe'
    | 'limit-up-ladder';
  readonly source: string;
  readonly coverage: readonly MarketCoverage[];
  readonly capabilityEnabled: boolean;
  readonly configurationReady: boolean;
  readonly lastAttemptAt?: Date;
  readonly lastSuccessAt?: Date;
  readonly dataAsOf?: Date;
  readonly lastErrorKind?: string;
}

export interface StockUniverseManagerLike {
  readonly name: 'stock-universe';
  readonly sources: readonly string[];
  fetchStockUniverse(input: {
    readonly coverage: MarketCoverage;
    readonly source?: string;
  }): Promise<StockUniverseSnapshot>;
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

/** Tool 调用审计事件；实现可以写文件、数据库或其它受控审计 sink。 */
export interface AuditLogEvent {
  readonly ts: Date;
  readonly tool: string;
  readonly sideEffect: SideEffect;
  readonly result: 'ok' | 'error';
  readonly errorKind?: ToolErrorKind;
  readonly caller: string;
}

/** core 只定义审计投影，不承担 IO。 */
export interface AuditLoggerLike {
  write(event: AuditLogEvent): void | Promise<void>;
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
    readonly stockUniverse?: StockUniverseManagerLike;
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
  /** A 股日级情绪证据聚合器；外部源与维度降级封装在 adapters。 */
  readonly ashareSentiment?: AShareSentimentManagerLike;
  readonly user: {
    readonly id: string;
    readonly defaultAccountId: string;
  };
  readonly clock: () => Date;
  readonly logger: Logger;
  /** write/external/advice/trade tool 的结构化审计 sink；测试上下文可省略。 */
  readonly auditLog?: AuditLoggerLike;
  /** 审计事件的调用方标签，例如 cli / mcp / web / tui。 */
  readonly auditCaller?: string;
  readonly researchVault?: ResearchVaultAdapterLike;
  readonly researchRemote?: ResearchRemoteImportAdapterLike;
  /** 私人正文外发的 embedding capability；仅由 external tool 显式调用。 */
  readonly researchEmbedding?: ResearchEmbeddingAdapterLike;
  /** 生产账户绩效的默认 benchmark；测试上下文可不注入以显式保持 unavailable。 */
  readonly portfolioBenchmark?: {
    readonly stockId: string;
    readonly name: string;
  };
}

export type AShareSentimentManagerResult =
  | { readonly ok: true; readonly data: AShareSentimentSnapshot }
  | {
      readonly ok: false;
      readonly error: {
        readonly kind: 'invalid_input' | 'adapter_error';
        readonly message: string;
        readonly recoverable: boolean;
      };
    };

export interface AShareSentimentManagerLike {
  fetch(input: {
    readonly date: string;
    readonly coverage: 'CN_A_SHARES_SH_SZ';
  }): Promise<AShareSentimentManagerResult>;
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
  readonly sources: readonly string[];
  fetchLadder(query: LimitUpLadderQuery): Promise<LimitUpLadderResultLike>;
  compareLadder(
    date: string,
    prevDate: string,
    query: Omit<LimitUpLadderQuery, 'date'>,
  ): Promise<LimitUpLadderCompareResultLike>;
}
