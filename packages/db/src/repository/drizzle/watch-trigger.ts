import {
  assertWatchTriggerInvariants,
  type WatchRule,
  type WatchTrigger,
  type WatchTriggerRepository,
} from '@luoome/core';
import { and, desc, eq, gte, type SQL } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { type Schema, watchTriggers } from '../../schema/index.js';

type TriggerRow = typeof watchTriggers.$inferSelect;

const toWatchTrigger = (row: TriggerRow): WatchTrigger => ({
  id: row.id,
  poolId: row.poolId,
  stockId: row.stockId,
  ruleKind: row.ruleKind,
  direction: row.direction,
  reason: row.reason,
  evidence: [...row.evidence],
  quote: { close: row.quoteClose, ts: row.quoteTs },
  notified: row.notified,
  createdAt: row.createdAt,
});

export class DrizzleWatchTriggerRepository implements WatchTriggerRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(trigger: WatchTrigger): Promise<void> {
    assertWatchTriggerInvariants(trigger);
    this.db
      .insert(watchTriggers)
      .values({
        id: trigger.id,
        poolId: trigger.poolId,
        stockId: trigger.stockId,
        ruleKind: trigger.ruleKind,
        direction: trigger.direction,
        reason: trigger.reason,
        evidence: [...trigger.evidence],
        quoteClose: trigger.quote.close,
        quoteTs: trigger.quote.ts,
        notified: trigger.notified,
        createdAt: trigger.createdAt,
      })
      .onConflictDoUpdate({
        target: watchTriggers.id,
        set: {
          reason: trigger.reason,
          evidence: [...trigger.evidence],
          quoteClose: trigger.quote.close,
          quoteTs: trigger.quote.ts,
          notified: trigger.notified,
        },
      })
      .run();
  }

  async findById(id: string): Promise<WatchTrigger | null> {
    const row = this.db.select().from(watchTriggers).where(eq(watchTriggers.id, id)).get();
    return row === undefined ? null : toWatchTrigger(row);
  }

  async listByPool(
    poolId: string,
    opts: { readonly since?: Date; readonly limit?: number } = {},
  ): Promise<readonly WatchTrigger[]> {
    const conditions: SQL[] = [eq(watchTriggers.poolId, poolId)];
    if (opts.since !== undefined) conditions.push(gte(watchTriggers.createdAt, opts.since));
    const where = and(...conditions);
    const limit = opts.limit ?? 200;
    return this.db
      .select()
      .from(watchTriggers)
      .where(where)
      .orderBy(desc(watchTriggers.createdAt))
      .limit(limit)
      .all()
      .map(toWatchTrigger);
  }

  async lastForKey(
    key: {
      readonly poolId: string;
      readonly stockId: string;
      readonly ruleKind: WatchRule['kind'];
    },
    since: Date,
  ): Promise<WatchTrigger | null> {
    const row = this.db
      .select()
      .from(watchTriggers)
      .where(
        and(
          eq(watchTriggers.poolId, key.poolId),
          eq(watchTriggers.stockId, key.stockId),
          eq(watchTriggers.ruleKind, key.ruleKind),
          gte(watchTriggers.createdAt, since),
        ),
      )
      .orderBy(desc(watchTriggers.createdAt))
      .get();
    return row === undefined ? null : toWatchTrigger(row);
  }

  async listRecent(
    opts: { readonly poolId?: string; readonly since?: Date; readonly limit?: number } = {},
  ): Promise<readonly WatchTrigger[]> {
    const conditions: SQL[] = [];
    if (opts.poolId !== undefined) conditions.push(eq(watchTriggers.poolId, opts.poolId));
    if (opts.since !== undefined) conditions.push(gte(watchTriggers.createdAt, opts.since));
    const where = conditions.length === 0 ? undefined : and(...conditions);
    const limit = opts.limit ?? 50;
    return this.db
      .select()
      .from(watchTriggers)
      .where(where)
      .orderBy(desc(watchTriggers.createdAt))
      .limit(limit)
      .all()
      .map(toWatchTrigger);
  }

  async remove(id: string): Promise<void> {
    this.db.delete(watchTriggers).where(eq(watchTriggers.id, id)).run();
  }
}
