import type {
  DailyBar,
  DateRange,
  IndexQuote,
  Logger,
  MinuteBar,
  MinuteBarInterval,
  Quote,
  StockSearchCandidate,
} from '@luoome/core';
import { quantity as brandQuantity, MinuteBarSchema, money } from '@luoome/core';
import { ZodError, z } from 'zod';

import type { TushareConfig } from '../tushare/client.js';
import { tushareQuery } from '../tushare/client.js';

/**
 * Tushare 行情适配器（MarketDataManager 的 finalFallback 第三真实源）。
 * 设计：docs/ddd/tushare-market-adapter-design.md。
 *
 * 要点：
 * - 只覆盖 SH / SZ A 股；HK / US / BJ 抛 unsupported_market（manager 视作一次失败）。
 * - 实时快照走 `rt_k`（vol 单位=股，price 即最新价）；
 *   日线走 `daily`（vol 单位=手，×100 归一为股），
 *   复权因子走 `adj_factor` 全量历史（≤ end_date），按变动点前向填充出逐日因子；
 *   因子完全缺失或 bar 日早于首个变动日时抛 unsupported_adjustment 走降级。
 * - 所有远端调用复用 tushareQuery（POST envelope / 超时 / 5xx+网络重试）。
 * - rt_k 需单独开通权限；daily / adj_factor 需 2000 积分起（见 runbook）。
 */

export interface TushareMarketAdapterOptions {
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
  readonly logger: Logger;
  /** 由 assembly factory 从 TUSHARE_* 解析后注入；adapter 不读 process.env。 */
  readonly config: TushareConfig;
}

/** rt_k 快照行：price 即最新价，映射为 Quote.close，vol 已是股。 */
const QuoteRowSchema = z.object({
  ts_code: z.string().min(1),
  trade_time: z.string().nullish(),
  price: z.number().positive(),
  open: z.number().positive(),
  high: z.number().positive(),
  low: z.number().positive(),
  vol: z.number().nonnegative(),
  pre_close: z.number().positive().nullish(),
});

const MinuteBarRowSchema = z.object({
  code: z.string().min(1),
  freq: z.string().nullish(),
  time: z.string().min(1),
  open: z.number().positive(),
  close: z.number().positive(),
  high: z.number().positive(),
  low: z.number().positive(),
  vol: z.number().nonnegative(),
  amount: z.number().nonnegative(),
});

const TUSHARE_MINUTE_FREQ: Readonly<Record<MinuteBarInterval, string>> = {
  '1m': '1MIN',
  '5m': '5MIN',
  '15m': '15MIN',
  '30m': '30MIN',
  '60m': '60MIN',
};

const isTushareSupported = (stockCode: string): boolean => {
  const [, suffix] = stockCode.toUpperCase().trim().split('.');
  return suffix === 'SH' || suffix === 'SZ';
};

/** rt_k 快照行 OHLC+最新价 是否全零（盘前 / 停牌无成交的标志）。 */
const isZeroQuoteRow = (row: Record<string, unknown>): boolean =>
  ['open', 'high', 'low', 'price'].every((key) => row[key] === 0);

/**
 * 主要大盘指数清单（对齐 eastmoney MAJOR_INDICES）。
 * index_daily 不返回名称，用 ts_code → 中文名常量映射。
 */
const MAJOR_INDICES: ReadonlyArray<{ readonly tsCode: string; readonly name: string }> = [
  { tsCode: '000001.SH', name: '上证指数' },
  { tsCode: '399001.SZ', name: '深证成指' },
  { tsCode: '399006.SZ', name: '创业板指' },
  { tsCode: '000300.SH', name: '沪深300' },
  { tsCode: '000688.SH', name: '科创50' },
];

/** 指数行情回看窗口：覆盖长假，取窗口内每只股票最新一根日线。 */
const INDEX_LOOKBACK_DAYS = 10;

export class TushareMarketAdapter {
  readonly name = 'tushare';
  readonly indexQuoteMode = 'delayed' as const;

  private readonly clock: () => Date;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;
  private readonly config: TushareConfig;

  constructor(options: TushareMarketAdapterOptions) {
    this.clock = options.clock ?? ((): Date => new Date());
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
    this.config = options.config;
  }

