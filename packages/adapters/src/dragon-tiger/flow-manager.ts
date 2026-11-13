import type {
  DragonTigerFlow,
  DragonTigerFlowDay,
  DragonTigerFlowQuery,
  DragonTigerFlowRangeDays,
  DragonTigerFlowResultLike,
  Logger,
  SourceErrorKind,
  SourceStatus,
} from '@luoome/core';
import {
  aggregateDragonTigerFlow,
  assertDragonTigerFlowInvariants,
  BUILTIN_HOLIDAYS,
  dateInShanghai,
  isHoliday,
  isWeekend,
} from '@luoome/core';

import { SourceExecutionError } from '../source-error.js';

/**
 * 龙虎榜资金流向拓扑 manager。
 *
 * 职责：把「近 N 个交易日 × 全榜个股」拉成概念累计净额轨迹。
 * - 交易日历：优先上游交易日历；失败时回退内置节假日历并给 `calendar-fallback` warning
 * - 非交易日 / 未来日：向前对齐到最近交易日，warning `non-trading-day:<requested>`
 * - 单日失败不拖垮整条区间：warning `partial-data:<n>`，其余交易日照常入轨迹
 * - 缓存：单日 board 10 分钟（收盘后数据稳定）、整条 flow 60 秒（页面自动刷新友好）
 * - 并发：默认 5，20 个交易日约 4 轮往返
 * - 失败一律返回 { ok:false, error }，不抛异常给 tool 层
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_BOARD_CACHE_TTL_MS = 10 * 60_000;
const DEFAULT_FLOW_CACHE_TTL_MS = 60_000;
const DEFAULT_CALENDAR_CACHE_TTL_MS = 6 * 60 * 60_000;
const MAX_BOARD_CACHE_ENTRIES = 240;
const LOOKBACK_PADDING_DAYS = 20;
/** 额外多取 2 个交易日：用于识别「最近交易日榜单尚未发布」并整体前移，而不是把空日画进轨迹。 */
const TRAILING_PROBE_DAYS = 2;
const RECOVERABLE_KINDS: ReadonlySet<SourceErrorKind> = new Set([
  'network',
  'timeout',
  'rate_limited',
]);

/** 源的最小能力面（生产实现 FuyaoDragonTigerFlowSource；测试注入 fake）。 */
export interface DragonTigerFlowSourceLike {
  readonly name: string;
  fetchTradingDays(startDate: string, endDate: string): Promise<string[]>;
  fetchBoard(date: string, rangeDays: DragonTigerFlowRangeDays): Promise<DragonTigerFlowDay>;
}

export interface DragonTigerFlowManagerOptions {
  readonly source: DragonTigerFlowSourceLike;
  readonly logger: Logger;
  readonly clock: () => Date;
  readonly concurrency?: number;
  readonly boardCacheTtlMs?: number;
  readonly flowCacheTtlMs?: number;
  readonly calendarCacheTtlMs?: number;
}

interface CacheEntry<T> {
  readonly value: T;
  readonly at: number;
}

const addDays = (date: string, delta: number): string =>
  new Date(new Date(`${date}T00:00:00Z`).getTime() + delta * DAY_MS).toISOString().slice(0, 10);

const isTradingDay = (date: string): boolean => {
  const day = new Date(`${date}T00:00:00Z`);
  return !isWeekend(day) && !isHoliday(day, BUILTIN_HOLIDAYS);
};

const fallbackTradingDates = (startDate: string, endDate: string): string[] => {
  const dates: string[] = [];
  const end = new Date(`${endDate}T00:00:00Z`).getTime();
  for (let t = new Date(`${startDate}T00:00:00Z`).getTime(); t <= end; t += DAY_MS) {
    const date = new Date(t).toISOString().slice(0, 10);
    if (isTradingDay(date)) dates.push(date);
  }
  return dates;
};

const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
};

export class DragonTigerFlowManager {
  readonly name = 'dragon-tiger-flow' as const;
  readonly sources: readonly string[];

  private readonly source: DragonTigerFlowSourceLike;
  private readonly logger: Logger;
  private readonly clock: () => Date;
  private readonly concurrency: number;
  private readonly boardCacheTtlMs: number;
  private readonly flowCacheTtlMs: number;
  private readonly calendarCacheTtlMs: number;

  private readonly boardCache = new Map<string, CacheEntry<DragonTigerFlowDay>>();
  private readonly flowCache = new Map<string, CacheEntry<DragonTigerFlow>>();
  private readonly calendarCache = new Map<string, CacheEntry<string[]>>();

