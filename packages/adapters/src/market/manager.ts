import type {
  DailyBar,
  DateRange,
  IndexQuote,
  Logger,
  MarketSnapshotItem,
  Quote,
  StockSearchCandidate,
} from '@luoome/core';
import { DailyBarSchema, isHoliday, isWeekend, QuoteSchema } from '@luoome/core';

import { DailyBarCache, type LRUStats, QuoteCache } from './cache.js';
import type { MarketSourceRegistry, MarketSourceStatus } from './source-registry.js';
import type { MarketDataAdapter } from './types.js';

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
  readonly logger: Logger;
  readonly clock?: () => Date;
  /** 第三数据源抑制窗口（按股票 / 搜索 query 隔离）。默认 30 分钟。 */
  readonly finalFallbackSuppressMs?: number;
  /**
   * 全市场快照缓存 TTL。默认 5 分钟：refresh-groups 逐组刷新会在一轮运行内
   * 反复取候选全集，TTL 内复用同一份快照，避免每组都全量拉一遍。
   */
  readonly marketSnapshotTtlMs?: number;
}

export interface ManagerStats {
  readonly primaryCalls: number;
  readonly primaryFailures: number;
  readonly fallbackCalls: number;
  readonly fallbackFailures: number;
  readonly finalFallbackCalls: number;
  readonly cache: { readonly quote: LRUStats; readonly dailyBar: LRUStats };
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
 * 第三源抑制窗口是 per-key（股票 / 搜索 query）隔离的：某只股票主备失败启用第三源后，
 * 只有该股票在窗口内跳过主备源，不影响池内其它股票——避免一只港股 / 故障股熔断全池。
 */
export class MarketDataManager implements MarketDataAdapter {
  readonly name = 'manager';

  private readonly registry: MarketSourceRegistry;
  private readonly quoteCache: QuoteCache;
  private readonly dailyBarCache: DailyBarCache;
  private readonly rateLimiter: RateLimiter;
  private readonly logger: Logger;
  private readonly clock: () => Date;
  private readonly suppressMs: number;
  private readonly marketSnapshotTtlMs: number;
  /** 全市场快照 TTL 缓存（单 key：全市场只有一份）。 */
  private marketSnapshotCache:
    | { readonly at: number; readonly items: readonly MarketSnapshotItem[] }
    | undefined;

  private primaryCalls = 0;
  private primaryFailures = 0;
  private fallbackCalls = 0;
  private fallbackFailures = 0;
  private finalFallbackCalls = 0;
  /** 各 key（股票代码 / 搜索 query）最近一次启用第三源的时间；窗口是 per-key 隔离的。 */
  private readonly finalFallbackAtByKey = new Map<string, number>();

  constructor(options: MarketDataManagerOptions) {
    this.clock = options.clock ?? ((): Date => new Date());
    this.registry = options.registry;
    this.quoteCache = options.quoteCache ?? new QuoteCache(1024, 60_000, this.clock);
    this.dailyBarCache = options.dailyBarCache ?? new DailyBarCache(512, 3_600_000, this.clock);
    this.rateLimiter = new RateLimiter(options.rateLimitPerSec ?? 10);
    this.logger = options.logger;
    this.suppressMs = options.finalFallbackSuppressMs ?? 30 * 60 * 1000;
    this.marketSnapshotTtlMs = options.marketSnapshotTtlMs ?? 5 * 60 * 1000;
  }

  /** 该 key 是否处于第三源抑制窗口内（窗口内跳过主备源，直达第三源）。 */
  private inSuppressWindow(key: string, now: Date): boolean {
    const at = this.finalFallbackAtByKey.get(key);
    return at !== undefined && now.getTime() - at < this.suppressMs;
  }

