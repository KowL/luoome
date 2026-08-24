import type { AShareSentimentSnapshot } from './entity/ashare-sentiment.js';
import type { DragonTigerList, DragonTigerListQuery } from './entity/dragon-tiger.js';
import type {
  FinancialFact,
  FinancialMissingReason,
  FinancialPeriodType,
} from './entity/fundamental.js';
import type {
  LimitUpLadder,
  LimitUpLadderDiff,
  LimitUpLadderQuery,
} from './entity/limit-up-ladder.js';
import type { MarketSnapshot, MarketSnapshotItem } from './entity/market-snapshot.js';
import type { MinuteBar, MinuteBarInterval } from './entity/minute-bar.js';
import type { FetchNewsQuery, NewsList } from './entity/news.js';
import type { NorthboundFlowQuery, NorthboundFlowSeries } from './entity/northbound-flow.js';
import type { NotificationPayload } from './entity/notification.js';
import type { DailyBar, DateRange, IndexQuote, IntradayMinute, Quote } from './entity/quote.js';
import type { FetchSectorQuotesQuery, SectorQuoteList } from './entity/sector-quote.js';
import type { Exchange } from './entity/stock.js';
import type { EventImportance, StockEventKind, StockEventStatus } from './entity/stock-event.js';
import type { MarketCoverage, StockUniverseSnapshot } from './entity/stock-universe.js';
import type { ToolErrorKind } from './error/index.js';
import type { RepositoryRegistry } from './repository/index.js';
import type {
  ResearchEmbeddingAdapterLike,
  ResearchRemoteImportAdapterLike,
  ResearchVaultAdapterLike,
  ResearchVaultGitSyncAdapterLike,
} from './research-vault.js';
import type { SourceErrorKind, SourceStatus } from './source.js';
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
  /** 主动探测指定源的各 capability（设置页「测试」按钮）；直接执行 registry handle，不经过路由 / 缓存 / 限速。 */
  probeSource?(source: string): Promise<readonly MarketSourceProbe[]>;
}

/** 行情域的 SourceStatus 收窄别名：coverage 为 MarketCoverage；dataset 保持开放 string（与泛型 registry 解耦，新增 capability 不要求改 core）。 */
export interface MarketSourceStatus extends Omit<SourceStatus, 'coverage'> {
  readonly coverage: readonly MarketCoverage[];
}

/** 单项能力主动探测结果（设置页「测试」按钮）；capability 保持开放 string，理由同 MarketSourceStatus。 */
export interface MarketSourceProbe {
  readonly capability: string;
  /** false 表示该源未绑定此能力，未执行探测。 */
  readonly bound: boolean;
  /** 探测结果；bound=false 时为 null。 */
  readonly ok: boolean | null;
  readonly errorKind?: SourceErrorKind;
  readonly durationMs?: number;
}

export interface StockUniverseManagerLike {
  readonly name: 'stock-universe';
  readonly sources: readonly string[];
  fetchStockUniverse(input: {
    readonly coverage: MarketCoverage;
    readonly source?: string;
  }): Promise<StockUniverseSnapshot>;
}

/**
 * Phase 3 financial-fact gate. `not-ready` is the safe default until a source
 * proves publication/revision metadata and real PIT coverage; it must not be
 * inferred from transport success or fixture data.
 */
export type FundamentalDataGateStatus = 'not-ready' | 'evaluation-ready' | 'operational';

export interface FundamentalDataGate {
  readonly name: 'fundamental-data-gate-v1';
  readonly status: FundamentalDataGateStatus;
  readonly reasons: readonly string[];
  readonly evaluatedAt: Date;
}

export type FundamentalIngestionIssueReason =
  | FinancialMissingReason
  | 'invalid-payload'
  | 'unsupported-capability';

/** Structured issue retained when a source row cannot become a FinancialFact. */
export interface FundamentalIngestionIssue {
  readonly source: string;
  readonly reason: FundamentalIngestionIssueReason;
  readonly message: string;
  readonly observedAt: Date;
  readonly stockId?: string;
  readonly metricId?: string;
  readonly periodType?: FinancialPeriodType;
  readonly periodEnd?: Date;
  readonly sourceRecordId?: string;
  readonly sourceRevision?: string;
}

/** Raw revision query; adapters return all source revisions, leaving PIT choice to core. */
export interface FundamentalDataQuery {
  readonly stockIds: readonly string[];
  readonly metricIds?: readonly string[];
  readonly periodFrom?: Date;
  readonly periodTo?: Date;
}

export interface FundamentalDataAdapterResult {
  readonly source: string;
  readonly gateStatus: FundamentalDataGateStatus;
  readonly gate: FundamentalDataGate;
  readonly revisions: readonly FinancialFact[];
  readonly issues: readonly FundamentalIngestionIssue[];
  readonly observedAt: Date;
}

/**
 * Independent from MarketDataAdapterLike: current quote/daily-bar sources
 * cannot satisfy the publication/revision PIT contract by being renamed.
 */
export interface FundamentalDataAdapterLike {
  readonly name: string;
  readonly source: string;
  readonly gateStatus: FundamentalDataGateStatus;
  readonly gate: FundamentalDataGate;
  fetchFinancialFactRevisions(input: FundamentalDataQuery): Promise<FundamentalDataAdapterResult>;
}

