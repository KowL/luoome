import type { Quote, QuoteRepository } from '@luoome/core';
import { and, desc, eq, gte, inArray, lte, max } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { priceSnapshots, type Schema } from '../../schema/index.js';

type QuoteRow = typeof priceSnapshots.$inferSelect;

/** 行 ↔ 实体映射（Date ↔ timestamp_ms 自动转换由 schema 声明完成）。 */
const toQuote = (row: QuoteRow): Quote => ({
  stockId: row.stockId,
  ts: row.ts,
  open: row.open,
  high: row.high,
  low: row.low,
  close: row.close,
  volume: row.volume,
  source: row.source,
});

/**
 * Quote 的 Drizzle 实现。
 * price_snapshots 的复合主键 (stockId, ts) → 同 ts 重复写入视为覆盖。
 */
export class DrizzleQuoteRepository implements QuoteRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(quote: Quote): Promise<void> {
    this.db
      .insert(priceSnapshots)
      .values({
        stockId: quote.stockId,
        ts: quote.ts,
        open: quote.open,
        high: quote.high,
        low: quote.low,
        close: quote.close,
        volume: quote.volume,
        source: quote.source,
      })
      .onConflictDoUpdate({
        target: [priceSnapshots.stockId, priceSnapshots.ts],
        set: {
          open: quote.open,
          high: quote.high,
          low: quote.low,
          close: quote.close,
          volume: quote.volume,
          source: quote.source,
        },
      })
      .run();
  }

  async latestByStock(stockId: string, since?: Date): Promise<Quote | null> {
    const conditions =
      since === undefined
        ? eq(priceSnapshots.stockId, stockId)
        : and(eq(priceSnapshots.stockId, stockId), gte(priceSnapshots.ts, since));
    const row = this.db
      .select()
      .from(priceSnapshots)
      .where(conditions)
      .orderBy(desc(priceSnapshots.ts))
      .limit(1)
      .get();
    return row === undefined ? null : toQuote(row);
  }

  async latestByStocks(stockIds: readonly string[]): Promise<Map<string, Quote>> {
    const result = new Map<string, Quote>();
    if (stockIds.length === 0) return result;
    // 单次 SQL：GROUP BY stockId 取 max(ts)，再 join 取完整行。
    const maxTsSubquery = this.db
      .select({ stockId: priceSnapshots.stockId, maxTs: max(priceSnapshots.ts).as('max_ts') })
      .from(priceSnapshots)
      .where(inArray(priceSnapshots.stockId, [...stockIds]))
      .groupBy(priceSnapshots.stockId)
      .as('sq');
    const rows = this.db
      .select()
      .from(priceSnapshots)
      .innerJoin(
        maxTsSubquery,
        and(
          eq(priceSnapshots.stockId, maxTsSubquery.stockId),
          eq(priceSnapshots.ts, maxTsSubquery.maxTs),
        ),
      )
      .all();
    for (const joined of rows) {
      result.set(joined.price_snapshots.stockId, toQuote(joined.price_snapshots));
    }
    return result;
  }

  async listInRange(stockId: string, from: Date, to: Date): Promise<Quote[]> {
    return this.db
      .select()
      .from(priceSnapshots)
      .where(
        and(
          eq(priceSnapshots.stockId, stockId),
          gte(priceSnapshots.ts, from),
          lte(priceSnapshots.ts, to),
        ),
      )
      .orderBy(priceSnapshots.ts)
      .all()
      .map(toQuote);
  }

  async removeInRange(stockId: string, before: Date): Promise<number> {
    // 先 count（drizzle bun-sqlite 的 .run() 不返回 changes；用 select count 兜底）
    const beforeRows = this.db
      .select({ stockId: priceSnapshots.stockId, ts: priceSnapshots.ts })
      .from(priceSnapshots)
      .where(and(eq(priceSnapshots.stockId, stockId), lte(priceSnapshots.ts, before)))
      .all();
    this.db
      .delete(priceSnapshots)
      .where(and(eq(priceSnapshots.stockId, stockId), lte(priceSnapshots.ts, before)))
      .run();
    return beforeRows.length;
  }
}
