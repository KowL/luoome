import type { AdshareConfig } from '@luoome/adshare-sdk';
import { AdshareError, fetchStockBasic, fetchWithAuth } from '@luoome/adshare-sdk';
import type { DailyBar, DateRange, Logger, Quote, StockSearchCandidate } from '@luoome/core';
import { quantity as brandQuantity, money } from '@luoome/core';
import { ZodError, z } from 'zod';

import { parseTushareEnvelopeRows } from './adshare-envelope.js';

/**
 * Adshare 行情适配器（v0.9 起，MarketDataManager 的 finalFallback 第三真实源）。
 * 设计：docs/ddd/adshare-market-adapter-design.md。
 *
 * 要点：
 * - 只覆盖 SH / SZ A 股；HK / US / BJ 抛 unsupported_market（manager 视作一次失败）。
 * - 实时快照走 `/tushare/realtime/rt_k`（Tushare envelope，vol 单位=股）；
 *   日线走 `/tushare/stock/daily`（vol 单位=手，×100 归一为股），
 *   复权因子单独走 `/tushare/stock/adj_factor`，缺失不阻塞整批。
 * - 所有远端调用复用 SDK fetchWithAuth（双认证头 / 超时 / 5xx+网络重试）。
 * - AdshareError 不泄漏给 manager：统一转译为带 `adshare ...` 前缀的普通 Error。
 */

export interface AdshareMarketAdapterOptions {
  readonly clock?: () => Date;
  readonly fetchImpl?: typeof fetch;
  readonly logger: Logger;
  /** 由 assembly factory 从 ADSHARE_* 解析后注入；adapter 不读 process.env。 */
  readonly config: AdshareConfig;
}

/** rt_k 快照行：price 映射为 Quote.close，vol 已是股。 */
const QuoteRowSchema = z.object({
  ts_code: z.string().min(1),
  trade_time: z.string().nullish(),
  price: z.number().positive(),
  open: z.number().positive(),
  high: z.number().positive(),
  low: z.number().positive(),
  vol: z.number().nonnegative(),
});

const isAdshareSupported = (stockCode: string): boolean => {
  const [, suffix] = stockCode.toUpperCase().trim().split('.');
  return suffix === 'SH' || suffix === 'SZ';
};

export class AdshareMarketAdapter {
  readonly name = 'adshare';

  private readonly clock: () => Date;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;
  private readonly config: AdshareConfig;

  constructor(options: AdshareMarketAdapterOptions) {
    this.clock = options.clock ?? ((): Date => new Date());
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
    this.config = options.config;
  }

