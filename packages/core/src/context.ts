import type { AShareSentimentSnapshot } from './entity/ashare-sentiment.js';
import type { DragonTigerList, DragonTigerListQuery } from './entity/dragon-tiger.js';
import type { DragonTigerFlow, DragonTigerFlowQuery } from './entity/dragon-tiger-flow.js';
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
import type { MarketCoverage, StockUniverseSnapshot } from './entity/stock-universe.js';
import type { ToolErrorKind } from './error/index.js';
import type { RepositoryRegistry } from './repository/index.js';
import type { ResearchVaultAdapterLike } from './research-vault.js';
import type { SourceErrorKind, SourceStatus } from './source.js';
import type { SideEffect } from './types/side-effect.js';

/**
 * core 不能 import adapters 包（ARCHITECTURE §3 依赖方向），
 * 因此这里定义结构化接口；packages/adapters 的实现天然满足之。
 */

/** 行情数据源（ARCHITECTURE §4.7 MarketDataAdapter 的 core 侧投影）。 */
export interface MarketDataAdapterLike {
  readonly name: string;
  fetchQuote(stockCode: string, options?: { readonly requireDetails?: boolean }): Promise<Quote>;
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
  fetchMarketSnapshotEnvelope?(options?: {
    /** true 时不把不完整信封当失败；批次发布需要照常落库并标注缺口。 */
    readonly allowPartial?: boolean;
  }): Promise<MarketSnapshot>;
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

/** Agent 可调用工具的 SDK 无关投影；DSH gateway 只按此契约绑定工具。 */
export interface AgentCallableTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  execute(input: unknown): Promise<{
    readonly ok: boolean;
    readonly output: unknown;
  }>;
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
    readonly id?: string;
    readonly channel: 'feishu' | 'log';
    readonly payload: NotificationPayload;
    readonly adviceId?: string;
    readonly tacticSignalId?: string;
  }): Promise<{ readonly notification: unknown }>;
}

export interface ToolContextMarketIntel {
  readonly limitUpLadder?: LimitUpLadderManagerLike;
  readonly dragonTiger?: DragonTigerManagerLike;
  readonly dragonTigerFlow?: DragonTigerFlowManagerLike;
  readonly northboundFlow?: NorthboundFlowManagerLike;
  readonly news?: NewsManagerLike;
  readonly sectorQuote?: SectorQuoteManagerLike;
  readonly ashareSentiment?: AShareSentimentManagerLike;
}

export interface ToolContextAdapters {
  readonly market: MarketDataAdapterLike;
  readonly llm: LLMAdapterLike;
  readonly stockUniverse?: StockUniverseManagerLike;
  /** send_notification tool 用；装配时由 CLI/MCP 注入。 */
  readonly notification?: NotificationManagerLike;
  /** Research Vault 本地 Markdown 适配器（Obsidian 或目录实现）。 */
  readonly researchVault?: ResearchVaultAdapterLike;
  /** 日级批量的市场情报 managers（连板天梯/龙虎榜/北向/要闻/板块/情绪）。 */
  readonly marketIntel?: ToolContextMarketIntel;
}

export interface ToolContext {
  readonly repos: RepositoryRegistry;
  readonly adapters: ToolContextAdapters;
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
  /** Surface 级取消信号；长外部操作只在安全取消点消费。 */
  readonly abortSignal?: AbortSignal;
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
  /** 封板 / 炸板两个 capability 的进程内源健康观测（registry.describe()）。 */
  status(): readonly SourceStatus[];
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
 * 龙虎榜资金流向拓扑 manager 投影（跨交易日概念聚合；数据源为同花顺龙虎榜）。
 * - core 不依赖 adapters；返回类型直接是 core 的 DragonTigerFlow（manager 内部已聚合）
 * - 失败/不可用 → 返回 { ok: false, error }，调用方按 ToolError 协议转译
 */
export interface DragonTigerFlowResultLike {
  readonly ok: boolean;
  readonly data?: DragonTigerFlow;
  readonly error?: {
    readonly kind: 'adapter_error';
    readonly adapter: 'dragon-tiger-flow';
    readonly message: string;
    readonly recoverable: boolean;
  };
}

export interface DragonTigerFlowManagerLike {
  readonly name: 'dragon-tiger-flow';
  readonly sources: readonly string[];
  fetchFlow(query: DragonTigerFlowQuery): Promise<DragonTigerFlowResultLike>;
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
