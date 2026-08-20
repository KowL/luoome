import {
  dateInShanghai,
  type MinuteBar,
  type MinuteBarInterval,
  type MinuteBarRepository,
  MinuteBarSchema,
} from '@luoome/core';
import { and, desc, eq, gte, lt, lte, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { minuteBars, type Schema } from '../../schema/index.js';

type MinuteBarRow = typeof minuteBars.$inferSelect;

const toMinuteBar = (row: MinuteBarRow): MinuteBar => ({
  stockId: row.stockId,
  interval: row.interval,
  endedAt: row.endedAt,
  open: row.open,
  high: row.high,
  low: row.low,
  close: row.close,
  volume: row.volume,
  ...(row.amount === null ? {} : { amount: row.amount }),
  adjustment: 'raw',
  source: row.source,
  fetchedAt: row.fetchedAt,
  completeness: row.completeness,
});

const shanghaiDayRange = (date: Date): { readonly from: Date; readonly to: Date } => {
  const day = dateInShanghai(date);
  const from = new Date(`${day}T00:00:00+08:00`);
  return { from, to: new Date(from.getTime() + 86_400_000 - 1) };
};

export class DrizzleMinuteBarRepository implements MinuteBarRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async saveMany(bars: readonly MinuteBar[]): Promise<void> {
    if (bars.length === 0) return;
    const rows = bars.map((bar) => {
      const parsed = MinuteBarSchema.parse(bar);
      return {
        stockId: parsed.stockId,
        interval: parsed.interval,
        endedAt: parsed.endedAt,
        open: parsed.open,
        high: parsed.high,
        low: parsed.low,
        close: parsed.close,
        volume: parsed.volume,
        amount: parsed.amount,
        adjustment: parsed.adjustment,
        source: parsed.source,
        fetchedAt: parsed.fetchedAt,
        completeness: parsed.completeness,
      };
    });
    this.db
      .insert(minuteBars)
      .values(rows)
      .onConflictDoUpdate({
        target: [minuteBars.stockId, minuteBars.interval, minuteBars.endedAt],
        set: {
          open: sql`excluded."open"`,
          high: sql`excluded."high"`,
          low: sql`excluded."low"`,
          close: sql`excluded."close"`,
          volume: sql`excluded."volume"`,
          amount: sql`excluded."amount"`,
          adjustment: sql`excluded."adjustment"`,
          source: sql`excluded."source"`,
          fetchedAt: sql`excluded."fetched_at"`,
          completeness: sql`excluded."completeness"`,
        },
      })
      .run();
  }

  async findInRange(
    stockId: string,
    interval: MinuteBarInterval,
    from: Date,
    to: Date,
  ): Promise<MinuteBar[]> {
    return this.db
      .select()
      .from(minuteBars)
      .where(
        and(
          eq(minuteBars.stockId, stockId),
          eq(minuteBars.interval, interval),
          gte(minuteBars.endedAt, from),
          lte(minuteBars.endedAt, to),
        ),
      )
      .orderBy(minuteBars.endedAt)
      .all()
      .map(toMinuteBar);
  }

  async latestSession(stockId: string, interval: MinuteBarInterval): Promise<MinuteBar[]> {
    const latest = this.db
      .select({ endedAt: minuteBars.endedAt })
      .from(minuteBars)
      .where(and(eq(minuteBars.stockId, stockId), eq(minuteBars.interval, interval)))
      .orderBy(desc(minuteBars.endedAt))
      .limit(1)
      .get();
    if (latest === undefined) return [];
    const range = shanghaiDayRange(latest.endedAt);
    return this.findInRange(stockId, interval, range.from, range.to);
  }

  async removeBefore(before: Date): Promise<number> {
    const rows = this.db
      .select({ endedAt: minuteBars.endedAt })
      .from(minuteBars)
      .where(lt(minuteBars.endedAt, before))
      .all();
    this.db.delete(minuteBars).where(lt(minuteBars.endedAt, before)).run();
    return rows.length;
  }
}
