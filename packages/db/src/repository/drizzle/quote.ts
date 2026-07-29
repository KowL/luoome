import { type Quote, type QuoteRepository, QuoteSchema } from '@luoome/core';
import { and, desc, eq, gte, inArray, lte, max } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { priceSnapshots, type Schema } from '../../schema/index.js';

type QuoteRow = typeof priceSnapshots.$inferSelect;

/** 行 ↔ 实体映射（Date ↔ timestamp_ms 自动转换由 schema 声明完成）。 */
const toQuote = (row: QuoteRow): Quote => ({
  stockId: row.stockId,
  observedAt: row.observedAt,
  fetchedAt: row.fetchedAt,
  timestampSource: row.timestampSource,
  ts: row.observedAt,
  open: row.open,
  high: row.high,
  low: row.low,
  close: row.close,
  volume: row.volume,
  ...(row.prevClose !== null ? { prevClose: row.prevClose } : {}),
  source: row.source,
});

/**
 * Quote 的 Drizzle 实现。
 * price_snapshots 的复合主键 (stockId, ts) → 同 ts 重复写入视为覆盖。
 */
export class DrizzleQuoteRepository implements QuoteRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(quote: Quote): Promise<void> {
    const parsed = QuoteSchema.parse(quote);
    this.db
      .insert(priceSnapshots)
      .values({
        stockId: parsed.stockId,
        observedAt: parsed.observedAt,
        fetchedAt: parsed.fetchedAt,
        timestampSource: parsed.timestampSource,
        open: parsed.open,
        high: parsed.high,
        low: parsed.low,
        close: parsed.close,
        volume: parsed.volume,
        prevClose: parsed.prevClose ?? null,
        source: parsed.source,
      })
      .onConflictDoUpdate({
        target: [priceSnapshots.stockId, priceSnapshots.observedAt, priceSnapshots.source],
        set: {
          fetchedAt: parsed.fetchedAt,
          timestampSource: parsed.timestampSource,
          open: parsed.open,
          high: parsed.high,
          low: parsed.low,
          close: parsed.close,
          volume: parsed.volume,
          prevClose: parsed.prevClose ?? null,
        },
      })
      .run();
  }

  async latestByStock(stockId: string, since?: Date): Promise<Quote | null> {
    const conditions =
      since === undefined
        ? eq(priceSnapshots.stockId, stockId)
        : and(eq(priceSnapshots.stockId, stockId), gte(priceSnapshots.observedAt, since));
    const row = this.db
      .select()
      .from(priceSnapshots)
      .where(conditions)
      .orderBy(desc(priceSnapshots.observedAt), desc(priceSnapshots.fetchedAt))
      .limit(1)
      .get();
    return row === undefined ? null : toQuote(row);
  }

  async latestByStocks(stockIds: readonly string[]): Promise<Map<string, Quote>> {
    const result = new Map<string, Quote>();
    if (stockIds.length === 0) return result;
    // 单次 SQL：GROUP BY stockId 取 max(observedAt)，再 join 取完整行。
    const maxTsSubquery = this.db
      .select({
        stockId: priceSnapshots.stockId,
        maxTs: max(priceSnapshots.observedAt).as('max_observed_at'),
      })
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
          eq(priceSnapshots.observedAt, maxTsSubquery.maxTs),
        ),
      )
      .all();
    for (const joined of rows) {
      const quote = toQuote(joined.price_snapshots);
      const current = result.get(quote.stockId);
      if (current === undefined || quote.fetchedAt > current.fetchedAt) {
        result.set(quote.stockId, quote);
      }
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
          gte(priceSnapshots.observedAt, from),
          lte(priceSnapshots.observedAt, to),
        ),
      )
      .orderBy(priceSnapshots.observedAt, priceSnapshots.source)
      .all()
      .map(toQuote);
  }

  async removeInRange(stockId: string, before: Date): Promise<number> {
    // 先 count（drizzle bun-sqlite 的 .run() 不返回 changes；用 select count 兜底）
    const beforeRows = this.db
      .select({ stockId: priceSnapshots.stockId, observedAt: priceSnapshots.observedAt })
      .from(priceSnapshots)
      .where(and(eq(priceSnapshots.stockId, stockId), lte(priceSnapshots.observedAt, before)))
      .all();
    this.db
      .delete(priceSnapshots)
      .where(and(eq(priceSnapshots.stockId, stockId), lte(priceSnapshots.observedAt, before)))
      .run();
    return beforeRows.length;
  }
}