  async fetchQuote(stockCode: string): Promise<Quote> {
    if (!isTushareSupported(stockCode)) {
      this.logger.warn('tushare market not supported by tushare', { stockCode });
      throw new Error(`unsupported_market: ${stockCode}`);
    }
    const tsCode = stockCode.toUpperCase(); // 保留完整 '600519.SH'
    try {
      // rt_k 在限流 / 上游抖动时会返回 code=0 但 items 为空（实测代理网关如此），
      // 属于瞬时故障而非股票不存在：先原地重试一次，仍为空才按无数据抛错走降级。
      let rows = await this.queryQuoteRows(tsCode);
      if (rows[0] === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        rows = await this.queryQuoteRows(tsCode);
      }
      const row = rows[0];
      if (row === undefined)
        throw new Error(`tushare no_data: ${tsCode} 快照为空（远端限流或抖动）`);
      // rt_k 盘前 / 停牌尚未有成交时价格全 0：不是合法 Quote，按无数据抛错走降级，
      // 避免 Zod 校验炸出冗长 parse 错误。
      if (isZeroQuoteRow(row)) {
        throw new Error(`tushare no_data: ${tsCode} 快照价格全零（盘前或停牌无成交）`);
      }
      const parsed = QuoteRowSchema.parse(row);
      const fetchedAt = this.clock();
      const upstreamAt = parseTradeTime(parsed.trade_time);
      const observedAt =
        upstreamAt !== undefined && upstreamAt.getTime() <= fetchedAt.getTime()
          ? upstreamAt
          : fetchedAt;
      const quote: Quote = {
        stockId: tsCode,
        observedAt,
        fetchedAt,
        timestampSource: observedAt === fetchedAt ? 'retrieval' : 'upstream',
        ts: observedAt,
        open: money(parsed.open),
        high: money(parsed.high),
        low: money(parsed.low),
        close: money(parsed.price), // rt_k 的 price 即最新价
        volume: parsed.vol,
        ...(parsed.pre_close !== null && parsed.pre_close !== undefined
          ? { prevClose: money(parsed.pre_close) }
          : {}),
        source: 'tushare',
      };
      this.logger.info('tushare.fetchQuote ok', { stockCode: tsCode, source: 'tushare' });
      return quote;
    } catch (error) {
      const translated = translateTushareError(error);
      this.logger.warn('tushare.fetchQuote failed', {
        stockCode: tsCode,
        kind: kindOf(translated.message),
        error: translated.message,
      });
      throw translated;
    }
  }

  /** rt_k 单股快照行；fields 固定（price 即最新价）。 */
  private queryQuoteRows(tsCode: string): Promise<Array<Record<string, unknown>>> {
    return tushareQuery('rt_k', { ts_code: tsCode }, this.config, this.fetchImpl, [
      'ts_code',
      'trade_time',
      'open',
      'high',
      'low',
      'price',
      'vol',
      'pre_close',
    ]);
  }

  /** 并行 fetchQuote；单只失败只丢弃该只，不让批量读路径整体失败。 */
  async batchQuote(stockCodes: readonly string[]): Promise<Map<string, Quote>> {
    const out = new Map<string, Quote>();
    await Promise.all(
      stockCodes.map(async (code) => {
        try {
          out.set(code, await this.fetchQuote(code));
        } catch (error) {
          this.logger.warn('tushare.batchQuote omitted', {
            code,
            error: errorMessage(error),
          });
        }
      }),
    );
    return out;
  }

