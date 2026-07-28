import type {
  DailyBar,
  DateRange,
  IndexQuote,
  Logger,
  MarketSnapshotItem,
  Quote,
  StockSearchCandidate,
} from '@luoome/core';

import { DailyBarCache, type LRUStats, QuoteCache } from './cache.js';
import type { MarketDataAdapter } from './types.js';

/**
 * 行情适配器类型（structural typing，Manager 只关心 fetchQuote / batchQuote / fetchDailyBars）。
 * 允许 EastmoneyAdapter / TencentAdapter 或测试替身实现接入。
 */
type QuoteAdapter = {
  readonly name: string;
  fetchQuote(stockCode: string): Promise<Quote>;
  batchQuote(stockCodes: readonly string[]): Promise<Map<string, Quote>>;
  fetchDailyBars(stockCode: string, range: DateRange): Promise<DailyBar[]>;
  /** 外部股票搜索（v0.8 起，可选；未实现的源在 searchStocks 路由时跳过）。 */
  searchStocks?(query: string): Promise<StockSearchCandidate[]>;
  /** 大盘指数行情（可选；未实现的源在 fetchIndexQuotes 路由时跳过）。 */
  fetchIndexQuotes?(): Promise<readonly IndexQuote[]>;
  /** 全市场快照（可选；未实现的源在 fetchMarketSnapshot 路由时跳过）。 */
  fetchMarketSnapshot?(): Promise<readonly MarketSnapshotItem[]>;
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
  readonly primary: QuoteAdapter;
  readonly fallback: QuoteAdapter;
  /** 可选第三真实数据源；生产默认不配置。 */
  readonly finalFallback?: QuoteAdapter;
  /**
   * 指数行情专用兜底源（可选）：仅 fetchIndexQuotes 路由使用，
   * 不参与 fetchQuote / batchQuote / fetchDailyBars / searchStocks 路由。
   */
  readonly indexFallback?: QuoteAdapter;
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
  readonly indexFallbackCalls: number;
  readonly cache: { readonly quote: LRUStats; readonly dailyBar: LRUStats };
}

/**
 * MarketDataManager（v0.2 起，adapter 编排层）。
 *
 * 工作流（fetchQuote 为例）：
 * 1. 查 QuoteCache；命中即返回
 * 2. 未命中 → rate limiter acquire
 * 3. 调 primary.fetchQuote；成功写缓存 + 返回
 * 4. primary 失败 → logger.warn → 调 fallback.fetchQuote；成功写缓存 + 返回
 * 5. fallback 也失败：有第三真实数据源则尝试；否则明确抛错。
 *
 * 第三源抑制窗口是 per-key（股票 / 搜索 query）隔离的：某只股票主备失败启用第三源后，
 * 只有该股票在窗口内跳过主备源，不影响池内其它股票——避免一只港股 / 故障股熔断全池。
 */
export class MarketDataManager implements MarketDataAdapter {
  readonly name = 'manager';

  private readonly primary: QuoteAdapter;
  private readonly fallback: QuoteAdapter;
  private readonly finalFallback: QuoteAdapter | undefined;
  private readonly indexFallback: QuoteAdapter | undefined;
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
  private indexFallbackCalls = 0;
  /** 各 key（股票代码 / 搜索 query）最近一次启用第三源的时间；窗口是 per-key 隔离的。 */
  private readonly finalFallbackAtByKey = new Map<string, number>();

  constructor(options: MarketDataManagerOptions) {
    this.primary = options.primary;
    this.fallback = options.fallback;
    this.finalFallback = options.finalFallback;
    this.indexFallback = options.indexFallback;
    this.quoteCache = options.quoteCache ?? new QuoteCache();
    this.dailyBarCache = options.dailyBarCache ?? new DailyBarCache();
    this.rateLimiter = new RateLimiter(options.rateLimitPerSec ?? 10);
    this.logger = options.logger;
    this.clock = options.clock ?? ((): Date => new Date());
    this.suppressMs = options.finalFallbackSuppressMs ?? 30 * 60 * 1000;
    this.marketSnapshotTtlMs = options.marketSnapshotTtlMs ?? 5 * 60 * 1000;
  }

  /** 该 key 是否处于第三源抑制窗口内（窗口内跳过主备源，直达第三源）。 */
  private inSuppressWindow(key: string, now: Date): boolean {
    const at = this.finalFallbackAtByKey.get(key);
    return at !== undefined && now.getTime() - at < this.suppressMs;
  }

