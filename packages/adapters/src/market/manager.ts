import type {
  DailyBar,
  DateRange,
  IndexQuote,
  IntradayMinute,
  Logger,
  MarketCoverage,
  MarketSnapshot,
  MarketSnapshotItem,
  MarketSourceProbe,
  MinuteBar,
  MinuteBarInterval,
  Quote,
  StockSearchCandidate,
} from '@luoome/core';
import {
  assertMarketSnapshotInvariants,
  DailyBarSchema,
  isHoliday,
  isWeekend,
  QuoteSchema,
} from '@luoome/core';
import { sourceErrorKindOf } from '../source-error.js';
import { DailyBarCache, type LRUStats, QuoteCache } from './cache.js';
import type {
  MarketCapability,
  MarketCapabilityMap,
  MarketSourceRegistry,
  MarketSourceStatus,
} from './source-registry.js';
import type { MarketDataAdapter } from './types.js';

const INTRADAY_MINUTES_TTL_MS = 30_000;
const MINUTE_BARS_TTL_MS = 15_000;

/** 探测用的固定标的与检索词：高流动性大盘股，五个源都覆盖。 */
const PROBE_STOCK_ID = '600519.SH';
const PROBE_SEARCH_QUERY = '茅台';
/** 日 K 探测窗口：两周，含交易日的概率高且响应轻。 */
const PROBE_DAILY_BARS_WINDOW_MS = 14 * 86_400_000;

/** 批量结果与请求代码匹配用：去掉 .SH/.SZ/.BJ 后缀，兼容源返回带后缀而调用方传裸代码（如 fuyao）。 */
const baseOf = (code: string): string => code.replace(/\.(SH|SZ|BJ)$/i, '');

const rangeContainsTradingDay = (range: DateRange): boolean => {
  const cursor = new Date(range.start);
  cursor.setUTCHours(0, 0, 0, 0);
  const end = range.end.getTime();
  while (cursor.getTime() <= end) {
    if (!isWeekend(cursor) && !isHoliday(cursor)) return true;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return false;
};

const validateDailyBars = (bars: readonly DailyBar[], range: DateRange): DailyBar[] => {
  const parsed = bars.map((bar) => DailyBarSchema.parse(bar));
  if (parsed.length === 0 && rangeContainsTradingDay(range)) {
    throw new Error('no_data: empty daily bars in a trading-day candidate range');
  }
  if (parsed.some((bar) => bar.date < range.start || bar.date > range.end)) {
    throw new Error('invalid_data: daily bars outside requested range');
  }
  return parsed;
};

/** 错误识别：Manager 需要把异常归类（adapter / network）。 */
// 错误识别：Manager 不依赖具体 adapter 错误类，用 structural check。
// 真要 throw EastmoneyAdapterError / TencentAdapterError 的归类在 adapter 内。
// （保留 isEastmoneyError / isTencentError 是为了 v0.3+ 测试与扩展点，暂未使用。）

/** 简单 rate limiter：滑动窗口按 ms 切分，避免单秒内超过 limit。 */
class RateLimiter {
  private windowStart = Date.now();
  private countInWindow = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number = 1_000,
  ) {}

  async acquire(): Promise<void> {
    while (true) {
      const now = Date.now();
      const elapsed = now - this.windowStart;
      if (elapsed >= this.windowMs) {
        this.windowStart = now;
        this.countInWindow = 0;
      }
      if (this.countInWindow < this.limit) {
        this.countInWindow += 1;
        return;
      }
      // 超限；sleep 到下个窗口起点
      const sleepMs = this.windowMs - (now - this.windowStart);
      await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
    }
  }

  reset(): void {
    this.windowStart = Date.now();
    this.countInWindow = 0;
  }
}