  /**
   * A 股当日累计分钟 OHLCV：官方 rt_min_daily，单股、最多 1000 行、raw 价格，
   * 需要独立实时分钟权限。接口只给当前交易日，不承担历史分页。
   */
  async fetchMinuteBars(
    stockCode: string,
    interval: MinuteBarInterval,
  ): Promise<readonly MinuteBar[]> {
    if (!isTushareSupported(stockCode)) {
      throw new Error(`unsupported_market: ${stockCode}`);
    }
    const tsCode = stockCode.toUpperCase();
    try {
      const rows = await tushareQuery(
        'rt_min_daily',
        { ts_code: tsCode, freq: TUSHARE_MINUTE_FREQ[interval] },
        this.config,
        this.fetchImpl,
        ['code', 'freq', 'time', 'open', 'close', 'high', 'low', 'vol', 'amount'],
      );
      if (rows.length > 1000) {
        throw new Error(`partial_data: rt_min_daily exceeded 1000 rows for ${tsCode}`);
      }
      const fetchedAt = this.clock();
      const parsedRows = rows.map((row) => MinuteBarRowSchema.parse(row));
      const normalized = parsedRows.map((row) => {
        if (row.code.toUpperCase() !== tsCode) {
          throw new Error(`tushare parse: minute code mismatch ${row.code} != ${tsCode}`);
        }
        const expectedFreq = TUSHARE_MINUTE_FREQ[interval];
        if (
          row.freq !== undefined &&
          row.freq !== null &&
          row.freq.toUpperCase() !== expectedFreq
        ) {
          throw new Error(
            `tushare parse: minute frequency mismatch ${row.freq} != ${expectedFreq}`,
          );
        }
        const endedAt = parseTradeTime(row.time);
        if (endedAt === undefined) {
          throw new Error(`tushare parse: invalid minute time ${row.time}`);
        }
        return { row, endedAt };
      });
      normalized.sort((left, right) => left.endedAt.getTime() - right.endedAt.getTime());
      const latestEndedAt = normalized.at(-1)?.endedAt;
      const intervalMs = Number.parseInt(interval, 10) * 60_000;
      const bars = normalized.map(
        ({ row, endedAt }): MinuteBar =>
          MinuteBarSchema.parse({
            stockId: tsCode,
            interval,
            endedAt,
            open: money(row.open),
            high: money(row.high),
            low: money(row.low),
            close: money(row.close),
            volume: brandQuantity(Math.round(row.vol)),
            amount: row.amount,
            adjustment: 'raw',
            source: 'tushare',
            fetchedAt,
            completeness:
              latestEndedAt !== undefined &&
              endedAt.getTime() === latestEndedAt.getTime() &&
              fetchedAt.getTime() - endedAt.getTime() < intervalMs
                ? 'live'
                : 'closed',
          }),
      );
      this.logger.info('tushare.fetchMinuteBars ok', {
        stockCode: tsCode,
        interval,
        source: 'tushare',
        count: bars.length,
      });
      return bars;
    } catch (error) {
      const translated = translateTushareError(error);
      this.logger.warn('tushare.fetchMinuteBars failed', {
        stockCode: tsCode,
        interval,
        kind: kindOf(translated.message),
        error: translated.message,
      });
      throw translated;
    }
  }

  /**
   * 大盘指数行情：index_daily 一次请求（ts_code 逗号分隔 5 只）取最近
   * INDEX_LOOKBACK_DAYS 天日线，每只取最新一根。
   * 注意：这是日线口径而非盘中实时——盘中调用返回的是最近交易日收盘数据
   * （tushare 指数实时分钟接口权限门槛高，v0.x 不引入）。
   * 容错对齐 eastmoney 实现：单只缺数据 / close 非法跳过（warn），全部缺失抛 no_data。
   */
  async fetchIndexQuotes(): Promise<readonly IndexQuote[]> {
    const end = this.clock();
    const start = new Date(end.getTime() - INDEX_LOOKBACK_DAYS * 86_400_000);
    try {
      const rows = await tushareQuery(
        'index_daily',
        {
          ts_code: MAJOR_INDICES.map((i) => i.tsCode).join(','),
          start_date: formatYmd(start),
          end_date: formatYmd(end),
        },
        this.config,
        this.fetchImpl,
        ['ts_code', 'trade_date', 'close', 'pre_close', 'change', 'pct_chg'],
      );
      // 每只指数保留窗口内最新一行（trade_date 归一化为 'YYYYMMDD' 后字符串可比）。
      const latestByCode = new Map<string, { date: string; row: Record<string, unknown> }>();
      for (const row of rows) {
        if (typeof row.ts_code !== 'string') continue;
        const date = normalizeTradeDate(row.trade_date);
        if (date === null) continue;
        const prev = latestByCode.get(row.ts_code);
        if (prev === undefined || date > prev.date) {
          latestByCode.set(row.ts_code, { date, row });
        }
      }
      const indices: IndexQuote[] = [];
      for (const { tsCode, name } of MAJOR_INDICES) {
        const latest = latestByCode.get(tsCode);
        const close = latest === undefined ? null : asMoney(latest.row.close);
        if (latest === undefined || close === null) {
          this.logger.warn('tushare.fetchIndexQuotes index missing', { tsCode });
          continue;
        }
        indices.push({
          code: tsCode,
          name,
          close,
          change: asFiniteNumber(latest.row.change) ?? 0,
          changePct: asFiniteNumber(latest.row.pct_chg) ?? 0,
          ts: parseYmd(latest.date), // UTC 00:00，与 DailyBar.date 同约定
          source: 'tushare',
        });
      }
      if (indices.length === 0) {
        throw new Error('tushare no_data: 指数行情全部缺失（index_daily 无有效行）');
      }
      this.logger.info('tushare.fetchIndexQuotes ok', {
        source: 'tushare',
        count: indices.length,
      });
      return indices;
    } catch (error) {
      const translated = translateTushareError(error);
      this.logger.warn('tushare.fetchIndexQuotes failed', {
        kind: kindOf(translated.message),
        error: translated.message,
      });
      throw translated;
    }
  }