export type FundamentalDataAdapterInput = FundamentalDataQuery;
export type FundamentalDataAdapterOutput = FundamentalDataAdapterResult;

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
  /**
   * 龙虎榜 manager；顶层字段（与 limitUpLadder 同级），日级批量快照语义相同。
   * tools 层通过 ctx.dragonTiger.fetchList 访问。
   */
  readonly dragonTiger?: DragonTigerManagerLike;
  /**
   * 北向资金日级历史流 manager；顶层字段（与 dragonTiger 同级），日级批量序列语义相同。
   * tools 层通过 ctx.northboundFlow.fetchSeries 访问。
   */
  readonly northboundFlow?: NorthboundFlowManagerLike;
  /**
   * 财经要闻 manager；顶层字段（与 northboundFlow 同级），日级批量列表语义相同。
   * tools 层通过 ctx.news.fetchNews 访问。
   */
  readonly news?: NewsManagerLike;
  /**
   * 行业板块行情 manager；顶层字段（与 news 同级），实时快照语义。
   * tools 层通过 ctx.sectorQuote.fetchList 访问。
   */
  readonly sectorQuote?: SectorQuoteManagerLike;
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
  readonly researchVaultGitSync?: ResearchVaultGitSyncAdapterLike;
  /** Surface 级取消信号；长外部操作只在安全取消点消费。 */
  readonly abortSignal?: AbortSignal;
  /** 生产账户绩效的默认 benchmark；测试上下文可不注入以显式保持 unavailable。 */
  readonly portfolioBenchmark?: {
    readonly stockId: string;
    readonly name: string;
  };
  /** Phase 3 P3-1：显式基本面数据 adapter；未注入时同步入口保持 unavailable。 */
  readonly fundamentalData?: FundamentalDataAdapterLike;
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
  /** 封板 / 炸板两个 capability 的进程内源健康观测（registry.describe()）。 */
  status(): readonly SourceStatus[];
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
  /** 进程内源健康观测（registry.describe()）。 */
  status(): readonly SourceStatus[];
}

/**
 * 龙虎榜 manager 投影。
 * - core 不依赖 adapters；返回类型直接是 core 的 DragonTigerList（manager 内部已组装为最终快照）
 * - 失败/不可用 → 返回 { ok: false, error }，调用方按 ToolError 协议转译
 */
export interface DragonTigerResultLike {
  readonly ok: boolean;
  readonly data?: DragonTigerList;
  readonly error?: {
    readonly kind: 'adapter_error';
    readonly adapter: 'dragon-tiger';
    readonly message: string;
    readonly recoverable: boolean;
  };
}

export interface DragonTigerManagerLike {
  readonly name: 'dragon-tiger';
  readonly sources: readonly string[];
  fetchList(query: DragonTigerListQuery): Promise<DragonTigerResultLike>;
  /** 进程内源健康观测（registry.describe()）。 */
  status(): readonly SourceStatus[];
}

/**
 * 北向资金历史流 manager 投影。
 * - core 不依赖 adapters；返回类型直接是 core 的 NorthboundFlowSeries（manager 内部已组装为最终快照）
 * - 失败/不可用 → 返回 { ok: false, error }，调用方按 ToolError 协议转译
 */
export interface NorthboundFlowResultLike {
  readonly ok: boolean;
  readonly data?: NorthboundFlowSeries;
  readonly error?: {
    readonly kind: 'adapter_error';
    readonly adapter: 'northbound-flow';
    readonly message: string;
    readonly recoverable: boolean;
  };
}

export interface NorthboundFlowManagerLike {
  readonly name: 'northbound-flow';
  readonly sources: readonly string[];
  fetchSeries(query: NorthboundFlowQuery): Promise<NorthboundFlowResultLike>;
  /** 进程内源健康观测（registry.describe()）。 */
  status(): readonly SourceStatus[];
}

/**
 * 财经要闻 manager 投影。
 * - core 不依赖 adapters；返回类型直接是 core 的 NewsList（manager 内部已组装为最终快照）
 * - 失败/不可用 → 返回 { ok: false, error }，调用方按 ToolError 协议转译
 */
export interface NewsResultLike {
  readonly ok: boolean;
  readonly data?: NewsList;
  readonly error?: {
    readonly kind: 'adapter_error';
    readonly adapter: 'news';
    readonly message: string;
    readonly recoverable: boolean;
  };
}

export interface NewsManagerLike {
  readonly name: 'news';
  readonly sources: readonly string[];
  fetchNews(query: FetchNewsQuery): Promise<NewsResultLike>;
  /** 进程内源健康观测（registry.describe()）。 */
  status(): readonly SourceStatus[];
}

/**
 * 行业板块行情 manager 投影。
 * - core 不依赖 adapters；返回类型直接是 core 的 SectorQuoteList（manager 内部已组装为最终快照）
 * - 失败/不可用 → 返回 { ok: false, error }，调用方按 ToolError 协议转译
 */
export interface SectorQuoteResultLike {
  readonly ok: boolean;
  readonly data?: SectorQuoteList;
  readonly error?: {
    readonly kind: 'adapter_error';
    readonly adapter: 'sector-quote';
    readonly message: string;
    readonly recoverable: boolean;
  };
}

export interface SectorQuoteManagerLike {
  readonly name: 'sector-quote';
  readonly sources: readonly string[];
  fetchList(query: FetchSectorQuotesQuery): Promise<SectorQuoteResultLike>;
}