export interface MarketDataManagerOptions {
  readonly registry: MarketSourceRegistry;
  readonly quoteCache?: QuoteCache;
  readonly dailyBarCache?: DailyBarCache;
  readonly rateLimitPerSec?: number;
  /** batchQuote 内部逐股 fallback 的并发上限。 */
  readonly batchConcurrency?: number;
  readonly logger: Logger;
  readonly clock?: () => Date;
  /** 末源抑制窗口（按股票 / 搜索 query 隔离）。默认 30 分钟。 */
  readonly finalFallbackSuppressMs?: number;
  /**
   * 全市场快照缓存 TTL。默认 5 分钟：refresh-groups 逐组刷新会在一轮运行内
   * 反复取候选全集，TTL 内复用同一份快照，避免每组都全量拉一遍。
   */
  readonly marketSnapshotTtlMs?: number;
}

/** 单个 source 的调用统计：calls 含失败尝试，failures 是其中失败的部分。 */
export interface SourceCallStats {
  readonly source: string;
  readonly calls: number;
  readonly failures: number;
}

export interface ManagerStats {
  /**
   * 按 source 名聚合并跨 capability 累计的调用计数，与源数量无关（不再是
   * 主 / 备 / 第三源的三档语义）。source 名即 registry binding 的 source id。
   */
  readonly sources: readonly SourceCallStats[];
  readonly cache: { readonly quote: LRUStats; readonly dailyBar: LRUStats };
}

/**
 * routeWithFallback 的能力策略：每个能力方法只声明自己的差异点——缓存查 / 写、
 * 限速器、结果校验、末源抑制窗口 affinity key；编排骨架（源循环 + 限速 + 降级 +
 * 末次错误抛出）只有一份实现。
 */
interface RoutePolicy<C extends MarketCapability, T> {
  /** 路由的 capability；无源时骨架抛 `unsupported_capability: <capability>`。 */
  readonly capability: C;
  readonly constraint?: { readonly coverage?: MarketCoverage };
  readonly request: MarketCapabilityMap[C]['request'];
  /** 路由前查缓存；返回非 undefined 即命中，直接返回不打源。 */
  readonly readCache?: () => T | undefined;
  /** 结果校验 / 转换；抛错视为该源失败，降级到下一个源。 */
  readonly parse: (result: MarketCapabilityMap[C]['result'], source: string) => T;
  /** 成功副作用（写缓存等）。 */
  readonly onSuccess?: (value: T) => void;
  /** 限速器（minute-bars 用独立 limiter，不与其它能力混算）。 */
  readonly rateLimiter: RateLimiter;
  readonly logLabel: string;
  readonly logContext: Record<string, unknown>;
  /** 全部源失败后要抛的错误。 */
  readonly exhausted: (lastError: unknown) => unknown;
  /**
   * 提供则启用末源抑制窗口：sources.length > 2 且窗口内时亲和到最后一个源；
   * 序号 >= 2 的源成功后记录窗口起点。窗口 per-key 隔离。
   */
  readonly affinityKey?: string;
}

/**
 * MarketDataManager（v0.2 起，adapter 编排层）。
 *
 * 工作流（fetchQuote 为例）：
 * 1. 查 QuoteCache；命中即返回
 * 2. 未命中 → rate limiter acquire
 * 3. 按 Registry 中 quote capability 的顺序调用 source
 * 4. 失败时记录健康观测并尝试下一个显式 source
 * 5. 全部失败时明确抛错，不进入 Registry 之外的隐藏来源。
 *
 * 末源抑制窗口是 per-key（股票 / 搜索 query）隔离的：某只股票主备失败启用末源后，
 * 只有该股票在窗口内跳过主备源，不影响池内其它股票——避免一只港股 / 故障股熔断全池。
 */
export class MarketDataManager implements MarketDataAdapter {
  readonly name = 'manager';

