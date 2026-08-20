import {
  BUILTIN_HOLIDAYS,
  dateInShanghai,
  isHoliday,
  isWeekend,
  type LimitUpLadder,
  type LimitUpLadderEntry,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

const RecentLimitUpSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ladderLevel: z.number().int().positive(),
  reason: z.string(),
  firstTime: z.string().nullable(),
  finalTime: z.string().nullable(),
  corrected: z.boolean(),
});

export const StockLimitUpFactsSchema = z.object({
  stockId: z.string().min(1),
  code: z.string().regex(/^\d{6}$/),
  status: z.enum(['complete', 'partial', 'unavailable']),
  coverage: z.literal('CN_A_SHARES_SH_SZ'),
  source: z.literal('eastmoney'),
  today: RecentLimitUpSchema.nullable(),
  recent: z.array(RecentLimitUpSchema).max(30),
  dataAsOf: z.coerce.date().nullable(),
  fetchedAt: z.coerce.date().nullable(),
  missingDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(30),
  warnings: z.array(z.string()),
});

export type StockLimitUpFacts = z.infer<typeof StockLimitUpFactsSchema>;

const toDate = (base: string, delta: number): string => {
  const date = new Date(`${base}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - delta);
  return date.toISOString().slice(0, 10);
};

const recentTradingDates = (anchorDate: string, count: number): string[] => {
  const dates: string[] = [];
  for (let offset = 0; dates.length < count; offset += 1) {
    const value = toDate(anchorDate, offset);
    const instant = new Date(`${value}T00:00:00.000Z`);
    if (!isWeekend(instant) && !isHoliday(instant, BUILTIN_HOLIDAYS)) dates.push(value);
  }
  return dates;
};

const entryFor = (entry: LimitUpLadderEntry): z.infer<typeof RecentLimitUpSchema> => ({
  date: entry.limitUpDate,
  ladderLevel: entry.ladderLevel,
  reason: entry.reason,
  firstTime: entry.firstTime,
  finalTime: entry.finalTime,
  corrected: entry.corrected,
});

const usableSnapshot = (warnings: readonly string[]): boolean =>
  !warnings.includes('empty-ladder') && !warnings.includes('non-trading-day');

const dataCutoffFor = (snapshot: LimitUpLadder): Date => {
  const close = new Date(`${snapshot.date}T15:00:00.000+08:00`);
  return snapshot.asOf.getTime() < close.getTime() ? snapshot.asOf : close;
};

/** 历史日期只读取 PIT snapshot；当天交互视图可读取 manager，不能现场回拉远端补历史。 */
export const loadStockLimitUpFacts = async (
  stockId: string,
  code: string,
  anchorDate: string,
  ctx: ToolContext,
): Promise<StockLimitUpFacts> => {
  const warnings: string[] = [];
  const rows: Array<z.infer<typeof RecentLimitUpSchema>> = [];
  const missingDates: string[] = [];
  let covered = 0;
  let latestDataAsOf: Date | null = null;
  let latestFetchedAt: Date | null = null;
  const dates = recentTradingDates(anchorDate, 30);
  const currentDate = currentLimitUpDate(ctx);
  const concurrency = 4;
  for (let start = 0; start < dates.length; start += concurrency) {
    const batch = dates.slice(start, start + concurrency);
    const results = await Promise.all(
      batch.map(async (date) => {
        if (anchorDate === currentDate && date === currentDate) {
          if (ctx.limitUpLadder === undefined) {
            return { date, snapshot: null, warning: 'current-manager-unavailable' };
          }
          const result = await ctx.limitUpLadder.fetchLadder({
            date,
            source: 'eastmoney',
            days: 30,
            includeUncategorized: false,
            includeStar: false,
            includeBse: false,
            includeST: false,
          });
          if (!result.ok || result.data === undefined) {
            return {
              date,
              snapshot: null,
              warning: result.error?.message ?? 'current-manager-unavailable',
            };
          }
          return { date, snapshot: result.data };
        }
        return {
          date,
          snapshot: await ctx.repos.limitUpLadderSnapshot.findByDate({
            date,
            source: 'eastmoney',
          }),
        };
      }),
    );
    for (const { date, snapshot, warning } of results) {
      if (snapshot === null || !usableSnapshot(snapshot.warnings)) {
        missingDates.push(date);
        if (warning !== undefined) warnings.push(`${date}: ${warning}`);
        continue;
      }
      covered += 1;
      const dataAsOf = dataCutoffFor(snapshot);
      if (latestDataAsOf === null || dataAsOf.getTime() > latestDataAsOf.getTime()) {
        latestDataAsOf = dataAsOf;
      }
      if (latestFetchedAt === null || snapshot.asOf.getTime() > latestFetchedAt.getTime()) {
        latestFetchedAt = snapshot.asOf;
      }
      const match = snapshot.levels
        .flatMap((level) => level.stocks)
        .find((entry) => entry.code === code);
      if (match !== undefined) rows.push(entryFor(match));
      if (snapshot.warnings.length > 0) warnings.push(`${date}: ${snapshot.warnings.join(', ')}`);
    }
  }
  const recent = [...new Map(rows.map((row) => [row.date, row])).values()]
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, 30);
  const today = recent.find((row) => row.date === anchorDate) ?? null;
  return StockLimitUpFactsSchema.parse({
    stockId,
    code,
    status: covered === 0 ? 'unavailable' : missingDates.length === 0 ? 'complete' : 'partial',
    coverage: 'CN_A_SHARES_SH_SZ',
    source: 'eastmoney',
    today,
    recent,
    dataAsOf: latestDataAsOf,
    fetchedAt: latestFetchedAt,
    missingDates,
    warnings: [
      ...new Set([
        ...warnings,
        ...(missingDates.length === 0 ? [] : [`pit-snapshots-missing:${missingDates.length}`]),
      ]),
    ],
  });
};

export const currentLimitUpDate = (ctx: ToolContext): string => dateInShanghai(ctx.clock());
