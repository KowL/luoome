import {
  type DailyBar,
  type DailyBarRepository,
  type DailyBarRevision,
  DailyBarRevisionSchema,
  DailyBarSchema,
} from '@luoome/core';
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { dailyBarRevisions, dailyBars, type Schema } from '../../schema/index.js';

type BarRow = typeof dailyBars.$inferSelect;

const toBar = (row: BarRow): DailyBar => ({
  stockId: row.stockId,
  date: row.date,
  open: row.open,
  high: row.high,
  low: row.low,
  close: row.close,
  volume: row.volume,
  adjustment: 'qfq',
  ...(row.sourceAdjFactor === null ? {} : { sourceAdjFactor: row.sourceAdjFactor }),
  source: row.source,
});

/**
 * DailyBar 的 Drizzle 实现。
 * daily_bars 的复合主键 (stockId, date) → 同日重复写入视为覆盖。
 */
export class DrizzleDailyBarRepository implements DailyBarRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async saveMany(bars: readonly DailyBar[]): Promise<void> {
    if (bars.length === 0) return;
    const rows = bars.map((input) => {
      const b = DailyBarSchema.parse(input);
      return {
        stockId: b.stockId,
        date: b.date,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        legacyAdjFactor: b.sourceAdjFactor ?? 1,
        adjustment: b.adjustment,
        sourceAdjFactor: b.sourceAdjFactor,
        source: b.source,
      };
    });
    // 批量 upsert：set 用 SQLite excluded.<column> 引用「本次 VALUES 里对应行的值」，
    // 冲突时每个 (stockId, date) 各自更新自己的 OHLCV / source；
    // 不能用统一常量 set（首行值会覆盖整批其它日期）。
    this.db
      .insert(dailyBars)
      .values(rows)
      .onConflictDoUpdate({
        target: [dailyBars.stockId, dailyBars.date],
        set: {
          open: sql`excluded."open"`,
          high: sql`excluded."high"`,
          low: sql`excluded."low"`,
          close: sql`excluded."close"`,
          volume: sql`excluded."volume"`,
          legacyAdjFactor: sql`excluded."adj_factor"`,
          adjustment: sql`excluded."adjustment"`,
          sourceAdjFactor: sql`excluded."source_adj_factor"`,
          source: sql`excluded."source"`,
        },
      })
      .run();
  }

  async findInRange(stockId: string, from: Date, to: Date): Promise<DailyBar[]> {
    return this.db
      .select()
      .from(dailyBars)
      .where(
        and(
          eq(dailyBars.stockId, stockId),
          eq(dailyBars.adjustment, 'qfq'),
          gte(dailyBars.date, from),
          lte(dailyBars.date, to),
        ),
      )
      .orderBy(dailyBars.date)
      .all()
      .map(toBar);
  }

  async latestBefore(stockId: string, to: Date, count: number): Promise<DailyBar[]> {
    if (count <= 0) return [];
    const descRows = this.db
      .select()
      .from(dailyBars)
      .where(
        and(
          eq(dailyBars.stockId, stockId),
          eq(dailyBars.adjustment, 'qfq'),
          lte(dailyBars.date, to),
        ),
      )
      .orderBy(desc(dailyBars.date))
      .limit(count)
      .all()
      .map(toBar);
    return descRows.reverse();
  }

  async removeInRange(stockId: string, before: Date): Promise<number> {
    const beforeRows = this.db
      .select({ stockId: dailyBars.stockId, date: dailyBars.date })
      .from(dailyBars)
      .where(and(eq(dailyBars.stockId, stockId), lte(dailyBars.date, before)))
      .all();
    this.db
      .delete(dailyBars)
      .where(and(eq(dailyBars.stockId, stockId), lte(dailyBars.date, before)))
      .run();
    return beforeRows.length;
  }

  async saveRevisions(revisions: readonly DailyBarRevision[]): Promise<void> {
    if (revisions.length === 0) return;
    const parsed = revisions
      .map((revision) => DailyBarRevisionSchema.parse(revision))
      .sort(
        (left, right) =>
          left.recordedAt.getTime() - right.recordedAt.getTime() ||
          left.stockId.localeCompare(right.stockId) ||
          left.date.getTime() - right.date.getTime() ||
          left.contentHash.localeCompare(right.contentHash),
      );
    this.db.transaction((tx) => {
      const byStock = new Map<string, DailyBarRevision[]>();
      for (const revision of parsed) {
        byStock.set(revision.stockId, [...(byStock.get(revision.stockId) ?? []), revision]);
      }
      for (const [stockId, stockRevisions] of byStock) {
        const dates = stockRevisions.map((revision) => revision.date.getTime());
        const existing = tx
          .select()
          .from(dailyBarRevisions)
          .where(
            and(
              eq(dailyBarRevisions.stockId, stockId),
              gte(dailyBarRevisions.date, new Date(Math.min(...dates))),
              lte(dailyBarRevisions.date, new Date(Math.max(...dates))),
            ),
          )
          .orderBy(
            dailyBarRevisions.date,
            dailyBarRevisions.recordedAt,
            dailyBarRevisions.contentHash,
          )
          .all();
        const latestByDate = new Map<number, (typeof existing)[number]>();
        for (const revision of existing) latestByDate.set(revision.date.getTime(), revision);
        const inserts: DailyBarRevision[] = [];
        for (const revision of stockRevisions) {
          const dateKey = revision.date.getTime();
          const latest = latestByDate.get(dateKey);
          if (
            latest !== undefined &&
            latest.recordedAt.getTime() <= revision.recordedAt.getTime() &&
            latest.contentHash === revision.contentHash
          ) {
            continue;
          }
          inserts.push(revision);
          if (
            latest === undefined ||
            revision.recordedAt.getTime() > latest.recordedAt.getTime() ||
            (revision.recordedAt.getTime() === latest.recordedAt.getTime() &&
              revision.contentHash.localeCompare(latest.contentHash) > 0)
          ) {
            latestByDate.set(dateKey, revision);
          }
        }
        if (inserts.length > 0) {
          tx.insert(dailyBarRevisions).values(inserts).onConflictDoNothing().run();
        }
      }
    });
  }

  async listRevisions(input: {
    readonly stockId: string;
    readonly from?: Date;
    readonly to?: Date;
    readonly recordedAt?: Date;
  }): Promise<readonly DailyBarRevision[]> {
    const conditions = [eq(dailyBarRevisions.stockId, input.stockId)];
    if (input.from !== undefined) conditions.push(gte(dailyBarRevisions.date, input.from));
    if (input.to !== undefined) conditions.push(lte(dailyBarRevisions.date, input.to));
    if (input.recordedAt !== undefined) {
      conditions.push(lte(dailyBarRevisions.recordedAt, input.recordedAt));
    }
    return this.db
      .select()
      .from(dailyBarRevisions)
      .where(and(...conditions))
      .orderBy(dailyBarRevisions.date, dailyBarRevisions.recordedAt, dailyBarRevisions.contentHash)
      .all()
      .map((row) => ({
        stockId: row.stockId,
        date: row.date,
        contentHash: row.contentHash,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        source: row.source,
        recordedAt: row.recordedAt,
      }));
  }

  async listRevisionsForStocks(input: {
    readonly stockIds: readonly string[];
    readonly from?: Date;
    readonly to?: Date;
    readonly recordedAt?: Date;
  }): Promise<readonly DailyBarRevision[]> {
    const stockIds = [...new Set(input.stockIds)].sort();
    if (stockIds.length === 0) return [];
    const rows: (typeof dailyBarRevisions.$inferSelect)[] = [];
    for (let index = 0; index < stockIds.length; index += 400) {
      const chunk = stockIds.slice(index, index + 400);
      const conditions = [inArray(dailyBarRevisions.stockId, chunk)];
      if (input.from !== undefined) conditions.push(gte(dailyBarRevisions.date, input.from));
      if (input.to !== undefined) conditions.push(lte(dailyBarRevisions.date, input.to));
      if (input.recordedAt !== undefined) {
        conditions.push(lte(dailyBarRevisions.recordedAt, input.recordedAt));
      }
      rows.push(
        ...this.db
          .select()
          .from(dailyBarRevisions)
          .where(and(...conditions))
          .all(),
      );
    }
    return rows
      .sort(
        (left, right) =>
          left.stockId.localeCompare(right.stockId) ||
          left.date.getTime() - right.date.getTime() ||
          left.recordedAt.getTime() - right.recordedAt.getTime() ||
          left.contentHash.localeCompare(right.contentHash),
      )
      .map((row) => ({
        stockId: row.stockId,
        date: row.date,
        contentHash: row.contentHash,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        source: row.source,
        recordedAt: row.recordedAt,
      }));
  }
}