  private readonly registry: MarketSourceRegistry;
  private readonly quoteCache: QuoteCache;
  private readonly dailyBarCache: DailyBarCache;
  private readonly rateLimiter: RateLimiter;
  /** Tushare 官方实时分钟上限 500 次/分钟；独立 limiter 不与其它行情能力混算。 */
  private readonly minuteBarRateLimiter = new RateLimiter(500, 60_000);
  private readonly batchConcurrency: number;
  private readonly logger: Logger;
  private readonly clock: () => Date;
  private readonly suppressMs: number;
  private readonly marketSnapshotTtlMs: number;
  /** 全市场快照 TTL 缓存（单 key：全市场只有一份）。 */
  private marketSnapshotCache:
    | { readonly at: number; readonly items: readonly MarketSnapshotItem[] }
    | undefined;
  private marketSnapshotEnvelopeCache:
    | { readonly at: number; readonly snapshot: MarketSnapshot }
    | undefined;
  /** 当日分时 TTL 缓存（per stockId）。 */
  private readonly intradayMinutesCache = new Map<
    string,
    { readonly at: number; readonly points: readonly IntradayMinute[] }
  >();
  private readonly minuteBarsCache = new Map<
    string,
    { readonly at: number; readonly bars: readonly MinuteBar[] }
  >();

  /** 按 source 名的调用 / 失败计数（跨 capability 累计）。 */
  private readonly sourceCalls = new Map<string, number>();
  private readonly sourceFailures = new Map<string, number>();
  /** 各 key（股票代码 / 搜索 query）最近一次启用末源的时间；窗口是 per-key 隔离的。 */
  private readonly finalFallbackAtByKey = new Map<string, number>();

  constructor(options: MarketDataManagerOptions) {
    this.clock = options.clock ?? ((): Date => new Date());
    this.registry = options.registry;
    this.quoteCache = options.quoteCache ?? new QuoteCache(1024, 60_000, this.clock);
    this.dailyBarCache = options.dailyBarCache ?? new DailyBarCache(512, 3_600_000, this.clock);
    this.rateLimiter = new RateLimiter(options.rateLimitPerSec ?? 10);
    this.batchConcurrency = Math.max(1, Math.min(options.batchConcurrency ?? 8, 64));
    this.logger = options.logger;
    this.suppressMs = options.finalFallbackSuppressMs ?? 30 * 60 * 1000;
    this.marketSnapshotTtlMs = options.marketSnapshotTtlMs ?? 5 * 60 * 1000;
  }

  /** 该 key 是否处于末源抑制窗口内（窗口内跳过主备源，直达末源）。 */
  private inSuppressWindow(key: string, now: Date): boolean {
    const at = this.finalFallbackAtByKey.get(key);
    return at !== undefined && now.getTime() - at < this.suppressMs;
  }

  private recordCall(source: string): void {
    this.sourceCalls.set(source, (this.sourceCalls.get(source) ?? 0) + 1);
  }

  private recordFailure(source: string): void {
    this.sourceFailures.set(source, (this.sourceFailures.get(source) ?? 0) + 1);
  }

  /**
   * 统一编排骨架：查缓存 → 按 registry 顺序逐源尝试（限速 + 校验 + 降级）→
   * 全失败抛 policy.exhausted(lastError)。声明 affinityKey 的能力额外获得
   * 末源抑制窗口：sources.length > 2 且窗口内时先直达最后一个源，亲和源失败
   * 则清除窗口并回落到正常路由。
   */
  private async routeWithFallback<C extends MarketCapability, T>(
    policy: RoutePolicy<C, T>,
  ): Promise<T> {
    const cached = policy.readCache?.();
    if (cached !== undefined) return cached;

    const sources = this.registry.sources(policy.capability, policy.constraint);
    if (sources.length === 0) throw new Error(`unsupported_capability: ${policy.capability}`);

    const affinityKey = policy.affinityKey;
    const now = this.clock();
    if (
      affinityKey !== undefined &&
      sources.length > 2 &&
      this.inSuppressWindow(affinityKey, now)
    ) {
      const preferred = sources.at(-1);
      if (preferred !== undefined) {
        this.recordCall(preferred.source);
        try {
          await policy.rateLimiter.acquire();
          const value = policy.parse(await preferred.execute(policy.request), preferred.source);
          policy.onSuccess?.(value);
          return value;
        } catch (error) {
          this.recordFailure(preferred.source);
          this.finalFallbackAtByKey.delete(affinityKey);
          this.logger.warn(`${policy.logLabel} affinity source failed, restoring normal route`, {
            ...policy.logContext,
            source: preferred.source,
            error: errorMessage(error),
          });
        }
      }
    }

    let lastError: unknown;
    for (const [index, source] of sources.entries()) {
      this.recordCall(source.source);
      try {
        await policy.rateLimiter.acquire();
        const value = policy.parse(await source.execute(policy.request), source.source);
        policy.onSuccess?.(value);
        if (affinityKey !== undefined && index >= 2) {
          this.finalFallbackAtByKey.set(affinityKey, now.getTime());
        }
        return value;
      } catch (error) {
        this.recordFailure(source.source);
        lastError = error;
        this.logger.warn(`${policy.logLabel} source failed`, {
          ...policy.logContext,
          source: source.source,
          error: errorMessage(error),
        });
      }
    }
    throw policy.exhausted(lastError);
  }

