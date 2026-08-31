import type {
  DailyBar,
  DateRange,
  IndexQuote,
  IntradayMinute,
  Logger,
  MarketSnapshot,
  MarketSnapshotItem,
  MinuteBar,
  MinuteBarInterval,
  Quote,
  StockSearchCandidate,
} from '@luoome/core';
import { assertMarketSnapshotInvariants, MarketSnapshotSchema, money } from '@luoome/core';
import { ZodError, z } from 'zod';

import {
  invalidPayloadError,
  noDataError,
  SourceExecutionError,
  sourceErrorKindOf,
  unsupportedCapabilityError,
  unsupportedMarketError,
  upstreamError,
} from '../source-error.js';
import { FuyaoClient, type FuyaoConfig } from './client.js';

/**
 * fuyao（同花顺金融数据 API）行情源（MarketDataManager 的第四个真实源）。
 * 设计：docs/ddd/fuyao-market-adapter-design.md。
 *
 * 要点：
 * - 只覆盖 SH / SZ A 股；6 位代码归一为 XXXXXX.SH|SZ，.BJ/.TI/.OF 或无法判定
 *   抛 unsupported_market（manager 视作一次失败走降级）。
 * - 快照 / 日 K / 检索 / 全市场分页 / 指数快照均走 REST 信封（HTTP 恒 200，
 *   code 分发见 envelope.ts）；volume 已是股、百分数为原值，不做单位换算。
 * - 日 K 固定 adjust=forward → adjustment='qfq'；窗口超 10 年在请求前抛参数错误
 *   （对齐上游 1003 → upstream_error 归类）。
 * - 无分钟线端点：fetchIntradayMinutes / fetchMinuteBars 抛 unsupported_capability，
 *   不用日 K 冒充；指数快照只绑 delayed-index（indexQuoteMode='delayed'）。
 */

export interface FuyaoSourceOptions {
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
  readonly logger: Logger;
  /** 由 assembly factory 从 FUYAO_* 解析后注入；adapter 不读 process.env。 */
  readonly config: FuyaoConfig;
}

const SnapshotItemSchema = z.object({
  thscode: z.string().min(1),
  ticker: z.string().nullish(),
  // 全市场分页模式含停牌标的，last_price 可能为 null（2026-08-22 实盘验证）。
  last_price: z.number().nullish(),
  price_change: z.number().nullish(),
  price_change_ratio_pct: z.number().nullish(),
  open_price: z.number().nullish(),
  high_price: z.number().nullish(),
  low_price: z.number().nullish(),
  prev_price: z.number().nullish(),
  volume: z.number().nullish(),
  turnover: z.number().nullish(),
});

const HistoricalItemSchema = z.object({
  date_ms: z.number(),
  open_price: z.number(),
  high_price: z.number(),
  low_price: z.number(),
  close_price: z.number(),
  volume: z.number().nullish(),
  turnover: z.number().nullish(),
});

const TickerItemSchema = z.object({
  thscode: z.string().min(1),
  ticker: z.string().min(1),
  name: z.string().min(1),
  exchange: z.string().nullish(),
  asset_type: z.string().nullish(),
});

/** 历史窗口上限 10 年（上游超窗返回 1003；adapter 请求前拦截，口径一致）。 */
const MAX_HISTORY_WINDOW_MS = 10 * 365 * 86_400_000;

const MARKET_SNAPSHOT_PAGE_SIZE = 100;

/**
 * 主要大盘指数清单（对齐 eastmoney MAJOR_INDICES 的沪深部分；指数快照不返回名称，
 * 用 thscode → 中文名常量映射）。恒生指数不在 fuyao A 股覆盖范围内，不含。
 */
const MAJOR_INDICES: ReadonlyArray<{ readonly thscode: string; readonly name: string }> = [
  { thscode: '000001.SH', name: '上证指数' },
  { thscode: '399001.SZ', name: '深证成指' },
  { thscode: '399006.SZ', name: '创业板指' },
  { thscode: '000300.SH', name: '沪深300' },
  { thscode: '000688.SH', name: '科创50' },
];

/**
 * 代码归一（§5.2）：6 位数字按号段补 .SH/.SZ；已带后缀原样 trim + toUpperCase；
 * .BJ/.TI/.OF 或无法判定市场的输入抛 unsupported_market。
 */
