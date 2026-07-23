import { assertStockPoolInvariants, type StockPool, type StockPoolRepository } from '@luoome/core';
import { asc, eq } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { type Schema, stockPools } from '../../schema/index.js';

type PoolRow = typeof stockPools.$inferSelect;

const toStockPool = (row: PoolRow): StockPool => ({
  id: row.id,
  name: row.name,
  ...(row.description !== null ? { description: row.description } : {}),
  // 旧行（分组化迁移前）group_id 为 NULL → 空串占位：读出 / 序列化不 crash；
  // 阶段 B 数据迁移后消失（docs/stock-group-design.md §5）。source 列 deprecated，不读出。
  groupId: row.groupId ?? '',
  rules: row.rules,
  cooldownMinutes: row.cooldownMinutes,
  enabled: row.enabled,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export class DrizzleStockPoolRepository implements StockPoolRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(pool: StockPool): Promise<void> {
    assertStockPoolInvariants(pool);
    this.db
      .insert(stockPools)
      .values({
        id: pool.id,
        name: pool.name,
        description: pool.description ?? null,
        // source 列 deprecated：新行恒写 NULL（旧库 source NOT NULL 已由 ensureSchema 结构升级放宽）
        source: null,
        groupId: pool.groupId,
        rules: pool.rules,
        cooldownMinutes: pool.cooldownMinutes,
        enabled: pool.enabled,
        createdAt: pool.createdAt,
        updatedAt: pool.updatedAt,
      })
      .onConflictDoUpdate({
        target: stockPools.id,
        set: {
          name: pool.name,
          description: pool.description ?? null,
          source: null,
          groupId: pool.groupId,
          rules: pool.rules,
          cooldownMinutes: pool.cooldownMinutes,
          enabled: pool.enabled,
          updatedAt: pool.updatedAt,
        },
      })
      .run();
  }

  async findById(id: string): Promise<StockPool | null> {
    const row = this.db.select().from(stockPools).where(eq(stockPools.id, id)).get();
    return row === undefined ? null : toStockPool(row);
  }

  async list(enabledOnly = false): Promise<readonly StockPool[]> {
    const rows = enabledOnly
      ? this.db
          .select()
          .from(stockPools)
          .where(eq(stockPools.enabled, true))
          .orderBy(asc(stockPools.id))
          .all()
      : this.db.select().from(stockPools).orderBy(asc(stockPools.id)).all();
    return rows.map(toStockPool);
  }

  async remove(id: string): Promise<void> {
    this.db.delete(stockPools).where(eq(stockPools.id, id)).run();
  }
}