  /** 拉单股快照（带缓存 + 限速 + fallback + 静默降级）。 */
  async fetchQuote(stockCode: string): Promise<Quote> {
    const cached = this.quoteCache.get(stockCode);
    if (cached !== undefined) {
      this.logger.debug('manager.fetchQuote cache hit', { stockCode });
      return cached;
    }

    const sources = this.registry.sources('quote');
    if (sources.length === 0) throw new Error('unsupported_capability: quote');
    const affinityKey = `quote:${stockCode}`;
    const now = this.clock();
    const preferred = this.inSuppressWindow(affinityKey, now) ? sources.at(-1) : undefined;
    if (preferred !== undefined && sources.length > 2) {
      try {
        await this.rateLimiter.acquire();
        const quote = QuoteSchema.parse(await preferred.execute({ stockId: stockCode }));
        this.quoteCache.set(quote);
        this.finalFallbackCalls += 1;
        return quote;
      } catch (error) {
        this.finalFallbackAtByKey.delete(affinityKey);
        this.logger.warn('manager.fetchQuote affinity source failed, restoring normal route', {
          stockCode,
          source: preferred.source,
          error: errorMessage(error),
        });
      }
    }

    let lastError: unknown;
    for (const [index, source] of sources.entries()) {
      try {
        if (index === 0) this.primaryCalls += 1;
        else if (index === 1) this.fallbackCalls += 1;
        await this.rateLimiter.acquire();
        const quote = QuoteSchema.parse(await source.execute({ stockId: stockCode }));
        this.quoteCache.set(quote);
        if (index >= 2) {
          this.finalFallbackCalls += 1;
          this.finalFallbackAtByKey.set(affinityKey, now.getTime());
        }
        return quote;
      } catch (error) {
        if (index === 0) this.primaryFailures += 1;
        else if (index === 1) this.fallbackFailures += 1;
        lastError = error;
        this.logger.warn('manager.fetchQuote source failed', {
          stockCode,
          source: source.source,
          error: errorMessage(error),
        });
      }
    }
    throw new Error(
      `all market sources failed for ${stockCode}: ${lastError === undefined ? 'unknown' : errorMessage(lastError)}`,
    );
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
    // 并发 fetchQuote；单只全源失败只遗漏该只，不让批量读路径整体失败。
    // list_holdings / batch_quote 会分别用成本价或“缺失项”语义降级。
    await Promise.all(
      toFetch.map(async (code) => {
        try {
          result.set(code, await this.fetchQuote(code));
        } catch (error) {
          this.logger.warn('manager.batchQuote omitted failed quote', {
            stockCode: code,
            error: errorMessage(error),
          });
        }
      }),
    );
    return result;
  }

  async fetchDailyBars(stockCode: string, range: DateRange): Promise<DailyBar[]> {
    const cached = this.dailyBarCache.get(stockCode, range.start, range.end);
    if (cached !== undefined) return [...cached];

    const sources = this.registry.sources('daily-bars');
    if (sources.length === 0) throw new Error('unsupported_capability: daily-bars');
    const affinityKey = `daily-bars:${stockCode}:${range.start.getTime()}-${range.end.getTime()}:qfq`;
    const now = this.clock();
    const preferred = this.inSuppressWindow(affinityKey, now) ? sources.at(-1) : undefined;
    if (preferred !== undefined && sources.length > 2) {
      try {
        const bars = validateDailyBars(
          await preferred.execute({ stockId: stockCode, range }),
          range,
        );
        this.dailyBarCache.set(stockCode, range.start, range.end, bars);
        this.finalFallbackCalls += 1;
        return bars;
      } catch (error) {
        this.finalFallbackAtByKey.delete(affinityKey);
        this.logger.warn('manager.fetchDailyBars affinity source failed, restoring normal route', {
          stockCode,
          source: preferred.source,
          error: errorMessage(error),
        });
      }
    }

    let lastError: unknown;
    for (const [index, source] of sources.entries()) {
      try {
        await this.rateLimiter.acquire();
        const bars = validateDailyBars(await source.execute({ stockId: stockCode, range }), range);
        this.dailyBarCache.set(stockCode, range.start, range.end, bars);
        if (index >= 2) {
          this.finalFallbackCalls += 1;
          this.finalFallbackAtByKey.set(affinityKey, now.getTime());
        }
        return bars;
      } catch (error) {
        lastError = error;
        this.logger.warn('manager.fetchDailyBars source failed', {
          stockCode,
          source: source.source,
          error: errorMessage(error),
        });
      }
    }
    throw new Error(
      `all market sources failed for daily bars ${stockCode}: ${lastError === undefined ? 'unknown' : errorMessage(lastError)}`,
    );
  }