  /** 记录一次第三源启用并刷新该 key 的抑制窗口；日志区分「真实失败」与「窗口内跳过」。 */
  private noteFinalFallback(key: string, now: Date, what: string): void {
    this.finalFallbackCalls += 1;
    const wasSuppressed = this.inSuppressWindow(key, now);
    this.finalFallbackAtByKey.set(key, now.getTime());
    if (wasSuppressed) {
      this.logger.warn(`manager.${what} 抑制窗口内跳过主备源，直接使用第三源`, { key });
    } else {
      this.logger.error(`manager.${what} primary and fallback failed, using final source`, {
        key,
      });
    }
  }

  /** 拉单股快照（带缓存 + 限速 + fallback + 静默降级）。 */
  async fetchQuote(stockCode: string): Promise<Quote> {
    const cached = this.quoteCache.get(stockCode);
    if (cached !== undefined) {
      this.logger.debug('manager.fetchQuote cache hit', { stockCode });
      return cached;
    }

    const now = this.clock();
    const inSuppress = this.inSuppressWindow(stockCode, now);

    // 主源
    if (!inSuppress) {
      this.primaryCalls += 1;
      try {
        await this.rateLimiter.acquire();
        const quote = await this.primary.fetchQuote(stockCode);
        this.quoteCache.set(quote);
        this.logger.debug('manager.fetchQuote primary ok', { stockCode, source: quote.source });
        return quote;
      } catch (error) {
        this.primaryFailures += 1;
        this.logger.warn('manager.fetchQuote primary failed', {
          stockCode,
          error: errorMessage(error),
          primaryName: this.primary.name,
        });
      }
    }

    // fallback
    if (!inSuppress) {
      this.fallbackCalls += 1;
      try {
        await this.rateLimiter.acquire();
        const quote = await this.fallback.fetchQuote(stockCode);
        this.quoteCache.set(quote);
        this.logger.warn('manager.fetchQuote primary failed, fallback ok', {
          stockCode,
          source: quote.source,
        });
        return quote;
      } catch (error) {
        this.fallbackFailures += 1;
        this.logger.warn('manager.fetchQuote fallback failed', {
          stockCode,
          error: errorMessage(error),
          fallbackName: this.fallback.name,
        });
      }
    }

    if (this.finalFallback === undefined) {
      throw new Error(`all market sources failed for ${stockCode}`);
    }

    // 可选第三真实数据源：结果写缓存，避免抑制窗口内反复请求。
    this.noteFinalFallback(stockCode, now, 'fetchQuote');
    const quote = await this.finalFallback.fetchQuote(stockCode);
    this.quoteCache.set(quote);
    return quote;
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

    const now = this.clock();
    const inSuppress = this.inSuppressWindow(stockCode, now);

    if (!inSuppress) {
      try {
        await this.rateLimiter.acquire();
        const bars = await this.primary.fetchDailyBars(stockCode, range);
        this.dailyBarCache.set(stockCode, range.start, range.end, bars);
        return bars;
      } catch (error) {
        this.logger.warn('manager.fetchDailyBars primary failed', {
          stockCode,
          error: errorMessage(error),
        });
      }
      try {
        await this.rateLimiter.acquire();
        const bars = await this.fallback.fetchDailyBars(stockCode, range);
        this.dailyBarCache.set(stockCode, range.start, range.end, bars);
        this.logger.warn('manager.fetchDailyBars primary failed, fallback ok', { stockCode });
        return bars;
      } catch (error) {
        this.logger.warn('manager.fetchDailyBars fallback failed', {
          stockCode,
          error: errorMessage(error),
        });
      }
    }

    if (this.finalFallback === undefined) {
      throw new Error(`all market sources failed for daily bars: ${stockCode}`);
    }
    this.noteFinalFallback(stockCode, now, 'fetchDailyBars');
    return await this.finalFallback.fetchDailyBars(stockCode, range);
  }

  /**
   * 外部股票搜索（v0.8 起）：primary → fallback → 可选第三真实数据源。
   * 空数组是合法答案（该源确实没搜到），不触发降级；抛错才降级。
   * 不做缓存（搜索低频且 query 维度发散，LRU 命中率近似为零）。
   */
  async searchStocks(query: string): Promise<StockSearchCandidate[]> {
    const now = this.clock();
    const inSuppress = this.inSuppressWindow(query, now);
    let lastError: unknown;
    if (!inSuppress) {
      for (const source of [this.primary, this.fallback]) {
        if (typeof source.searchStocks !== 'function') continue;
        try {
          await this.rateLimiter.acquire();
          return await source.searchStocks(query);
        } catch (error) {
          this.logger.warn('manager.searchStocks source failed', {
            query,
            sourceName: source.name,
            error: errorMessage(error),
          });
          lastError = error;
        }
      }
    }
    if (typeof this.finalFallback?.searchStocks === 'function') {
      this.noteFinalFallback(query, now, 'searchStocks');
      return this.finalFallback.searchStocks(query);
    }
    if (lastError !== undefined) {
      throw lastError;
    }
    return [];
  }

