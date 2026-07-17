import {
  assertHoldingInvariants,
  type Holding,
  type HoldingRepository,
  InvariantError,
} from '@luoome/core';
import { and, asc, eq } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { holdings, type Schema } from '../../schema/index.js';

/** Holding 的 Drizzle 实现。行结构与实体一致（closedAt: Date | null），无需 mapper。 */
export class DrizzleHoldingRepository implements HoldingRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(holding: Holding): Promise<void> {
    assertHoldingInvariants(holding);
    // 「holdings 无重复」：同一 (accountId, stockId) 只允许一条记录。
    // DB 层有唯一索引兜底；此处先查一次，把冲突转成领域错误 InvariantError，
    // 让上层统一走 invariant_violation ToolError，而不是裸 SqliteError。
    const existing = await this.findByAccountAndStock(holding.accountId, holding.stockId);
    if (existing !== null && existing.id !== holding.id) {
      throw new InvariantError(
        `duplicate holding for (accountId=${holding.accountId}, stockId=${holding.stockId})`,
      );
    }
    const row = {
      id: holding.id,
      accountId: holding.accountId,
      stockId: holding.stockId,
      quantity: holding.quantity,
      availableQuantity: holding.availableQuantity,
      avgCost: holding.avgCost,
      openedAt: holding.openedAt,
      closedAt: holding.closedAt,
    };
    this.db
      .insert(holdings)
      .values(row)
      .onConflictDoUpdate({ target: holdings.id, set: row })
      .run();
  }

  async findById(id: string): Promise<Holding | null> {
    const row = this.db.select().from(holdings).where(eq(holdings.id, id)).get();
    return row ?? null;
  }

  async findByAccountAndStock(accountId: string, stockId: string): Promise<Holding | null> {
    const row = this.db
      .select()
      .from(holdings)
      .where(and(eq(holdings.accountId, accountId), eq(holdings.stockId, stockId)))
      .limit(1)
      .get();
    return row ?? null;
  }

  async listByAccount(accountId: string): Promise<Holding[]> {
    return this.db
      .select()
      .from(holdings)
      .where(eq(holdings.accountId, accountId))
      .orderBy(asc(holdings.id))
      .all();
  }

  async remove(id: string): Promise<void> {
    this.db.delete(holdings).where(eq(holdings.id, id)).run();
  }
}