  private lastAttemptAt: Date | undefined;
  private lastSuccessAt: Date | undefined;
  private lastErrorKind: SourceErrorKind | undefined;
  private dataAsOf: Date | undefined;

  constructor(options: DragonTigerFlowManagerOptions) {
    this.source = options.source;
    this.sources = [options.source.name];
    this.logger = options.logger;
    this.clock = options.clock;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.boardCacheTtlMs = options.boardCacheTtlMs ?? DEFAULT_BOARD_CACHE_TTL_MS;
    this.flowCacheTtlMs = options.flowCacheTtlMs ?? DEFAULT_FLOW_CACHE_TTL_MS;
    this.calendarCacheTtlMs = options.calendarCacheTtlMs ?? DEFAULT_CALENDAR_CACHE_TTL_MS;
  }

  status(): readonly SourceStatus[] {
    return [
      {
        dataset: 'dragon-tiger-flow',
        source: this.source.name,
        coverage: ['CN_A_SHARES_SH_SZ'],
        capabilityEnabled: true,
        configurationReady: true,
        ...(this.lastAttemptAt === undefined ? {} : { lastAttemptAt: this.lastAttemptAt }),
        ...(this.lastSuccessAt === undefined ? {} : { lastSuccessAt: this.lastSuccessAt }),
        ...(this.lastErrorKind === undefined ? {} : { lastErrorKind: this.lastErrorKind }),
        ...(this.dataAsOf === undefined ? {} : { dataAsOf: this.dataAsOf }),
      },
    ];
  }