  /**
   * 全市场快照（分组刷新候选全集）：primary → fallback → 可选第三真实数据源，
   * 跳过未实现该方法的源（路由规则同 searchStocks）。带 TTL 缓存：一轮
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
    let lastError: unknown;
    for (const source of [this.primary, this.fallback]) {
      if (typeof source.fetchMarketSnapshot !== 'function') continue;
      try {
        await this.rateLimiter.acquire();
        const items = await source.fetchMarketSnapshot();
        this.marketSnapshotCache = { at: now.getTime(), items };
        return items;
      } catch (error) {
        this.logger.warn('manager.fetchMarketSnapshot source failed', {
          sourceName: source.name,
          error: errorMessage(error),
        });
        lastError = error;
      }
    }
    if (typeof this.finalFallback?.fetchMarketSnapshot === 'function') {
      this.noteFinalFallback('__market_snapshot__', now, 'fetchMarketSnapshot');
      const items = await this.finalFallback.fetchMarketSnapshot();
      this.marketSnapshotCache = { at: now.getTime(), items };
      return items;
    }
    if (lastError !== undefined) {
      throw lastError;
    }
    throw new Error('no market data source supports fetchMarketSnapshot');
  }

  /**
   * 大盘指数实时行情：primary → fallback → 可选第三真实数据源，
   * 跳过未实现该方法的源（路由规则同 searchStocks；指数快照低频，不做缓存）。
   * 所有实现的源都失败时抛最后那个错误；没有任何源实现时明确抛错，
   * 由调用方（fetch_index_quotes tool）按错误模型转译。
   */
  async fetchIndexQuotes(): Promise<readonly IndexQuote[]> {
    let lastError: unknown;
    for (const source of [this.primary, this.fallback]) {
      if (typeof source.fetchIndexQuotes !== 'function') continue;
      try {
        await this.rateLimiter.acquire();
        return await source.fetchIndexQuotes();
      } catch (error) {
        this.logger.warn('manager.fetchIndexQuotes source failed', {
          sourceName: source.name,
          error: errorMessage(error),
        });
        lastError = error;
      }
    }
    if (typeof this.finalFallback?.fetchIndexQuotes === 'function') {
      this.noteFinalFallback('__indices__', this.clock(), 'fetchIndexQuotes');
      return this.finalFallback.fetchIndexQuotes();
    }
    // 指数专用兜底源：链路全失败 / 未实现后才启用；它自己失败时直接抛它的错误。
    if (typeof this.indexFallback?.fetchIndexQuotes === 'function') {
      this.indexFallbackCalls += 1;
      try {
        await this.rateLimiter.acquire();
        const indices = await this.indexFallback.fetchIndexQuotes();
        this.logger.warn('manager.fetchIndexQuotes chain failed, indexFallback ok', {
          sourceName: this.indexFallback.name,
        });
        return indices;
      } catch (error) {
        this.logger.warn('manager.fetchIndexQuotes indexFallback failed', {
          sourceName: this.indexFallback.name,
          error: errorMessage(error),
        });
        throw error;
      }
    }
    if (lastError !== undefined) {
      throw lastError;
    }
    // 走到这里说明没有任何源实现该方法（每个实现的源要么已返回、要么置了 lastError）。
    throw new Error('no market data source supports fetchIndexQuotes');
  }

  stats(): ManagerStats {
    return {
      primaryCalls: this.primaryCalls,
      primaryFailures: this.primaryFailures,
      fallbackCalls: this.fallbackCalls,
      fallbackFailures: this.fallbackFailures,
      finalFallbackCalls: this.finalFallbackCalls,
      indexFallbackCalls: this.indexFallbackCalls,
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
    this.indexFallbackCalls = 0;
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

// QuoteCache / DailyBarCache 已在上方 import 时引入；MarketDataAdapter 类型已在
// class implements 时满足。其它（EastmoneyAdapter / TencentAdapter）由 consumer
// 直接从各自模块 import，不在此 re-export，避免循环。
