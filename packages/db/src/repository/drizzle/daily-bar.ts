import {
  type AdjustmentFactor,
  type DailyBar,
  type DailyBarRepository,
  DailyBarSchema,
  money,
  type RawDailyBar,
  RawDailyBarSchema,
} from '@luoome/core';
import { and, asc, desc, eq, gt, gte, lte, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { adjustmentFactors, dailyBars, type Schema } from '../../schema/index.js';

type BarRow = typeof dailyBars.$inferSelect;

/**
 * 前复权投影：`cum(t) = ∏{factor | exDate > t}`，因子按 exDate 升序。
 *
 * factor 是 `除权价 / 前收盘`（≤1），所以越早的日期累计因子越小，最新一根恒为 1。
 */
export const cumulativeAdjustmentFactor = (
  factors: readonly Pick<AdjustmentFactor, 'exDate' | 'factor'>[],
  date: Date,
): number => {
  let cum = 1;
  for (const item of factors) {
    if (item.exDate.getTime() > date.getTime()) cum *= item.factor;
  }
  return cum;
};

const toBar = (row: BarRow, cum: number): DailyBar =>
  DailyBarSchema.parse({
    stockId: row.stockId,
    date: row.date,
    open: money(row.open * cum),
    high: money(row.high * cum),
    low: money(row.low * cum),
    close: money(row.close * cum),
    volume: row.volume,
    adjustment: 'qfq',
    ...(row.sourceAdjFactor === null ? {} : { sourceAdjFactor: row.sourceAdjFactor }),
    source: row.source,
  });

/**
 * 因子表尚未初始化时写入的 qfq 行：原值缓存、原值读回。
 *
 * 这类行没有可用的累计因子（provider 未给 `sourceAdjFactor`，本地也还没有因子事件），
 * 强行换算会把 qfq 当成原始价，之后因子到达就会二次复权。它只是过渡缓存：市场 dump
 * 的原始价一旦覆盖同一 (stockId, date)，该行即被替换。
 */
const toProvisionalBar = (row: BarRow): DailyBar =>
  DailyBarSchema.parse({
    stockId: row.stockId,
    date: row.date,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    adjustment: 'qfq',
    source: row.source,
  });

/**
 * DailyBar 的 Drizzle 实现。
 *
 * 存储口径是**原始价**（`adjustment='raw'`）；读写边界做前复权投影：`saveMany` 把领域层的
 * qfq 按当时因子还原成原始价，`findInRange`/`latestBefore` 再投影回 qfq。调用方只看到 qfq。
 */
export class DrizzleDailyBarRepository implements DailyBarRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  private loadFactors(stockId: string, since: Date): AdjustmentFactor[] {
    return this.db
      .select()
      .from(adjustmentFactors)
      .where(and(eq(adjustmentFactors.stockId, stockId), gt(adjustmentFactors.exDate, since)))
      .orderBy(asc(adjustmentFactors.exDate))
      .all()
      .map((row) => ({
        stockId: row.stockId,
        exDate: row.exDate,
        factor: row.factor,
        dividendPerShare: row.dividendPerShare,
        perShareBonus: row.perShareBonus,
        allotmentRatio: row.allotmentRatio,
        allotmentPrice: row.allotmentPrice,
        source: row.source,
      }));
  }

  /** 因子表是否已由全量 dump 初始化；空表无法区分「无除权事件」与「尚未同步」。 */
  private hasAnyFactor(): boolean {
    return this.db.select({ one: sql`1` }).from(adjustmentFactors).limit(1).get() !== undefined;
  }

  async saveMany(bars: readonly DailyBar[]): Promise<void> {
    if (bars.length === 0) return;
    const parsed = bars.map((bar) => DailyBarSchema.parse(bar));
    const byStock = new Map<string, DailyBar[]>();
    for (const bar of parsed) {
      const existing = byStock.get(bar.stockId);
      if (existing === undefined) byStock.set(bar.stockId, [bar]);
      else existing.push(bar);
    }
    const factorsInitialized = this.hasAnyFactor();
    const rows: (typeof dailyBars.$inferInsert)[] = [];
    for (const [stockId, stockBars] of byStock) {
      const qfqBars = stockBars.filter((bar) => bar.sourceAdjFactor === undefined);
      const earliest = Math.min(...qfqBars.map((bar) => bar.date.getTime()));
      const factors = qfqBars.length === 0 ? [] : this.loadFactors(stockId, new Date(earliest));
      for (const bar of stockBars) {
        const toRaw = (factor: number) => ({
          stockId: bar.stockId,
          date: bar.date,
          open: money(bar.open / factor),
          high: money(bar.high / factor),
          low: money(bar.low / factor),
          close: money(bar.close / factor),
          volume: bar.volume,
          legacyAdjFactor: 1,
          adjustment: 'raw' as const,
          sourceAdjFactor: bar.sourceAdjFactor ?? null,
          source: bar.source,
        });
        if (bar.sourceAdjFactor !== undefined) {
          rows.push(toRaw(bar.sourceAdjFactor));
          continue;
        }
        // 因子表未初始化时不能假设 cum=1：qfq 原值缓存，等 dump 的原始价覆盖。
        if (!factorsInitialized) {
          rows.push({
            stockId: bar.stockId,
            date: bar.date,
            open: money(bar.open),
            high: money(bar.high),
            low: money(bar.low),
            close: money(bar.close),
            volume: bar.volume,
            legacyAdjFactor: 1,
            adjustment: 'qfq',
            sourceAdjFactor: null,
            source: bar.source,
          });
          continue;
        }
        rows.push(toRaw(cumulativeAdjustmentFactor(factors, bar.date)));
      }
    }
    // 批量 upsert：set 用 SQLite excluded.<column> 引用「本次 VALUES 里对应行的值」，
    // 冲突时每个 (stockId, date) 各自更新自己的 OHLCV / source；按 500 行分块控制绑定参数。
    for (let index = 0; index < rows.length; index += 500) {
      this.db
        .insert(dailyBars)
        .values(rows.slice(index, index + 500))
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
  }

  async findInRange(stockId: string, from: Date, to: Date): Promise<DailyBar[]> {
    const rows = this.db
      .select()
      .from(dailyBars)
      .where(
        and(eq(dailyBars.stockId, stockId), gte(dailyBars.date, from), lte(dailyBars.date, to)),
      )
      .orderBy(asc(dailyBars.date))
      .all();
    if (rows.length === 0) return [];
    const factors = this.loadFactors(stockId, from);
    return rows.map((row) =>
      row.adjustment === 'raw'
        ? toBar(row, cumulativeAdjustmentFactor(factors, row.date))
        : toProvisionalBar(row),
    );
  }

  async latestBefore(stockId: string, to: Date, count: number): Promise<DailyBar[]> {
    if (count <= 0) return [];
    const descRows = this.db
      .select()
      .from(dailyBars)
      .where(and(eq(dailyBars.stockId, stockId), lte(dailyBars.date, to)))
      .orderBy(desc(dailyBars.date))
      .limit(count)
      .all();
    if (descRows.length === 0) return [];
    const earliest = descRows[descRows.length - 1]?.date ?? to;
    const factors = this.loadFactors(stockId, earliest);
    return descRows
      .reverse()
      .map((row) =>
        row.adjustment === 'raw'
          ? toBar(row, cumulativeAdjustmentFactor(factors, row.date))
          : toProvisionalBar(row),
      );
  }

  async saveRawMany(bars: readonly RawDailyBar[]): Promise<void> {
    if (bars.length === 0) return;
    const rows = bars.map((input) => {
      const bar = RawDailyBarSchema.parse(input);
      return {
        stockId: bar.stockId,
        date: bar.date,
        open: money(bar.open),
        high: money(bar.high),
        low: money(bar.low),
        close: money(bar.close),
        volume: bar.volume,
        legacyAdjFactor: 1,
        adjustment: 'raw' as const,
        sourceAdjFactor: null,
        source: bar.source,
      };
    });
    // 单条 INSERT 的绑定参数上限是 32766，按 500 行分块（500 × 11 列）。
    for (let index = 0; index < rows.length; index += 500) {
      this.db
        .insert(dailyBars)
        .values(rows.slice(index, index + 500))
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
  }

  async latestRawBefore(stockId: string, to: Date): Promise<RawDailyBar | null> {
    const row = this.db
      .select()
      .from(dailyBars)
      .where(
        and(
          eq(dailyBars.stockId, stockId),
          eq(dailyBars.adjustment, 'raw'),
          lte(dailyBars.date, to),
        ),
      )
      .orderBy(desc(dailyBars.date))
      .limit(1)
      .get();
    return row === undefined
      ? null
      : {
          stockId: row.stockId,
          date: row.date,
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume: row.volume,
          source: row.source,
        };
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