  async fetchDailyBars(stockCode: string, range: DateRange): Promise<DailyBar[]> {
    if (!isTushareSupported(stockCode)) {
      this.logger.warn('tushare market not supported by tushare', { stockCode });
      throw new Error(`unsupported_market: ${stockCode}`);
    }
    const tsCode = stockCode.toUpperCase();
    try {
      const startDate = formatYmd(range.start);
      const endDate = formatYmd(range.end);

      // adj_factor 不带 start_date：官方源按交易日逐日返回，但部分代理网关只返回
      // 因子变动日的稀疏行；拿全量历史（≤ end_date）才能对每个 bar 日前向填充出当日因子。
      const [dailyRows, adjRows] = await Promise.all([
        tushareQuery(
          'daily',
          { ts_code: tsCode, start_date: startDate, end_date: endDate },
          this.config,
          this.fetchImpl,
          ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'vol'],
        ),
        tushareQuery(
          'adj_factor',
          { ts_code: tsCode, end_date: endDate },
          this.config,
          this.fetchImpl,
          ['ts_code', 'trade_date', 'adj_factor'],
        ),
      ]);

      // 复权因子变动点（升序）：因子自变动日起生效，直到下一个变动日。
      const adjChangePoints: Array<{ readonly date: string; readonly factor: number }> = [];
      for (const row of adjRows) {
        const date = normalizeTradeDate(row.trade_date);
        if (
          date !== null &&
          typeof row.adj_factor === 'number' &&
          Number.isFinite(row.adj_factor) &&
          row.adj_factor > 0
        ) {
          adjChangePoints.push({ date, factor: row.adj_factor });
        }
      }
      adjChangePoints.sort((left, right) => left.date.localeCompare(right.date));
      const latestAdjFactor = adjChangePoints.at(-1)?.factor;
      if (dailyRows.length > 0 && latestAdjFactor === undefined) {
        throw new Error(`unsupported_adjustment: adj_factor missing for ${tsCode}`);
      }
      // 当日因子 = 最后一个 ≤ 当日的变动点因子（密集逐日源等价于精确匹配）。
      const adjFactorAt = (date: string): number | undefined => {
        let low = 0;
        let high = adjChangePoints.length - 1;
        let found = -1;
        while (low <= high) {
          const middle = (low + high) >> 1;
          const point = adjChangePoints[middle];
          if (point === undefined) break;
          if (point.date <= date) {
            found = middle;
            low = middle + 1;
          } else {
            high = middle - 1;
          }
        }
        return found === -1 ? undefined : adjChangePoints[found]?.factor;
      };

      const seen = new Set<string>();
      const bars: DailyBar[] = [];
      for (const row of dailyRows) {
        // server 可能把 YYYYMMDD 序列化为 number 或 string。
        const date = normalizeTradeDate(row.trade_date);
        if (date === null || seen.has(date)) continue;
        const tradeDate = parseYmd(date);
        if (tradeDate < range.start || tradeDate > range.end) continue;
        const open = asMoney(row.open);
        const high = asMoney(row.high);
        const low = asMoney(row.low);
        const close = asMoney(row.close);
        const volume = asShares(row.vol); // unit=lots → shares
        if (open === null || high === null || low === null || close === null || volume === null) {
          continue;
        }
        seen.add(date);
        const adj = adjFactorAt(date);
        if (adj === undefined) {
          // bar 日早于历史上首个因子变动日，无法确定当日复权口径
          throw new Error(`unsupported_adjustment: adj_factor missing for ${tsCode} ${date}`);
        }
        const ratio = adj / (latestAdjFactor as number);
        bars.push({
          stockId: tsCode,
          date: tradeDate, // UTC 00:00
          open: money(open * ratio),
          high: money(high * ratio),
          low: money(low * ratio),
          close: money(close * ratio),
          volume,
          adjustment: 'qfq',
          sourceAdjFactor: adj,
          source: 'tushare',
        });
      }

      const result = bars
        .filter((b) => b.date >= range.start && b.date <= range.end)
        .sort((a, b) => a.date.getTime() - b.date.getTime());
      this.logger.info('tushare.fetchDailyBars ok', {
        stockCode: tsCode,
        source: 'tushare',
        count: result.length,
      });
      return result;
    } catch (error) {
      const translated = translateTushareError(error);
      this.logger.warn('tushare.fetchDailyBars failed', {
        stockCode: tsCode,
        kind: kindOf(translated.message),
        error: translated.message,
      });
      throw translated;
    }
  }

  /**
   * tushare `stock_basic.exchange` 用 SSE / SZSE，显式映射为 core 的 SH / SZ，
   * 其它交易所剔除，避免 HK / US / BJ 漏到下游。
   *
   * stock_basic 的 name 参数是精确匹配（部分代理甚至直接忽略该参数返回默认首页），
   * 都服务不了 UI 的模糊搜索；因此按 query 相关性过滤结果，过滤后为空时抛错让
   * manager 降级到支持模糊搜索的源，而不是把默认首页当搜索结果返回。
   */
  async searchStocks(query: string): Promise<StockSearchCandidate[]> {
    const normalized = query.trim().toUpperCase();
    if (!normalized) return [];
    try {
      const tsCode = normalizeSearchTsCode(normalized);
      const rows = await tushareQuery(
        'stock_basic',
        tsCode === null ? { name: normalized } : { ts_code: tsCode },
        this.config,
        this.fetchImpl,
        ['ts_code', 'name', 'exchange'],
      );
      const candidates = rows.slice(0, 20).flatMap((row) => {
        const exchange =
          row.exchange === 'SSE'
            ? ('SH' as const)
            : row.exchange === 'SZSE'
              ? ('SZ' as const)
              : null;
        if (exchange === null) return [];
        if (typeof row.ts_code !== 'string' || typeof row.name !== 'string') return [];
        const code = row.ts_code.split('.')[0];
        if (code === undefined) return [];
        return [{ id: row.ts_code, code, exchange, name: row.name }];
      });
      const relevant = candidates.filter(
        (c) => c.name.toUpperCase().includes(normalized) || c.id.startsWith(normalized),
      );
      if (relevant.length === 0) {
        throw new Error(`tushare no_data: search no relevant match for ${normalized}`);
      }
      return relevant;
    } catch (error) {
      const translated = translateTushareError(error);
      this.logger.warn('tushare.searchStocks failed', {
        kind: kindOf(translated.message),
        error: translated.message,
      });
      throw translated;
    }
  }
}