  async fetchQuote(stockCode: string): Promise<Quote> {
    if (!isAdshareSupported(stockCode)) {
      this.logger.warn('adshare market not supported by adshare', { stockCode });
      throw new Error(`unsupported_market: ${stockCode}`);
    }
    const tsCode = stockCode.toUpperCase(); // 保留完整 '600519.SH'
    try {
      const params = new URLSearchParams({ ts_code: tsCode });
      const res = await fetchWithAuth(
        `${this.config.url}/tushare/realtime/rt_k?${params}`,
        this.config.apiKey,
        this.fetchImpl,
        { timeoutMs: this.config.timeoutMs, retries: this.config.retries },
      );
      const rows = parseTushareEnvelopeRows(await readJson(res));
      const row = rows[0];
      if (row === undefined) throw new Error(`adshare not_found: ${tsCode}`);
      const parsed = QuoteRowSchema.parse(row);
      const quote: Quote = {
        stockId: tsCode,
        // trade_time 缺失或不可解析时才退回本地抓取时间。
        ts: parseTradeTime(parsed.trade_time) ?? this.clock(),
        open: money(parsed.open),
        high: money(parsed.high),
        low: money(parsed.low),
        close: money(parsed.price),
        volume: parsed.vol,
        source: 'adshare',
      };
      this.logger.info('adshare.fetchQuote ok', { stockCode: tsCode, source: 'adshare' });
      return quote;
    } catch (error) {
      const translated = translateAdshareError(error);
      this.logger.warn('adshare.fetchQuote failed', {
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
          this.logger.warn('adshare.batchQuote omitted', {
            code,
            error: errorMessage(error),
          });
        }
      }),
    );
    return out;
  }

  async fetchDailyBars(stockCode: string, range: DateRange): Promise<DailyBar[]> {
    if (!isAdshareSupported(stockCode)) {
      this.logger.warn('adshare market not supported by adshare', { stockCode });
      throw new Error(`unsupported_market: ${stockCode}`);
    }
    const tsCode = stockCode.toUpperCase();
    try {
      const startDate = formatYmd(range.start);
      const endDate = formatYmd(range.end);
      const auth = { timeoutMs: this.config.timeoutMs, retries: this.config.retries };

      // 日线必需、复权因子可降级：并发发起，adj_factor 失败只降级不整批失败。
      const [dailyResult, adjResult] = await Promise.allSettled([
        fetchWithAuth(
          `${this.config.url}/tushare/stock/daily?${new URLSearchParams({
            ts_code: tsCode,
            start_date: startDate,
            end_date: endDate,
          })}`,
          this.config.apiKey,
          this.fetchImpl,
          auth,
        ),
        fetchWithAuth(
          `${this.config.url}/tushare/stock/adj_factor?${new URLSearchParams({
            ts_code: tsCode,
            start_date: startDate,
            end_date: endDate,
          })}`,
          this.config.apiKey,
          this.fetchImpl,
          auth,
        ),
      ]);

      if (dailyResult.status === 'rejected') {
        throw dailyResult.reason;
      }
      const dailyRows = parseTushareEnvelopeRows(await readJson(dailyResult.value));

      let adjRows: Array<Record<string, unknown>> = [];
      if (adjResult.status === 'fulfilled') {
        try {
          adjRows = parseTushareEnvelopeRows(await readJson(adjResult.value));
        } catch (error) {
          this.logger.warn('adshare.fetchDailyBars adj_factor parse failed', {
            stockCode: tsCode,
            error: errorMessage(error),
          });
        }
      } else {
        this.logger.warn('adshare.fetchDailyBars adj_factor request failed', {
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
          this.logger.warn('adshare.fetchDailyBars adj_factor missing', {
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
          source: 'adshare',
        });
      }

      const result = bars
        .filter((b) => b.date >= range.start && b.date <= range.end)
        .sort((a, b) => a.date.getTime() - b.date.getTime());
      this.logger.info('adshare.fetchDailyBars ok', {
        stockCode: tsCode,
        source: 'adshare',
        count: result.length,
      });
      return result;
    } catch (error) {
      const translated = translateAdshareError(error);
      this.logger.warn('adshare.fetchDailyBars failed', {
        stockCode: tsCode,
        kind: kindOf(translated.message),
        error: translated.message,
      });
      throw translated;
    }
  }

  /**
   * 复用 SDK fetchStockBasic；adshare `stock_basic.exchange` 用 SSE / SZSE，
   * 显式映射为 core 的 SH / SZ，其它交易所剔除，避免 HK / US / BJ 漏到下游。
   */
  async searchStocks(query: string): Promise<StockSearchCandidate[]> {
    const normalized = query.trim().toUpperCase();
    if (!normalized) return [];
    try {
      const tsCode = normalizeSearchTsCode(normalized);
      const rows = await fetchStockBasic(
        this.config.url,
        this.config.apiKey,
        this.fetchImpl,
        {
          ...(tsCode === null ? { name: normalized } : { ts_code: tsCode }),
          fields: ['ts_code', 'name', 'exchange'],
          limit: 20,
        },
        { timeoutMs: this.config.timeoutMs, retries: this.config.retries },
      );
      return rows.flatMap((row) => {
        const exchange =
          row.exchange === 'SSE'
            ? ('SH' as const)
            : row.exchange === 'SZSE'
              ? ('SZ' as const)
              : null;
        if (exchange === null) return [];
        const code = row.ts_code.split('.')[0];
        if (code === undefined) return [];
        return [{ id: row.ts_code, code, exchange, name: row.name }];
      });
    } catch (error) {
      const translated = translateAdshareError(error);
      this.logger.warn('adshare.searchStocks failed', {
        kind: kindOf(translated.message),
        error: translated.message,
      });
      throw translated;
    }
  }
}

/** AdshareError / ZodError → 带 `adshare ...` 前缀的普通 Error（manager 不感知 SDK 错误类）。 */
export const translateAdshareError = (error: unknown): Error => {
  if (error instanceof AdshareError) {
    switch (error.code) {
      case 'NETWORK_ERROR':
      case 'TIMEOUT':
        return new Error(`adshare network: ${error.message}`);
      case 'HTTP_ERROR':
        return new Error(`adshare http: ${error.message}`);
      case 'PARSE_ERROR':
        return new Error(`adshare parse: ${error.message}`);
      case 'NOT_FOUND':
        return new Error(`adshare not_found: ${error.message}`);
      case 'INVALID_INPUT':
        return new Error(`adshare invalid_input: ${error.message}`);
      default:
        return new Error(`adshare unknown: ${error.message}`);
    }
  }
  if (error instanceof ZodError) return new Error(`adshare parse: ${error.message}`);
  return error instanceof Error ? error : new Error(String(error));
};

const readJson = async (res: Response): Promise<unknown> => {
  try {
    return await res.json();
  } catch (error) {
    throw new AdshareError('PARSE_ERROR', '响应不是有效 JSON', { cause: error });
  }
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
  if (message.startsWith('adshare network')) return 'network';
  if (message.startsWith('adshare http')) return 'http';
  if (message.startsWith('adshare parse')) return 'parse';
  if (message.startsWith('adshare not_found')) return 'not_found';
  return 'unknown';
};

const errorMessage = (e: unknown): string => {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
};