  /**
   * 外部股票搜索：按 Registry 中 search capability 的顺序路由。
   * 空数组是合法答案（该源确实没搜到），不触发降级；抛错才降级。
   * 不做缓存（搜索低频且 query 维度发散，LRU 命中率近似为零）。
   */
  async searchStocks(query: string): Promise<StockSearchCandidate[]> {
    const sources = this.registry.sources('search');
    if (sources.length === 0) throw new Error('unsupported_capability: search');
    let lastError: unknown;
    for (const [index, source] of sources.entries()) {
      try {
        await this.rateLimiter.acquire();
        const result = [...(await source.execute({ query }))];
        if (index >= 2) this.finalFallbackCalls += 1;
        return result;
      } catch (error) {
        this.logger.warn('manager.searchStocks source failed', {
          query,
          sourceName: source.source,
          error: errorMessage(error),
        });
        lastError = error;
      }
    }
    throw lastError ?? new Error('all market sources failed for search');
  }

  /**
   * 全市场快照（分组刷新候选全集）：只路由显式注册 market-snapshot capability
   * 的来源。带 TTL 缓存：一轮
   * refresh-groups 内多个分组共享同一份快照。所有实现的源都失败时抛最后那个错误；
   * 没有任何源实现时抛错，由调用方降级本地股票库。
   */
  async fetchMarketSnapshot(): Promise<readonly MarketSnapshotItem[]> {
    const now = this.clock();
    if (
      this.marketSnapshotCache !== undefined &&
      now.getTime() - this.marketSnapshotCache.at < this.marketSnapshotTtlMs
    ) {
      return this.marketSnapshotCache.items;
    }
    const sources = this.registry.sources('market-snapshot', {
      coverage: 'CN_A_SHARES_SH_SZ',
    });
    if (sources.length === 0) throw new Error('unsupported_capability: market-snapshot');
    let lastError: unknown;
    for (const [index, source] of sources.entries()) {
      try {
        await this.rateLimiter.acquire();
        const items = await source.execute({ coverage: 'CN_A_SHARES_SH_SZ' });
        if (items.length === 0) throw new Error('no_data: empty market snapshot');
        this.marketSnapshotCache = { at: now.getTime(), items };
        if (index >= 2) this.finalFallbackCalls += 1;
        return items;
      } catch (error) {
        this.logger.warn('manager.fetchMarketSnapshot source failed', {
          sourceName: source.source,
          error: errorMessage(error),
        });
        lastError = error;
      }
    }
    throw lastError ?? new Error('all market sources failed for market-snapshot');
  }

  /**
   * 大盘指数实时行情：只路由显式注册 realtime-index capability 的来源，
   * delayed-index 永远不会进入该路径（指数快照低频，不做缓存）。
   * 所有实现的源都失败时抛最后那个错误；没有任何源实现时明确抛错，
   * 由调用方（fetch_index_quotes tool）按错误模型转译。
   */
  async fetchIndexQuotes(): Promise<readonly IndexQuote[]> {
    const sources = this.registry.sources('realtime-index', {
      coverage: 'CN_A_SHARES_SH_SZ',
    });
    if (sources.length === 0) throw new Error('unsupported_capability: realtime-index');
    let lastError: unknown;
    for (const source of sources) {
      try {
        await this.rateLimiter.acquire();
        const indices = await source.execute({ coverage: 'CN_A_SHARES_SH_SZ' });
        if (indices.length === 0) throw new Error('no_data: empty realtime index');
        return indices;
      } catch (error) {
        this.logger.warn('manager.fetchIndexQuotes source failed', {
          sourceName: source.source,
          error: errorMessage(error),
        });
        lastError = error;
      }
    }
    throw lastError ?? new Error('all market sources failed for realtime-index');
  }

  marketSourceStatus(): readonly MarketSourceStatus[] {
    return this.registry.describe();
  }

  stats(): ManagerStats {
    return {
      primaryCalls: this.primaryCalls,
      primaryFailures: this.primaryFailures,
      fallbackCalls: this.fallbackCalls,
      fallbackFailures: this.fallbackFailures,
      finalFallbackCalls: this.finalFallbackCalls,
      cache: {
        quote: this.quoteCache.stats(),
        dailyBar: this.dailyBarCache.stats(),
      },
    };
  }

  /** 重置所有计数器（测试用）。 */
  reset(): void {
    this.primaryCalls = 0;
    this.primaryFailures = 0;
    this.fallbackCalls = 0;
    this.fallbackFailures = 0;
    this.finalFallbackCalls = 0;
    this.finalFallbackAtByKey.clear();
    this.marketSnapshotCache = undefined;
    this.quoteCache.clear();
    this.dailyBarCache.clear();
    this.rateLimiter.reset();
  }
}

const errorMessage = (e: unknown): string => {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
};
