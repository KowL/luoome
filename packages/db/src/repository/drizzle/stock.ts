import {
  assertStockInvariants,
  type Stock,
  type StockCode,
  type StockRepository,
} from '@luoome/core';
import { asc, eq, like, or } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { type Schema, stocks } from '../../schema/index.js';

type StockRow = typeof stocks.$inferSelect;

/** industry 列可空，实体为可选字段：null → 缺省。 */
const toStock = (row: StockRow): Stock => ({
  id: row.id,
  code: row.code,
  exchange: row.exchange,
  name: row.name,
  ...(row.industry !== null ? { industry: row.industry } : {}),
});

/** LIKE 通配符（%/_）转义：v0.1 直接剔除，避免用户输入污染模糊匹配。 */
const sanitizeLikeQuery = (q: string): string => q.replace(/[%_]/g, '');

export class DrizzleStockRepository implements StockRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(stock: Stock): Promise<void> {
    assertStockInvariants(stock);
    const row = {
      id: stock.id,
      code: stock.code,
      exchange: stock.exchange,
      name: stock.name,
      industry: stock.industry ?? null,
    };
    this.db.insert(stocks).values(row).onConflictDoUpdate({ target: stocks.id, set: row }).run();
  }

  async findById(id: string): Promise<Stock | null> {
    const row = this.db.select().from(stocks).where(eq(stocks.id, id)).get();
    return row === undefined ? null : toStock(row);
  }

  async findByCode(code: string): Promise<Stock | null> {
    const row = this.db
      .select()
      .from(stocks)
      .where(eq(stocks.code, code as StockCode))
      .orderBy(asc(stocks.id))
      .limit(1)
      .get();
    return row === undefined ? null : toStock(row);
  }

  /** 按代码 / 名称模糊搜索（SQLite LIKE 对 ASCII 大小写不敏感，与内存实现一致）。 */
  async search(query: string): Promise<Stock[]> {
    const q = sanitizeLikeQuery(query.trim());
    if (q.length === 0) return [];
    const pattern = `%${q}%`;
    const rows = this.db
      .select()
      .from(stocks)
      .where(or(like(stocks.code, pattern), like(stocks.name, pattern)))
      .orderBy(asc(stocks.id))
      .all();
    return rows.map(toStock);
  }

  async remove(id: string): Promise<void> {
    this.db.delete(stocks).where(eq(stocks.id, id)).run();
  }
}
