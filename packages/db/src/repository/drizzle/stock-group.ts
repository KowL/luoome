import {
  assertStockGroupInvariants,
  type StockGroup,
  type StockGroupRepository,
} from '@luoome/core';
import { asc, eq } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { type Schema, stockGroups } from '../../schema/index.js';

type GroupRow = typeof stockGroups.$inferSelect;

const toStockGroup = (row: GroupRow): StockGroup => ({
  id: row.id,
  name: row.name,
  ...(row.description !== null ? { description: row.description } : {}),
  resolver: row.resolver,
  refreshPolicy: row.refreshPolicy,
  enabled: row.enabled,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export class DrizzleStockGroupRepository implements StockGroupRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(group: StockGroup): Promise<void> {
    assertStockGroupInvariants(group);
    this.db
      .insert(stockGroups)
      .values({
        id: group.id,
        name: group.name,
        description: group.description ?? null,
        resolver: group.resolver,
        refreshPolicy: group.refreshPolicy,
        enabled: group.enabled,
        createdAt: group.createdAt,
        updatedAt: group.updatedAt,
      })
      .onConflictDoUpdate({
        target: stockGroups.id,
        set: {
          name: group.name,
          description: group.description ?? null,
          resolver: group.resolver,
          refreshPolicy: group.refreshPolicy,
          enabled: group.enabled,
          updatedAt: group.updatedAt,
        },
      })
      .run();
  }

  async findById(id: string): Promise<StockGroup | null> {
    const row = this.db.select().from(stockGroups).where(eq(stockGroups.id, id)).get();
    return row === undefined ? null : toStockGroup(row);
  }

  async list(enabledOnly = false): Promise<readonly StockGroup[]> {
    const rows = enabledOnly
      ? this.db
          .select()
          .from(stockGroups)
          .where(eq(stockGroups.enabled, true))
          .orderBy(asc(stockGroups.id))
          .all()
      : this.db.select().from(stockGroups).orderBy(asc(stockGroups.id)).all();
    return rows.map(toStockGroup);
  }

  async remove(id: string): Promise<void> {
    this.db.delete(stockGroups).where(eq(stockGroups.id, id)).run();
  }
}