  /** 拉单股快照（带缓存 + 限速 + fallback + 静默降级）。 */
  async fetchQuote(
    stockCode: string,
    options: { readonly requireDetails?: boolean } = {},
  ): Promise<Quote> {
    return this.routeWithFallback({
      capability: 'quote',
      request: { stockId: stockCode },
      readCache: () => {
        const cached = this.quoteCache.get(stockCode);
        if (cached !== undefined) {
          this.logger.debug('manager.fetchQuote cache hit', { stockCode });
        }
        if (
          options.requireDetails === true &&
          cached !== undefined &&
          cached.totalMarketCap === undefined &&
          cached.peTtm === undefined &&
          cached.pb === undefined
        ) {
          return undefined;
        }
        return cached;
      },
      parse: (raw) => QuoteSchema.parse(raw),
      onSuccess: (quote) => {
        this.quoteCache.set(quote);
      },
      rateLimiter: this.rateLimiter,
      logLabel: 'manager.fetchQuote',
      logContext: { stockCode },
      exhausted: (lastError) =>
        new Error(
          `all market sources failed for ${stockCode}: ${lastError === undefined ? 'unknown' : errorMessage(lastError)}`,
        ),
      affinityKey: `quote:${stockCode}`,
    });
  }

  async batchQuote(stockCodes: readonly string[]): Promise<Map<string, Quote>> {
    const result = new Map<string, Quote>();
    if (stockCodes.length === 0) return result;
    const toFetch: string[] = [];
    for (const code of stockCodes) {
      const cached = this.quoteCache.get(code);
      if (cached !== undefined) {
        result.set(code, cached);
      } else {
        toFetch.push(code);
      }
    }
    if (toFetch.length === 0) return result;

    // batch-quote 优先：一次请求取整批（源原生多代码快照）。返回中缺漏的标的不补拉，
    // 记 warn 后遗漏该只（对齐「单只失败只遗漏该只」的批量读语义）；批量路径全部失败
    // 或无任何 batch binding（如源组合只有 tushare）时，降级为有界逐股扇出兜底，
    // 不让批量读路径整体失败。
    try {
      const quotes = await this.routeWithFallback({
        capability: 'batch-quote',
        request: { stockIds: toFetch },
        parse: (raw) => raw.map((quote) => QuoteSchema.parse(quote)),
        onSuccess: (batch) => {
          for (const quote of batch) {
            this.quoteCache.set(quote);
          }
        },
        rateLimiter: this.rateLimiter,
        logLabel: 'manager.batchQuote',
        logContext: { stockCount: toFetch.length },
        exhausted: (lastError) => lastError,
      });
      const byId = new Map(quotes.map((quote) => [baseOf(quote.stockId), quote] as const));
      for (const code of toFetch) {
        const quote = byId.get(baseOf(code)) ?? byId.get(code);
        if (quote === undefined) {
          this.logger.warn('manager.batchQuote omitted missing quote', { stockCode: code });
        } else {
          result.set(code, quote);
        }
      }
      return result;
    } catch {
      // 批量路径不可用 → 逐股扇出兜底
    }

    // 有界逐股 fallback；单只全源失败只遗漏该只，不让批量读路径整体失败。
    // list_holdings / batch_quote 会分别用成本价或“缺失项”语义降级。
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(this.batchConcurrency, toFetch.length) }, async () => {
        while (cursor < toFetch.length) {
          const code = toFetch[cursor++];
          if (code === undefined) continue;
          try {
            result.set(code, await this.fetchQuote(code));
          } catch (error) {
            this.logger.warn('manager.batchQuote omitted failed quote', {
              stockCode: code,
              error: errorMessage(error),
            });
          }
        }
      }),
    );
    return result;
  }

  async fetchDailyBars(stockCode: string, range: DateRange): Promise<DailyBar[]> {
    return this.routeWithFallback({
      capability: 'daily-bars',
      request: { stockId: stockCode, range },
      readCache: () => {
        const cached = this.dailyBarCache.get(stockCode, range.start, range.end);
        return cached === undefined ? undefined : [...cached];
      },
      parse: (raw) => validateDailyBars(raw, range),
      onSuccess: (bars) => {
        this.dailyBarCache.set(stockCode, range.start, range.end, bars);
      },
      rateLimiter: this.rateLimiter,
      logLabel: 'manager.fetchDailyBars',
      logContext: { stockCode },
      exhausted: (lastError) =>
        new Error(
          `all market sources failed for daily bars ${stockCode}: ${lastError === undefined ? 'unknown' : errorMessage(lastError)}`,
        ),
      affinityKey: `daily-bars:${stockCode}:${range.start.getTime()}-${range.end.getTime()}:qfq`,
    });
  }

  /**
   * 外部股票搜索：按 Registry 中 search capability 的顺序路由。
   * 空数组是合法答案（该源确实没搜到），不触发降级；抛错才降级。
   * 不做缓存（搜索低频且 query 维度发散，LRU 命中率近似为零）。
   */
  async searchStocks(query: string): Promise<StockSearchCandidate[]> {
    return this.routeWithFallback({
      capability: 'search',
      request: { query },
      parse: (raw) => [...raw],
      rateLimiter: this.rateLimiter,
      logLabel: 'manager.searchStocks',
      logContext: { query },
      exhausted: (lastError) => lastError ?? new Error('all market sources failed for search'),
    });
  }

  /**
   * 全市场快照（分组刷新候选全集）：只路由显式注册 market-snapshot capability
   * 的来源。带 TTL 缓存：一轮
   * refresh-groups 内多个分组共享同一份快照。所有实现的源都失败时抛最后那个错误；
   * 没有任何源实现时抛错，由调用方降级本地股票库。
   */
  async fetchMarketSnapshot(): Promise<readonly MarketSnapshotItem[]> {
    return this.routeWithFallback({
      capability: 'market-snapshot',
      constraint: { coverage: 'CN_A_SHARES_SH_SZ' },
      request: { coverage: 'CN_A_SHARES_SH_SZ' },
      readCache: () => {
        const cached = this.marketSnapshotCache;
        if (cached !== undefined && this.clock().getTime() - cached.at < this.marketSnapshotTtlMs) {
          return cached.items;
        }
        return undefined;
      },
      parse: (items) => {
        if (items.length === 0) throw new Error('no_data: empty market snapshot');
        return items;
      },
      onSuccess: (items) => {
        this.marketSnapshotCache = { at: this.clock().getTime(), items };
      },
      rateLimiter: this.rateLimiter,
      logLabel: 'manager.fetchMarketSnapshot',
      logContext: {},
      exhausted: (lastError) =>
        lastError ?? new Error('all market sources failed for market-snapshot'),
    });
  }

  async fetchMarketSnapshotEnvelope(): Promise<MarketSnapshot> {
    return this.routeWithFallback({
      capability: 'market-snapshot-envelope',
      constraint: { coverage: 'CN_A_SHARES_SH_SZ' },
      request: { coverage: 'CN_A_SHARES_SH_SZ' },
      readCache: () => {
        const cached = this.marketSnapshotEnvelopeCache;
        if (cached !== undefined && this.clock().getTime() - cached.at < this.marketSnapshotTtlMs) {
          return cached.snapshot;
        }
        return undefined;
      },
      parse: (snapshot, source) => {
        assertMarketSnapshotInvariants(snapshot);
        if (!snapshot.completeness.complete) {
          throw new Error(
            `partial_data: ${source} market snapshot missing ${snapshot.completeness.missingCount} items`,
          );
        }
        return snapshot;
      },
      onSuccess: (snapshot) => {
        const at = this.clock().getTime();
        this.marketSnapshotEnvelopeCache = { at, snapshot };
        this.marketSnapshotCache = { at, items: snapshot.items };
      },
      rateLimiter: this.rateLimiter,
      logLabel: 'manager.fetchMarketSnapshotEnvelope',
      logContext: {},
      exhausted: (lastError) =>
        lastError ?? new Error('all market sources failed for market-snapshot-envelope'),
    });
  }

  /**
   * 大盘指数实时行情：只路由显式注册 realtime-index capability 的来源，
   * delayed-index 永远不会进入该路径（指数快照低频，不做缓存）。
   * 所有实现的源都失败时抛最后那个错误；没有任何源实现时明确抛错，
   * 由调用方（fetch_index_quotes tool）按错误模型转译。
   */
  async fetchIndexQuotes(): Promise<readonly IndexQuote[]> {
    return this.routeWithFallback({
      capability: 'realtime-index',
      constraint: { coverage: 'CN_A_SHARES_SH_SZ' },
      request: { coverage: 'CN_A_SHARES_SH_SZ' },
      parse: (indices) => {
        if (indices.length === 0) throw new Error('no_data: empty realtime index');
        return indices;
      },
      rateLimiter: this.rateLimiter,
      logLabel: 'manager.fetchIndexQuotes',
      logContext: {},
      exhausted: (lastError) =>
        lastError ?? new Error('all market sources failed for realtime-index'),
    });
  }

  /**
   * 当日分时分钟序列：只路由显式注册 intraday-minutes capability 的来源，
   * 无源抛 unsupported_capability，由调用方（fetch_intraday_minutes tool）合法降级。
   * 空序列（盘前 / 非交易日）是合法结果，不抛 no_data。
   * 30s TTL（per stockId）：行情页轮询最密 60s，TTL 内复用避免重复打源。
   */
  async fetchIntradayMinutes(stockId: string): Promise<readonly IntradayMinute[]> {
    return this.routeWithFallback({
      capability: 'intraday-minutes',
      request: { stockId },
      readCache: () => {
        const cached = this.intradayMinutesCache.get(stockId);
        if (cached !== undefined && this.clock().getTime() - cached.at < INTRADAY_MINUTES_TTL_MS) {
          return cached.points;
        }
        return undefined;
      },
      parse: (points) => points,
      onSuccess: (points) => {
        this.intradayMinutesCache.set(stockId, { at: this.clock().getTime(), points });
      },
      rateLimiter: this.rateLimiter,
      logLabel: 'manager.fetchIntradayMinutes',
      logContext: {},
      exhausted: (lastError) =>
        lastError ?? new Error('all market sources failed for intraday-minutes'),
    });
  }

  /**
   * 当前交易日原生分钟 OHLCV。15s TTL 只缓存非空有效结果；来源、周期和时间均由
   * MinuteBarSchema 在 adapter 边界校验，Manager 只负责显式 capability 路由与限速。
   */
  async fetchMinuteBars(
    stockId: string,
    interval: MinuteBarInterval,
  ): Promise<readonly MinuteBar[]> {
    const key = `${stockId}|${interval}`;
    return this.routeWithFallback({
      capability: 'minute-bars',
      request: { stockId, interval },
      readCache: () => {
        const cached = this.minuteBarsCache.get(key);
        if (cached !== undefined && this.clock().getTime() - cached.at < MINUTE_BARS_TTL_MS) {
          return cached.bars;
        }
        return undefined;
      },
      parse: (bars) => {
        if (bars.length === 0) throw new Error('no_data: empty minute bars');
        return bars;
      },
      onSuccess: (bars) => {
        this.minuteBarsCache.set(key, { at: this.clock().getTime(), bars });
      },
      rateLimiter: this.minuteBarRateLimiter,
      logLabel: 'manager.fetchMinuteBars',
      logContext: { stockId, interval },
      exhausted: (lastError) => lastError ?? new Error('all market sources failed for minute-bars'),
    });
  }

  marketSourceStatus(): readonly MarketSourceStatus[] {
    return this.registry.describe();
  }

  /**
   * 主动探测指定源的每个 capability（设置页「测试」按钮）：直接执行 registry handle，
   * 观测由 handle 自动记录（§4.3），不经过路由 / 缓存 / 限速。逐项顺序执行，
   * 单项失败不中断其余项；未绑定的能力标记 bound=false 不执行。
   */
  async probeSource(source: string): Promise<readonly MarketSourceProbe[]> {
    const now = this.clock();
    const requests: { [C in MarketCapability]: MarketCapabilityMap[C]['request'] } = {
      quote: { stockId: PROBE_STOCK_ID },
      'batch-quote': { stockIds: [PROBE_STOCK_ID] },
      'daily-bars': {
        stockId: PROBE_STOCK_ID,
        range: { start: new Date(now.getTime() - PROBE_DAILY_BARS_WINDOW_MS), end: now },
      },
      search: { query: PROBE_SEARCH_QUERY },
      'market-snapshot': { coverage: 'CN_A_SHARES_SH_SZ' },
      'market-snapshot-envelope': { coverage: 'CN_A_SHARES_SH_SZ' },
      'realtime-index': { coverage: 'CN_A_SHARES_SH_SZ' },
      'delayed-index': { coverage: 'CN_A_SHARES_SH_SZ', asOf: now },
      'intraday-minutes': { stockId: PROBE_STOCK_ID },
      'minute-bars': { stockId: PROBE_STOCK_ID, interval: '1m' },
    };
    const probes: MarketSourceProbe[] = [];
    for (const capability of Object.keys(requests) as MarketCapability[]) {
      const handle = this.registry.sources(capability).find((h) => h.source === source);
      if (handle === undefined) {
        probes.push({ capability, bound: false, ok: null });
        continue;
      }
      const startedAt = Date.now();
      try {
        // 循环里 capability 是联合类型，handle 与 request 的对应关系由上方 requests 表保证
        const execute = handle.execute as (input: unknown) => Promise<unknown>;
        await execute(requests[capability]);
        probes.push({ capability, bound: true, ok: true, durationMs: Date.now() - startedAt });
      } catch (error) {
        probes.push({
          capability,
          bound: true,
          ok: false,
          errorKind: sourceErrorKindOf(error),
          durationMs: Date.now() - startedAt,
        });
      }
    }
    return probes;
  }

  stats(): ManagerStats {
    return {
      sources: [...this.sourceCalls.entries()].map(([source, calls]) => ({
        source,
        calls,
        failures: this.sourceFailures.get(source) ?? 0,
      })),
      cache: {
        quote: this.quoteCache.stats(),
        dailyBar: this.dailyBarCache.stats(),
      },
    };
  }

  /** 重置所有计数器（测试用）。 */
  reset(): void {
    this.sourceCalls.clear();
    this.sourceFailures.clear();
    this.finalFallbackAtByKey.clear();
    this.marketSnapshotCache = undefined;
    this.marketSnapshotEnvelopeCache = undefined;
    this.quoteCache.clear();
    this.dailyBarCache.clear();
    this.intradayMinutesCache.clear();
    this.minuteBarsCache.clear();
    this.rateLimiter.reset();
    this.minuteBarRateLimiter.reset();
  }
}

const errorMessage = (e: unknown): string => {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
};
