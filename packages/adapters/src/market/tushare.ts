import type { DailyBar, DateRange, Logger, Quote, StockSearchCandidate } from '@luoome/core';
import { quantity as brandQuantity, money } from '@luoome/core';
import { ZodError, z } from 'zod';

import type { TushareConfig } from '../tushare/client.js';
import { tushareQuery } from '../tushare/client.js';

/**
 * Tushare 行情适配器（MarketDataManager 的 finalFallback 第三真实源）。
 * 设计：docs/ddd/tushare-market-adapter-design.md。
 *
 * 要点：
 * - 只覆盖 SH / SZ A 股；HK / US / BJ 抛 unsupported_market（manager 视作一次失败）。
 * - 实时快照走 `rt_k`（vol 单位=股，close 即最新价）；
 *   日线走 `daily`（vol 单位=手，×100 归一为股），
 *   复权因子单独走 `adj_factor`，缺失不阻塞整批。
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

/** rt_k 快照行：close 即最新价，映射为 Quote.close，vol 已是股。 */
const QuoteRowSchema = z.object({
  ts_code: z.string().min(1),
  trade_time: z.string().nullish(),
  close: z.number().positive(),
  open: z.number().positive(),
  high: z.number().positive(),
  low: z.number().positive(),
  vol: z.number().nonnegative(),
});

const isTushareSupported = (stockCode: string): boolean => {
  const [, suffix] = stockCode.toUpperCase().trim().split('.');
  return suffix === 'SH' || suffix === 'SZ';
};

export class TushareMarketAdapter {
  readonly name = 'tushare';

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
      const rows = await tushareQuery('rt_k', { ts_code: tsCode }, this.config, this.fetchImpl, [
        'ts_code',
        'trade_time',
        'open',
        'high',
        'low',
        'close',
        'vol',
      ]);
      const row = rows[0];
      if (row === undefined) throw new Error(`tushare not_found: ${tsCode}`);
      const parsed = QuoteRowSchema.parse(row);
      const quote: Quote = {
        stockId: tsCode,
        // trade_time 缺失或不可解析时才退回本地抓取时间。
        ts: parseTradeTime(parsed.trade_time) ?? this.clock(),
        open: money(parsed.open),
        high: money(parsed.high),
        low: money(parsed.low),
        close: money(parsed.close),
        volume: parsed.vol,
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

  async fetchDailyBars(stockCode: string, range: DateRange): Promise<DailyBar[]> {
    if (!isTushareSupported(stockCode)) {
      this.logger.warn('tushare market not supported by tushare', { stockCode });
      throw new Error(`unsupported_market: ${stockCode}`);
    }
    const tsCode = stockCode.toUpperCase();
    try {
      const startDate = formatYmd(range.start);
      const endDate = formatYmd(range.end);

      // 日线必需、复权因子可降级：并发发起，adj_factor 失败只降级不整批失败。
      const [dailyResult, adjResult] = await Promise.allSettled([
        tushareQuery(
          'daily',
          { ts_code: tsCode, start_date: startDate, end_date: endDate },
          this.config,
          this.fetchImpl,
          ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'vol'],
        ),
        tushareQuery(
          'adj_factor',
          { ts_code: tsCode, start_date: startDate, end_date: endDate },
          this.config,
          this.fetchImpl,
          ['ts_code', 'trade_date', 'adj_factor'],
        ),
      ]);

      if (dailyResult.status === 'rejected') {
        throw dailyResult.reason;
      }
      const dailyRows = dailyResult.value;

      let adjRows: Array<Record<string, unknown>> = [];
      if (adjResult.status === 'fulfilled') {
        adjRows = adjResult.value;
      } else {
        this.logger.warn('tushare.fetchDailyBars adj_factor request failed', {
          stockCode: tsCode,
          error: errorMessage(adjResult.reason),
        });
      }

      const adjByDate = new Map<string, number>();
      for (const row of adjRows) {
        const date = normalizeTradeDate(row.trade_date);
        if (
          date !== null &&
          typeof row.adj_factor === 'number' &&
          Number.isFinite(row.adj_factor) &&
          row.adj_factor > 0
        ) {
          adjByDate.set(date, row.adj_factor);
        }
      }

      const seen = new Set<string>();
      const bars: DailyBar[] = [];
      for (const row of dailyRows) {
        // server 可能把 YYYYMMDD 序列化为 number 或 string。
        const date = normalizeTradeDate(row.trade_date);
        if (date === null || seen.has(date)) continue;
        const open = asMoney(row.open);
        const high = asMoney(row.high);
        const low = asMoney(row.low);
        const close = asMoney(row.close);
        const volume = asShares(row.vol); // unit=lots → shares
        if (open === null || high === null || low === null || close === null || volume === null) {
          continue;
        }
        seen.add(date);
        const adj = adjByDate.get(date);
        if (adj === undefined) {
          this.logger.warn('tushare.fetchDailyBars adj_factor missing', {
            stockCode: tsCode,
            date,
          });
        }
        bars.push({
          stockId: tsCode,
          date: parseYmd(date), // UTC 00:00
          open,
          high,
          low,
          close,
          volume,
          adjFactor: adj ?? 1.0,
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
      return rows.slice(0, 20).flatMap((row) => {
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

/** 日线 vol（手）→ 股：拒绝非有限值与负成交量。 */
const asShares = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? brandQuantity(Math.round(v * 100)) : null;

const kindOf = (message: string): string => {
  if (message.startsWith('unsupported_market')) return 'unsupported_market';
  if (message.startsWith('tushare network')) return 'network';
  if (message.startsWith('tushare http')) return 'http';
  if (message.startsWith('tushare parse')) return 'parse';
  if (message.startsWith('tushare not_found')) return 'not_found';
  return 'unknown';
};

const errorMessage = (e: unknown): string => {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
};