export const normalizeFuyaoThscode = (stockCode: string): string => {
  const input = stockCode.trim().toUpperCase();
  const suffixed = /^(\d{6})\.([A-Z]{2})$/.exec(input);
  if (suffixed !== null) {
    const [, digits, suffix] = suffixed;
    if (suffix === 'SH' || suffix === 'SZ') return `${digits}.${suffix}`;
    throw unsupportedMarketError(`unsupported_market: ${stockCode}`);
  }
  if (/^\d{6}$/.test(input)) {
    if (/^(60|68|9)/.test(input)) return `${input}.SH`;
    if (/^(00|30|20)/.test(input)) return `${input}.SZ`;
  }
  throw unsupportedMarketError(`unsupported_market: ${stockCode}`);
};

/** date_ms（Asia/Shanghai 交易日零点毫秒戳）→ 该交易日 UTC 00:00（与 DailyBar.date 同约定）。 */
const msToTradingDate = (ms: number): Date => {
  const shifted = new Date(ms + 8 * 3_600_000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
};

export class FuyaoSource {
  readonly name = 'fuyao';
  readonly indexQuoteMode = 'delayed' as const;

  private readonly clock: () => Date;
  private readonly logger: Logger;
  private readonly client: FuyaoClient;

  constructor(options: FuyaoSourceOptions) {
    this.clock = options.clock ?? ((): Date => new Date());
    this.logger = options.logger;
    this.client = new FuyaoClient(options.config, {
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  }

  async fetchQuote(stockCode: string): Promise<Quote> {
    const thscode = normalizeFuyaoThscode(stockCode);
    try {
      const { timestamp, items } = await this.client.get('/api/a-share/prices/snapshot', {
        thscodes: thscode,
      });
      const row = items[0];
      if (row === undefined) {
        throw noDataError(`fuyao no_data: ${thscode} 快照为空`);
      }
      const quote = this.toQuote(thscode, row, timestamp);
      if (quote === undefined) {
        throw noDataError(`fuyao no_data: ${thscode} 快照价格缺失或为 0（盘前或停牌）`);
      }
      this.logger.info('fuyao.fetchQuote ok', { stockCode: thscode, source: 'fuyao' });
      return quote;
    } catch (error) {
      const translated = translateFuyaoError(error);
      this.logger.warn('fuyao.fetchQuote failed', {
        stockCode: thscode,
        kind: kindOf(translated),
        error: translated.message,
      });
      throw translated;
    }
  }

  /**
   * 单次快照请求取整批（thscodes 逗号分隔，服务端按入参顺序返回）；
   * 无法归一 / 上游未返回 / 行非法的标的只丢弃该只（部分失败语义），不伪造占位项。
   */
  async batchQuote(stockCodes: readonly string[]): Promise<Map<string, Quote>> {
    const out = new Map<string, Quote>();
    for (const { input, quote } of await this.fetchSnapshotBatch(stockCodes)) {
      out.set(input, quote);
    }
    return out;
  }

  /** batch-quote capability 入口：同一批量快照路径，只返回 Quote 数组（缺漏不占位）。 */
  async fetchBatchQuotes(stockIds: readonly string[]): Promise<Quote[]> {
    return (await this.fetchSnapshotBatch(stockIds)).map(({ quote }) => quote);
  }

  /** 批量快照共享路径：一次 HTTP 请求取整批，返回 (入参原样代码, Quote) 对。 */
  private async fetchSnapshotBatch(
    stockCodes: readonly string[],
  ): Promise<Array<{ readonly input: string; readonly quote: Quote }>> {
    const pairs: Array<{ readonly input: string; readonly thscode: string }> = [];
    for (const code of stockCodes) {
      try {
        pairs.push({ input: code, thscode: normalizeFuyaoThscode(code) });
      } catch (error) {
        this.logger.warn('fuyao.batchQuote omitted', { code, error: errorMessage(error) });
      }
    }
    if (pairs.length === 0) return [];
    try {
      const { timestamp, items } = await this.client.get('/api/a-share/prices/snapshot', {
        thscodes: pairs.map((pair) => pair.thscode).join(','),
      });
      const byThscode = new Map<string, Record<string, unknown>>();
      for (const item of items) {
        if (typeof item.thscode === 'string') byThscode.set(item.thscode.toUpperCase(), item);
      }
      const out: Array<{ readonly input: string; readonly quote: Quote }> = [];
      for (const { input, thscode } of pairs) {
        const row = byThscode.get(thscode);
        if (row === undefined) continue;
        try {
          const quote = this.toQuote(thscode, row, timestamp);
          if (quote !== undefined) out.push({ input, quote });
        } catch (error) {
          this.logger.warn('fuyao.batchQuote omitted', {
            code: input,
            error: errorMessage(error),
          });
        }
      }
      return out;
    } catch (error) {
      const translated = translateFuyaoError(error);
      this.logger.warn('fuyao.batchQuote failed', {
        kind: kindOf(translated),
        error: translated.message,
      });
      throw translated;
    }
  }

  /**
   * 单标的日 K：interval=1d 固定、adjust=forward 固定（前复权对齐 adjustment='qfq'）；
   * start/end 为毫秒戳。窗口超 10 年在请求前抛参数错误（对齐上游 1003 归类），
   * 不静默截断语义。sourceAdjFactor 响应不含因子，留 undefined。
   */
  async fetchDailyBars(stockCode: string, range: DateRange): Promise<DailyBar[]> {
    const thscode = normalizeFuyaoThscode(stockCode);
    if (range.end.getTime() - range.start.getTime() > MAX_HISTORY_WINDOW_MS) {
      throw upstreamError(`fuyao invalid_params: 历史窗口超过 10 年（${thscode}）`);
    }
    try {
      const { items } = await this.client.get('/api/a-share/prices/historical', {
        thscode,
        interval: '1d',
        start: range.start.getTime(),
        end: range.end.getTime(),
        adjust: 'forward',
      });
      const seen = new Set<number>();
      const bars: DailyBar[] = [];
      for (const row of items) {
        const parsed = HistoricalItemSchema.parse(row);
        if (seen.has(parsed.date_ms)) continue;
        if (
          parsed.open_price <= 0 ||
          parsed.high_price <= 0 ||
          parsed.low_price <= 0 ||
          parsed.close_price <= 0
        ) {
          continue;
        }
        seen.add(parsed.date_ms);
        bars.push({
          stockId: thscode,
          date: msToTradingDate(parsed.date_ms),
          open: money(parsed.open_price),
          high: money(parsed.high_price),
          low: money(parsed.low_price),
          close: money(parsed.close_price),
          volume: parsed.volume ?? 0,
          adjustment: 'qfq',
          source: 'fuyao',
        });
      }
      const result = bars
        .filter((bar) => bar.date >= range.start && bar.date <= range.end)
        .sort((left, right) => left.date.getTime() - right.date.getTime());
      this.logger.info('fuyao.fetchDailyBars ok', {
        stockCode: thscode,
        source: 'fuyao',
        count: result.length,
      });
      return result;
    } catch (error) {
      const translated = translateFuyaoError(error);
      this.logger.warn('fuyao.fetchDailyBars failed', {
        stockCode: thscode,
        kind: kindOf(translated),
        error: translated.message,
      });
      throw translated;
    }
  }

  /** 名称 / 代码消歧检索；空结果返回空数组（沿用 manager 语义：空数组不降级、抛错才降级）。 */
  async searchStocks(query: string): Promise<StockSearchCandidate[]> {
    const normalized = query.trim();
    if (!normalized) return [];
    try {
      const { items } = await this.client.get('/api/meta/tickers/search', {
        q: normalized,
        asset_type: 'a-share',
        limit: 50,
      });
      const candidates: StockSearchCandidate[] = [];
      for (const row of items) {
        const parsed = TickerItemSchema.parse(row);
        // 只保留沪深 A 股；BJ / 场外基金（exchange=null）不进搜索候选。
        if (parsed.exchange !== 'SH' && parsed.exchange !== 'SZ') continue;
        candidates.push({
          id: parsed.thscode,
          code: parsed.ticker,
          exchange: parsed.exchange,
          name: parsed.name,
        });
      }
      return candidates;
    } catch (error) {
      const translated = translateFuyaoError(error);
      this.logger.warn('fuyao.searchStocks failed', {
        kind: kindOf(translated),
        error: translated.message,
      });
      throw translated;
    }
  }

  /**
   * 全市场快照（沪深 A 股）：省略 thscodes 的分页模式，limit=100，offset 循环
   * 直至某页 item.length < limit。顺序翻页不并发；任一页失败直接抛错——
   * 返回半拉子全集会让分组刷新误算退出成员（对齐 eastmoney clist 语义）。
   */
  async fetchMarketSnapshot(): Promise<readonly MarketSnapshotItem[]> {
    return (await this.fetchMarketSnapshotEnvelope()).items;
  }

  /**
   * fuyao 分页协议不返回 total；连续拉取至首个短页即证明已到达末页。
   * 任一页请求失败会抛错，跨页重复则标记为不完整，避免把分页漂移样本用于市场宽度。
   */
  async fetchMarketSnapshotEnvelope(): Promise<MarketSnapshot> {
    try {
      const items: MarketSnapshotItem[] = [];
      const observedTimes: number[] = [];
      for (let offset = 0; ; offset += MARKET_SNAPSHOT_PAGE_SIZE) {
        const { items: rows, timestamp } = await this.client.get('/api/a-share/prices/snapshot', {
          limit: MARKET_SNAPSHOT_PAGE_SIZE,
          offset,
        });
        if (timestamp !== undefined) observedTimes.push(timestamp.getTime());
        for (const row of rows) {
          const parsed = SnapshotItemSchema.parse(row);
          const exchange = parsed.thscode.endsWith('.SH')
            ? ('SH' as const)
            : parsed.thscode.endsWith('.SZ')
              ? ('SZ' as const)
              : undefined;
          if (exchange === undefined || parsed.ticker == null || parsed.ticker === '') continue;
          const last = parsed.last_price;
          const close = last != null && Number.isFinite(last) && last > 0 ? last : undefined;
          const changePct =
            parsed.price_change_ratio_pct != null && Number.isFinite(parsed.price_change_ratio_pct)
              ? parsed.price_change_ratio_pct
              : undefined;
          items.push({
            id: parsed.thscode,
            code: parsed.ticker,
            exchange,
            // 快照响应不含中文名（上游文档口径）；以代码占位满足 MarketSnapshotItem 的
            // name 非空不变量，名称解析走 search capability。
            name: parsed.ticker,
            ...(close === undefined ? {} : { close }),
            ...(changePct === undefined ? {} : { changePct }),
          });
        }
        if (rows.length < MARKET_SNAPSHOT_PAGE_SIZE) break;
      }
      const unique = [...new Map(items.map((item) => [item.id, item])).values()];
      const duplicateCount = items.length - unique.length;
      const observedAt =
        observedTimes.length === 0 ? undefined : new Date(Math.min(...observedTimes));
      const snapshot = MarketSnapshotSchema.parse({
        coverage: 'CN_A_SHARES_SH_SZ',
        source: 'fuyao',
        fetchedAt: this.clock(),
        ...(observedAt === undefined ? {} : { observedAt, dataAsOf: observedAt }),
        items: unique,
        completeness: {
          expectedCount: unique.length,
          receivedCount: unique.length,
          missingCount: 0,
          duplicateCount,
          complete: unique.length > 0 && duplicateCount === 0,
        },
      });
      assertMarketSnapshotInvariants(snapshot);
      this.logger.info('fuyao.fetchMarketSnapshotEnvelope ok', {
        source: 'fuyao',
        count: unique.length,
      });
      return snapshot;
    } catch (error) {
      const translated = translateFuyaoError(error);
      this.logger.warn('fuyao.fetchMarketSnapshotEnvelope failed', {
        kind: kindOf(translated),
        error: translated.message,
      });
      throw translated;
    }
  }

  /**
   * 大盘指数快照（/api/a-share-index/prices/snapshot，必须显式 thscodes）。
   * 单只缺失 / 价格非法跳过（warn），全部缺失抛 no_data（对齐 eastmoney / tushare 容错）。
   */
  async fetchIndexQuotes(): Promise<readonly IndexQuote[]> {
    try {
      const { timestamp, items } = await this.client.get('/api/a-share-index/prices/snapshot', {
        thscodes: MAJOR_INDICES.map((index) => index.thscode).join(','),
      });
      const byThscode = new Map<string, Record<string, unknown>>();
      for (const item of items) {
        if (typeof item.thscode === 'string') byThscode.set(item.thscode.toUpperCase(), item);
      }
      const fetchedAt = this.clock();
      const indices: IndexQuote[] = [];
      for (const { thscode, name } of MAJOR_INDICES) {
        const row = byThscode.get(thscode);
        if (row === undefined) {
          this.logger.warn('fuyao.fetchIndexQuotes index missing', { thscode });
          continue;
        }
        const parsed = SnapshotItemSchema.parse(row);
        const last = parsed.last_price;
        if (last == null || !Number.isFinite(last) || last <= 0) {
          this.logger.warn('fuyao.fetchIndexQuotes index invalid price', { thscode });
          continue;
        }
        indices.push({
          code: thscode,
          name,
          close: money(last),
          change:
            parsed.price_change != null && Number.isFinite(parsed.price_change)
              ? parsed.price_change
              : 0,
          changePct:
            parsed.price_change_ratio_pct != null && Number.isFinite(parsed.price_change_ratio_pct)
              ? parsed.price_change_ratio_pct
              : 0,
          ts:
            timestamp !== undefined && timestamp.getTime() <= fetchedAt.getTime()
              ? timestamp
              : fetchedAt,
          source: 'fuyao',
        });
      }
      if (indices.length === 0) {
        throw noDataError('fuyao no_data: 指数行情全部缺失');
      }
      this.logger.info('fuyao.fetchIndexQuotes ok', { source: 'fuyao', count: indices.length });
      return indices;
    } catch (error) {
      const translated = translateFuyaoError(error);
      this.logger.warn('fuyao.fetchIndexQuotes failed', {
        kind: kindOf(translated),
        error: translated.message,
      });
      throw translated;
    }
  }

  /** fuyao 无分钟线端点；不用日 K 冒充。 */
  fetchIntradayMinutes(stockId: string): Promise<readonly IntradayMinute[]> {
    return Promise.reject(
      unsupportedCapabilityError(`unsupported_capability: fuyao 无分时数据端点（${stockId}）`),
    );
  }

  /** fuyao 无分钟线端点；不用日 K 冒充。 */
  fetchMinuteBars(stockId: string, interval: MinuteBarInterval): Promise<readonly MinuteBar[]> {
    return Promise.reject(
      unsupportedCapabilityError(
        `unsupported_capability: fuyao 无分钟线端点（${stockId} ${interval}）`,
      ),
    );
  }

  /**
   * 快照行 → Quote：volume 已是股、turnover 为元直接映射；observedAt 取信封
   * data.timestamp（timestampSource='upstream'），上游时间戳缺失或晚于本地时钟
   * （时钟偏移）时回退本地时钟。价格缺失 / 非正返回 undefined（调用方按 no_data 处理）。
   */
  private toQuote(
    thscode: string,
    row: Record<string, unknown>,
    timestamp: Date | undefined,
  ): Quote | undefined {
    const parsed = SnapshotItemSchema.parse(row);
    const last = parsed.last_price;
    const open = parsed.open_price;
    const high = parsed.high_price;
    const low = parsed.low_price;
    if (
      last == null ||
      !Number.isFinite(last) ||
      last <= 0 ||
      open == null ||
      high == null ||
      low == null ||
      open <= 0 ||
      high <= 0 ||
      low <= 0
    ) {
      return undefined;
    }
    const fetchedAt = this.clock();
    const upstream =
      timestamp !== undefined && timestamp.getTime() <= fetchedAt.getTime() ? timestamp : undefined;
    const observedAt = upstream ?? fetchedAt;
    return {
      stockId: thscode,
      observedAt,
      fetchedAt,
      timestampSource: upstream === undefined ? 'retrieval' : 'upstream',
      ts: observedAt,
      open: money(open),
      high: money(high),
      low: money(low),
      close: money(last),
      volume: parsed.volume != null && parsed.volume >= 0 ? parsed.volume : 0,
      ...(parsed.turnover != null && parsed.turnover >= 0 ? { amount: parsed.turnover } : {}),
      ...(parsed.prev_price != null && parsed.prev_price > 0
        ? { prevClose: money(parsed.prev_price) }
        : {}),
      source: 'fuyao',
    };
  }
}

/** ZodError → invalid_payload；其余已结构化错误原样透传。 */
export const translateFuyaoError = (error: unknown): Error => {
  if (error instanceof ZodError) {
    return invalidPayloadError(`fuyao parse: ${error.message}`, error);
  }
  return error instanceof Error ? error : upstreamError(String(error));
};

const kindOf = (error: Error): string =>
  error instanceof SourceExecutionError ? error.kind : sourceErrorKindOf(error);

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
};