/** ZodError → 带 `tushare ...` 前缀的普通 Error（manager 不感知额外错误类）。 */
export const translateTushareError = (error: unknown): Error => {
  if (error instanceof ZodError) return new Error(`tushare parse: ${error.message}`);
  return error instanceof Error ? error : new Error(String(error));
};

/** trade_date 归一：接受八位数字或八位字符串 → 'YYYYMMDD'；其它输入返回 null。 */
const normalizeTradeDate = (raw: unknown): string | null => {
  const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  return /^\d{8}$/.test(s) ? s : null;
};

/** 'YYYYMMDD' → UTC 00:00 Date。 */
const parseYmd = (ymd: string): Date =>
  new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00.000Z`);

/** Date → 'YYYYMMDD'（UTC）。 */
const formatYmd = (d: Date): string => {
  const y = d.getUTCFullYear().toString().padStart(4, '0');
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${y}${m}${day}`;
};

/** 完整或可推断交易所的六位 A 股代码 → ts_code；其它 query 按名称搜索。 */
const normalizeSearchTsCode = (query: string): string | null => {
  if (/^\d{6}\.(SH|SZ)$/.test(query)) return query;
  if (!/^\d{6}$/.test(query)) return null;
  if (/^[569]/.test(query)) return `${query}.SH`;
  if (/^[0123]/.test(query)) return `${query}.SZ`;
  return null;
};

/** 远端 trade_time（ISO 或 'YYYY-MM-DD HH:MM:SS'）→ Date；缺失/不可解析返回 undefined。 */
const parseTradeTime = (raw: string | null | undefined): Date | undefined => {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const iso = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const withZone = /(Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}+08:00`;
  const d = new Date(withZone);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

/** 日线 OHLC：拒绝非有限值与非正价格。 */
const asMoney = (v: unknown): ReturnType<typeof money> | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? money(v) : null;

/** 涨跌额 / 涨跌幅：任意有限 number 合法（可负可零），其它输入返回 null。 */
const asFiniteNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** 日线 vol（手）→ 股：拒绝非有限值与负成交量。 */
const asShares = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? brandQuantity(Math.round(v * 100)) : null;

const kindOf = (message: string): string => {
  if (message.startsWith('unsupported_market')) return 'unsupported_market';
  if (message.startsWith('tushare network')) return 'network';
  if (message.startsWith('tushare http')) return 'http';
  if (message.startsWith('tushare parse')) return 'parse';
  if (message.startsWith('tushare not_found')) return 'not_found';
  if (message.startsWith('tushare no_data')) return 'no_data';
  return 'unknown';
};

const errorMessage = (e: unknown): string => {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
};
