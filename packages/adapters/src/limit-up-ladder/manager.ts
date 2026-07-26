import type {
  LimitUpLadder,
  LimitUpLadderDiff,
  LimitUpLadderEntry,
  LimitUpLadderQuery,
  LimitUpLadderSource,
  Logger,
} from '@luoome/core';
import {
  assembleLadder,
  deriveBoard,
  diffTopLevel,
  filterAndDedupeEntries,
  LimitUpLadderSentinels,
} from '@luoome/core';

import type { LimitUpPoolEnricherLike, LimitUpPoolEnrichment } from './eastmoney-pool.js';
import { LRU } from './lru.js';
import type {
  LimitUpLadderAdapterLike,
  LimitUpLadderRawEntry,
  LimitUpLadderResult,
} from './types.js';

/**
 * LimitUpLadderManager（Phase 1，docs/ddd/limit-up-ladder-detailed-design.md §4.3）。
 *
 * 设计要点：
 * - 主源失败 → 捕获 → 可选 fallback → 双失败抛 adapter_error
 * - 缓存 key = (date, source, includeStar, includeBse, includeST, days)；
 *   includeUncategorized 是 entry 级展示过滤，不进 key，返回前再应用
 * - TTL：当日盘中 = 60s；当日收盘后 / 跨日 / 非当日 = Infinity；
 *   空 ladder（盘前 / 数据未更新）例外，封顶 60s，避免盘前快照全天滞留
 * - 收盘价修正（§6.4）：map 阶段按 raw.high == raw.close + pct ∈ [9.8%, 10%) 触发
 * - enricher（eastmoney 涨停池）：补齐 adshare 实测全空的 firstTime/finalTime/industry；
 *   失败只告警不阻断
 * - 节假日历：简化版内联实现（不依赖 cli，因为 adapters 不能反向依赖 cli）
 *   ；holidaysProvider 可注入供测试替换
 */

