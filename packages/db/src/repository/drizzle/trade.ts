import { assertTradeInvariants, type Trade, type TradeRepository } from '@luoome/core';
import { asc, eq } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { type Schema, trades } from '../../schema/index.js';

/** Trade 的 Drizzle 实现。行结构与实体一致，无需 mapper。 */
export class DrizzleTradeRepository implements TradeRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(trade: Trade): Promise<void> {
    assertTradeInvariants(trade);
    const row = {
      id: trade.id,
      accountId: trade.accountId,
      stockId: trade.stockId,
      side: trade.side,
      quantity: trade.quantity,
      price: trade.price,
      fee: trade.fee,
      executedAt: trade.executedAt,
      source: trade.source,
      createdAt: trade.createdAt,
    };
    this.db.insert(trades).values(row).onConflictDoUpdate({ target: trades.id, set: row }).run();
  }

  async findById(id: string): Promise<Trade | null> {
    const row = this.db.select().from(trades).where(eq(trades.id, id)).get();
    return row ?? null;
  }

  /** 按执行时间升序（id 决胜），与内存实现保持一致。 */
  async listByAccount(accountId: string): Promise<Trade[]> {
    return this.db
      .select()
      .from(trades)
      .where(eq(trades.accountId, accountId))
      .orderBy(asc(trades.executedAt), asc(trades.id))
      .all();
  }

  async remove(id: string): Promise<void> {
    this.db.delete(trades).where(eq(trades.id, id)).run();
  }
}