  async fetchFlow(query: DragonTigerFlowQuery): Promise<DragonTigerFlowResultLike> {
    const now = this.clock();
    this.lastAttemptAt = now;

    const cached = this.readCache(
      this.flowCache,
      this.flowCacheKey(query, now),
      this.flowCacheTtlMs,
      now,
    );
    if (cached !== undefined) return { ok: true, data: cached };

    try {
      const resolved = await this.resolveWindow(query, now);
      const warnings = [...resolved.warnings];

      const loaded = await mapWithConcurrency(resolved.dates, this.concurrency, async (date) =>
        this.loadBoard(date, query.rangeDays, now),
      );

      // 收盘后榜单才发布：最近交易日可能整日为空（盘前 / 发布延迟）。
      // 只裁剪「尾部连续空日」，中间的空日保留为 0 增量（可能是真实无上榜）。
      let endIndex = loaded.length - 1;
      while (endIndex >= 0) {
        const item = loaded[endIndex];
        if (item?.ok && item.day.stocks.length > 0) break;
        endIndex -= 1;
      }
      let dates = resolved.dates;
      let results = loaded;
      if (endIndex >= 0 && endIndex < loaded.length - 1) {
        warnings.push(`latest-day-pending:${loaded.length - 1 - endIndex}`);
        dates = dates.slice(0, endIndex + 1);
        results = loaded.slice(0, endIndex + 1);
      }
      if (dates.length > query.days) {
        dates = dates.slice(-query.days);
        results = results.slice(-query.days);
      }

      const days: DragonTigerFlowDay[] = [];
      let firstFailure: unknown;
      for (const result of results) {
        if (result.ok) {
          days.push(result.day);
          continue;
        }
        if (firstFailure === undefined) firstFailure = result.error;
      }
      if (days.length === 0) {
        const message =
          firstFailure instanceof Error ? firstFailure.message : String(firstFailure ?? '未知错误');
        this.lastErrorKind =
          firstFailure instanceof SourceExecutionError ? firstFailure.kind : 'upstream_error';
        return this.errorResult(message, RECOVERABLE_KINDS.has(this.lastErrorKind));
      }
      if (days.length < dates.length) {
        warnings.push(`partial-data:${dates.length - days.length}`);
      }

      const flow = aggregateDragonTigerFlow(days, {
        tradingDates: dates,
        board: query.board,
        rangeDays: query.rangeDays,
        source: this.source.name,
        asOf: now,
        warnings,
      });
      if (flow.stats.stockCount === 0) flow.warnings.push('empty-list');
      assertDragonTigerFlowInvariants(flow);

      this.writeCache(this.flowCache, this.flowCacheKey(query, now), flow, now, 8);
      this.lastSuccessAt = now;
      this.lastErrorKind = undefined;
      this.dataAsOf = new Date(`${flow.endDate}T15:00:00+08:00`);
      return { ok: true, data: flow };
    } catch (error) {
      const kind = error instanceof SourceExecutionError ? error.kind : 'upstream_error';
      this.lastErrorKind = kind;
      this.logger.warn('dragon-tiger-flow 拉取失败', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.errorResult(
        error instanceof Error ? error.message : String(error),
        RECOVERABLE_KINDS.has(kind),
      );
    }
  }

  private flowCacheKey(query: DragonTigerFlowQuery, now: Date): string {
    return `${query.date ?? dateInShanghai(now)}|${query.days}|${query.board}|${query.rangeDays}`;
  }

  private errorResult(message: string, recoverable: boolean): DragonTigerFlowResultLike {
    return {
      ok: false,
      error: { kind: 'adapter_error', adapter: 'dragon-tiger-flow', message, recoverable },
    };
  }

  private async loadBoard(
    date: string,
    rangeDays: DragonTigerFlowRangeDays,
    now: Date,
  ): Promise<
    | { readonly ok: true; readonly day: DragonTigerFlowDay }
    | { readonly ok: false; readonly error: unknown }
  > {
    const key = `${date}|${rangeDays}`;
    const cached = this.readCache(this.boardCache, key, this.boardCacheTtlMs, now);
    if (cached !== undefined) return { ok: true, day: cached };
    try {
      const day = await this.source.fetchBoard(date, rangeDays);
      // 空日不缓存：收盘后榜单发布前拉到的空结果若缓存 10 分钟，页面会一直看不到当天数据。
      if (day.stocks.length > 0) {
        this.writeCache(this.boardCache, key, day, now, MAX_BOARD_CACHE_ENTRIES);
      }
      return { ok: true, day };
    } catch (error) {
      this.logger.warn('dragon-tiger-flow 单日拉取失败', {
        date,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, error };
    }
  }

  private readCache<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    ttlMs: number,
    now: Date,
  ): T | undefined {
    const entry = cache.get(key);
    if (entry === undefined) return undefined;
    if (now.getTime() - entry.at > ttlMs) {
      cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  private writeCache<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    value: T,
    now: Date,
    maxEntries: number,
  ): void {
    cache.set(key, { value, at: now.getTime() });
    if (cache.size <= maxEntries) return;
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }

  /** 解析区间：请求日向前对齐交易日，取最近 `days` 个。 */
  private async resolveWindow(
    query: DragonTigerFlowQuery,
    now: Date,
  ): Promise<{ dates: string[]; warnings: string[] }> {
    const today = dateInShanghai(now);
    const requestedRaw = query.date ?? today;
    const warnings: string[] = [];
    // 未来日期无法取数：先夹到今天，再按交易日向前对齐（warning 让调用方知道入参被修正）。
    const requested = requestedRaw > today ? today : requestedRaw;
    if (requested !== requestedRaw) warnings.push(`future-date:${requestedRaw}`);
    const windowStart = addDays(requested, -(query.days * 2 + LOOKBACK_PADDING_DAYS));

    let calendar: string[];
    try {
      calendar = await this.tradingDates(windowStart, requested, now);
    } catch (error) {
      this.logger.warn('dragon-tiger-flow 交易日历不可用，回退内置日历', {
        error: error instanceof Error ? error.message : String(error),
      });
      calendar = fallbackTradingDates(windowStart, requested);
      warnings.push('calendar-fallback');
    }

    const upto = calendar.filter((date) => date <= requested);
    if (upto.length === 0) {
      throw new Error('交易日历为空，无法解析龙虎榜区间');
    }
    const endDate = upto[upto.length - 1] ?? requested;
    if (endDate !== requested) warnings.push(`non-trading-day:${requested}`);
    const dates = upto.slice(-(query.days + TRAILING_PROBE_DAYS));
    if (dates.length < query.days) warnings.push(`calendar-short:${dates.length}`);
    return { dates, warnings };
  }

  private async tradingDates(startDate: string, endDate: string, now: Date): Promise<string[]> {
    const key = `${startDate}|${endDate}`;
    const cached = this.readCache(this.calendarCache, key, this.calendarCacheTtlMs, now);
    if (cached !== undefined) return cached;
    const dates = await this.source.fetchTradingDays(startDate, endDate);
    this.writeCache(this.calendarCache, key, dates, now, 8);
    return dates;
  }
}
