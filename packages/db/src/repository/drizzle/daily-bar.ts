import type { DailyBar, DailyBarRepository } from '@luoome/core';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { dailyBars, type Schema } from '../../schema/index.js';

type BarRow = typeof dailyBars.$inferSelect;

const toBar = (row: BarRow): DailyBar => ({
  stockId: row.stockId,
  date: row.date,
  open: row.open,
  high: row.high,
  low: row.low,
  close: row.close,
  volume: row.volume,
  adjFactor: row.adjFactor,
});

/**
 * DailyBar 的 Drizzle 实现。
 * daily_bars 的复合主键 (stockId, date) → 同日重复写入视为覆盖。
 */
export class DrizzleDailyBarRepository implements DailyBarRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async saveMany(bars: readonly DailyBar[]): Promise<void> {
    if (bars.length === 0) return;
    const rows = bars.map((b) => ({
      stockId: b.stockId,
      date: b.date,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
      adjFactor: b.adjFactor,
      source: 'eastmoney', // v0.2 默认源标识；调用方可在 adapter 层覆盖
    }));
    // onConflictDoUpdate.set 必须是「要被覆盖的列 → 新值」；
    // 主键列 (stockId, date) 已在 target 里，set 里重复会触发 TS 报错。
    // rows.length > 0 已在 if 分支守门；此处 destructure 后断言首元素存在。
    const [first] = rows;
    if (first === undefined) return; // 编译期 exhaustive；运行时永不达
    const set = {
      open: first.open,
      high: first.high,
      low: first.low,
      close: first.close,
      volume: first.volume,
      adjFactor: first.adjFactor,
    };
    this.db
      .insert(dailyBars)
      .values(rows)
      .onConflictDoUpdate({ target: [dailyBars.stockId, dailyBars.date], set })
      .run();
  }

  async findInRange(stockId: string, from: Date, to: Date): Promise<DailyBar[]> {
    return this.db
      .select()
      .from(dailyBars)
      .where(
        and(eq(dailyBars.stockId, stockId), gte(dailyBars.date, from), lte(dailyBars.date, to)),
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
      .where(and(eq(dailyBars.stockId, stockId), lte(dailyBars.date, to)))
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
}