interface ManagerOptions {
  readonly primary: LimitUpLadderAdapterLike;
  readonly fallback?: LimitUpLadderAdapterLike;
  readonly logger: Logger;
  readonly clock: () => Date;
  /** 可选：涨停池 enricher，按 code 补齐封板时间 / 行业。 */
  readonly enricher?: LimitUpPoolEnricherLike;
  /** 测试用：注入节假日历避免实际环境依赖。 */
  readonly holidaysProvider?: () => Promise<ReadonlyMap<number, ReadonlySet<string>>>;
  /** 测试用：替换"今天是 YYYY-MM-DD"映射。 */
  readonly dateInShanghaiFn?: (d: Date) => string;
  /** 测试用：替换周末判定。 */
  readonly isWeekendFn?: (d: Date) => boolean;
  /** 测试用：替换节假日对照。 */
  readonly isHolidayFn?: (d: Date, h: ReadonlyMap<number, ReadonlySet<string>>) => boolean;
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

const defaultDateInShanghai = (d: Date): string => {
  const shanghaiMs = d.getTime() + SHANGHAI_OFFSET_MS;
  const sh = new Date(shanghaiMs);
  const y = sh.getUTCFullYear();
  const m = String(sh.getUTCMonth() + 1).padStart(2, '0');
  const day = String(sh.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const defaultIsWeekend = (d: Date): boolean => {
  const shanghaiMs = d.getTime() + SHANGHAI_OFFSET_MS;
  const sh = new Date(shanghaiMs);
  const wd = sh.getUTCDay();
  return wd === 0 || wd === 6;
};

const defaultIsHoliday = (d: Date, holidays: ReadonlyMap<number, ReadonlySet<string>>): boolean => {
  const ds = defaultDateInShanghai(d);
  const year = Number(ds.slice(0, 4));
  return holidays.get(year)?.has(ds) === true;
};

/** 内置 2026 A 股休市日（与 cli/holidays.ts 同步；缺 2027 是为了保持本文件自包含）。 */
const BUILTIN_HOLIDAYS_2026: ReadonlyMap<number, ReadonlySet<string>> = new Map<
  number,
  ReadonlySet<string>
>([
  [
    2026,
    new Set<string>([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-02-16',
      '2026-02-17',
      '2026-02-18',
      '2026-02-19',
      '2026-02-20',
      '2026-02-21',
      '2026-02-22',
      '2026-04-04',
      '2026-04-05',
      '2026-04-06',
      '2026-05-01',
      '2026-05-02',
      '2026-05-03',
      '2026-06-19',
      '2026-06-20',
      '2026-06-21',
      '2026-09-25',
      '2026-09-26',
      '2026-09-27',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
    ]),
  ],
]);

const defaultHolidaysProvider = async (): Promise<ReadonlyMap<number, ReadonlySet<string>>> => {
  // Phase 1 仅内置 2026；env 加载在 cli/holidays.ts，adapters 不能依赖 cli
  // 真实运行：2027+ 用户需自己补（limitation 已在文档标注）
  if (process.env.LUOOME_A_SHARE_HOLIDAYS === undefined) return BUILTIN_HOLIDAYS_2026;
  const raw = process.env.LUOOME_A_SHARE_HOLIDAYS;
  if (raw === undefined || raw.trim() === '') return BUILTIN_HOLIDAYS_2026;
  const out = new Map<number, Set<string>>();
  for (const t of raw.split(',')) {
    const trimmed = t.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) continue;
    const year = Number(trimmed.slice(0, 4));
    const set = out.get(year) ?? new Set<string>();
    set.add(trimmed);
    out.set(year, set);
  }
  return out as ReadonlyMap<number, ReadonlySet<string>>;
};

/** 单 entry 映射 + §6.4 收盘价修正。 */
function mapAndCorrectEntry(raw: LimitUpLadderRawEntry, date: string): LimitUpLadderEntry {
  const code = raw.code;
  const preClose = raw.pre_close ?? 0;
  const pct = preClose > 0 ? (raw.close - preClose) / preClose : 0;

  let price = raw.close;
  let corrected = false;
  if (raw.high !== undefined && raw.close === raw.high && pct >= 0.098 && pct < 0.1) {
    price = preClose * 1.0858;
    corrected = true;
  }

  return {
    code,
    name: raw.name?.trim() ?? code,
    industry: raw.industry?.trim() ?? 'unclassified',
    ladderLevel: raw.level ?? 1,
    uncategorized: raw.level === undefined,
    firstTime: raw.first_time ?? null,
    finalTime: raw.final_time ?? null,
    reason: raw.reason ?? '--',
    price,
    rawClose: raw.close,
    corrected,
    changePct: pct,
    limitUpDate: raw.limit_up_date ?? date,
    board: deriveBoard(code),
  };
}

/**
 * entry 级展示过滤（设计 §4.3：cache key 不含 includeUncategorized，
 * 缓存里始终保留完整 ladder，返回前再按该开关剔除 uncategorized entry）。
 */
function applyDisplayFilter(ladder: LimitUpLadder, includeUncategorized: boolean): LimitUpLadder {
  if (includeUncategorized) return ladder;
  if (!ladder.levels.some((lv) => lv.stocks.some((s) => s.uncategorized))) return ladder;
  const entries = ladder.levels.flatMap((lv) => lv.stocks).filter((s) => !s.uncategorized);
  return assembleLadder(ladder.date, ladder.source, entries, ladder.warnings, ladder.asOf);
}

function cacheKey(query: LimitUpLadderQuery, source: LimitUpLadderSource): string {
  return [
    query.date,
    source,
    query.includeStar ? 's' : '',
    query.includeBse ? 'b' : '',
    query.includeST ? 't' : '',
    `days=${query.days}`,
  ].join('|');
}

function computeTtl(queryDate: string, now: Date, dateInShanghaiFn: (d: Date) => string): number {
  if (queryDate !== dateInShanghaiFn(now)) return Infinity;
  const shanghaiMs = now.getTime() + SHANGHAI_OFFSET_MS;
  const sh = new Date(shanghaiMs);
  const minutes = sh.getUTCHours() * 60 + sh.getUTCMinutes();
  const inSession =
    (minutes >= 9 * 60 + 30 && minutes < 11 * 60 + 30) || (minutes >= 13 * 60 && minutes < 15 * 60);
  return inSession ? 60_000 : Infinity;
}

function errorResult(message: string): LimitUpLadderResult {
  return {
    ok: false,
    error: {
      kind: 'adapter_error',
      adapter: 'limit-up-ladder',
      message,
      recoverable: false,
    },
  };
}

export class LimitUpLadderManager {
  readonly name = 'limit-up-ladder' as const;

  private readonly primary: LimitUpLadderAdapterLike;
  private readonly fallback: LimitUpLadderAdapterLike | undefined;
  private readonly logger: Logger;
  private readonly clock: () => Date;
  private readonly cache: LRU<string, LimitUpLadder>;
  private readonly enricher: LimitUpPoolEnricherLike | undefined;
  private readonly holidaysProvider: () => Promise<ReadonlyMap<number, ReadonlySet<string>>>;
  private readonly dateInShanghaiFn: (d: Date) => string;
  private readonly isWeekendFn: (d: Date) => boolean;
  private readonly isHolidayFn: (d: Date, h: ReadonlyMap<number, ReadonlySet<string>>) => boolean;

  private holidays: ReadonlyMap<number, ReadonlySet<string>> | undefined;
  private holidaysLoading: Promise<ReadonlyMap<number, ReadonlySet<string>>> | undefined;

  constructor(opts: ManagerOptions) {
    this.primary = opts.primary;
    this.fallback = opts.fallback;
    this.logger = opts.logger;
    this.clock = opts.clock;
    this.cache = new LRU<string, LimitUpLadder>(512);
    this.enricher = opts.enricher;
    this.holidaysProvider = opts.holidaysProvider ?? defaultHolidaysProvider;
    this.dateInShanghaiFn = opts.dateInShanghaiFn ?? defaultDateInShanghai;
    this.isWeekendFn = opts.isWeekendFn ?? defaultIsWeekend;
    this.isHolidayFn = opts.isHolidayFn ?? defaultIsHoliday;
  }

  /** 用涨停池按 code 补齐 firstTime/finalTime/industry；只填空字段，不覆盖主源已有值。 */
  private async enrichEntries(entries: LimitUpLadderEntry[], date: string): Promise<void> {
    if (this.enricher === undefined || entries.length === 0) return;
    let pool: ReadonlyMap<string, LimitUpPoolEnrichment>;
    try {
      pool = await this.enricher.fetchPool(date);
    } catch (err) {
      this.logger.warn('limit-up-ladder enricher failed', {
        enricher: this.enricher.name,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    for (const e of entries) {
      const extra = pool.get(e.code);
      if (extra === undefined) continue;
      if (e.firstTime === null && extra.firstTime !== undefined) e.firstTime = extra.firstTime;
      if (e.finalTime === null && extra.finalTime !== undefined) e.finalTime = extra.finalTime;
      if (
        e.industry === LimitUpLadderSentinels.BOARD_UNCLASSIFIED &&
        extra.industry !== undefined
      ) {
        e.industry = extra.industry;
      }
    }
  }

  private async getHolidays(): Promise<ReadonlyMap<number, ReadonlySet<string>>> {
    if (this.holidays !== undefined) return this.holidays;
    if (this.holidaysLoading === undefined) {
      this.holidaysLoading = this.holidaysProvider();
    }
    this.holidays = await this.holidaysLoading;
    return this.holidays;
  }

  private isTradingDay(date: string): boolean {
    const d = new Date(`${date}T00:00:00Z`);
    if (this.isWeekendFn(d)) return false;
    if (this.holidays !== undefined && this.isHolidayFn(d, this.holidays)) return false;
    return true;
  }

  async fetchLadder(query: LimitUpLadderQuery): Promise<LimitUpLadderResult> {
    const { date, source, days, includeStar, includeBse, includeST, includeUncategorized } = query;
    const key = cacheKey(query, source);
    const now = this.clock();

    // 确保节假日历加载完毕再判定交易日
    if (this.holidays === undefined) {
      await this.getHolidays();
    }

    // 缓存命中（LRU 内部校验 TTL；Infinity written 永不失效）
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return { ok: true, data: applyDisplayFilter(cached, includeUncategorized) };
    }

    const ttl = computeTtl(date, now, this.dateInShanghaiFn);

    // 非交易日：直接返回空 ladder（不调远端）
    if (!this.isTradingDay(date)) {
      const empty = assembleLadder(date, source, [], ['non-trading-day'], now);
      this.cache.set(key, empty, undefined);
      return { ok: true, data: empty };
    }

    // 主源
    let rawResult: { date: string; entries: LimitUpLadderRawEntry[] };
    try {
      rawResult = await this.primary.fetchLadder(date, { days });
    } catch (err) {
      this.logger.warn('limit-up-ladder primary adapter failed', {
        adapter: this.primary.name,
        error: err instanceof Error ? err.message : String(err),
      });
      if (this.fallback === undefined) {
        return errorResult(
          `primary ${this.primary.name} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      try {
        rawResult = await this.fallback.fetchLadder(date, { days });
        this.logger.info('limit-up-ladder fallback succeeded', {
          adapter: this.fallback.name,
        });
      } catch (fallbackErr) {
        this.logger.error('limit-up-ladder fallback also failed', {
          adapter: this.fallback.name,
          error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
        });
        return errorResult(
          `primary and fallback both failed: ${
            fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
          }`,
        );
      }
    }

    // 映射 + 修正 + 过滤 + 去重
    const mapped = rawResult.entries.map((e) => mapAndCorrectEntry(e, date));
    await this.enrichEntries(mapped, date);
    const filtered = filterAndDedupeEntries(mapped, {
      includeStar,
      includeBse,
      includeST,
    });

    const warnings: string[] = [];
    const correctedCount = filtered.filter((e) => e.corrected).length;
    if (correctedCount > 0) warnings.push(`corrected entries: ${correctedCount}`);
    if (filtered.length === 0) warnings.push('empty-ladder');
    if (mapped.length > filtered.length) {
      warnings.push(`filtered: ${mapped.length - filtered.length} entries`);
    }

    const ladder = assembleLadder(date, source, filtered, warnings, now);

    // 空 ladder（盘前 / 数据未更新）不允许长期缓存：否则盘前查一次，全天都停留在 empty-ladder
    const effectiveTtl = filtered.length === 0 ? Math.min(ttl, 60_000) : ttl;
    this.cache.set(key, ladder, effectiveTtl === Infinity ? undefined : effectiveTtl);

    return { ok: true, data: applyDisplayFilter(ladder, includeUncategorized) };
  }

  async compareLadder(
    date: string,
    prevDate: string,
    query: Omit<LimitUpLadderQuery, 'date'>,
  ): Promise<
    | {
        ok: true;
        data: {
          curr: LimitUpLadder;
          prev: LimitUpLadder;
          diff: LimitUpLadderDiff;
        };
      }
    | {
        ok: false;
        error: {
          kind: string;
          adapter: string;
          message: string;
          recoverable: boolean;
        };
      }
  > {
    const [currResult, prevResult] = await Promise.all([
      this.fetchLadder({ ...query, date }),
      this.fetchLadder({ ...query, date: prevDate }),
    ]);

    if (!currResult.ok) return currResult;
    if (!prevResult.ok) return prevResult;

    const diff = diffTopLevel(currResult.data, prevResult.data);
    return {
      ok: true,
      data: { curr: currResult.data, prev: prevResult.data, diff },
    };
  }
}
