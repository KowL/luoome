import {
  assertStockEventInvariants,
  type EventImportance,
  type StockEvent,
  type StockEventKind,
  type StockEventRepository,
  type StockEventStatus,
} from '@luoome/core';
import { and, asc, eq, gte, inArray, lte, or, type SQL } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { type Schema, stockEvents } from '../../schema/index.js';

type EventRow = typeof stockEvents.$inferSelect;

const IMPORTANCE_RANK: Record<EventImportance, number> = {
  normal: 0,
  important: 1,
  urgent: 2,
};

/** 最低重要性过滤：返回 ≥ minImportance 的 importance 值集合（SQLite 无枚举序，用 or(eq) 展开）。 */
const importanceAtLeast = (min: EventImportance): SQL => {
  const allowed = (['normal', 'important', 'urgent'] as EventImportance[]).filter(
    (v) => IMPORTANCE_RANK[v] >= IMPORTANCE_RANK[min],
  );
  const conds = allowed.map((v) => eq(stockEvents.importance, v));
  const [first, ...rest] = conds;
  if (first === undefined) throw new Error('importance filter requires at least one condition');
  if (rest.length === 0) return first;
  const combined = or(first, ...rest);
  if (combined === undefined) throw new Error('failed to combine importance conditions');
  return combined;
};

const toStockEvent = (row: EventRow): StockEvent => ({
  id: row.id,
  stockId: row.stockId,
  kind: row.kind,
  title: row.title,
  ...(row.description !== null ? { description: row.description } : {}),
  occursAt: row.occursAt,
  allDay: row.allDay,
  importance: row.importance,
  status: row.status,
  source: row.source,
  ...(row.provider !== null ? { provider: row.provider } : {}),
  ...(row.externalId !== null ? { externalId: row.externalId } : {}),
  ...(row.sourceUrl !== null ? { sourceUrl: row.sourceUrl } : {}),
  ...(row.observedAt !== null ? { observedAt: row.observedAt } : {}),
  ...(row.fetchedAt !== null ? { fetchedAt: row.fetchedAt } : {}),
  stale: row.stale,
  remindBeforeDays: [...(row.remindBeforeDays as number[])],
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toRow = (event: StockEvent): typeof stockEvents.$inferInsert => ({
  id: event.id,
  stockId: event.stockId,
  kind: event.kind,
  title: event.title,
  description: event.description ?? null,
  occursAt: event.occursAt,
  allDay: event.allDay,
  importance: event.importance,
  status: event.status,
  source: event.source,
  provider: event.provider ?? null,
  externalId: event.externalId ?? null,
  sourceUrl: event.sourceUrl ?? null,
  observedAt: event.observedAt ?? null,
  fetchedAt: event.fetchedAt ?? null,
  stale: event.stale,
  remindBeforeDays: [...event.remindBeforeDays],
  createdAt: event.createdAt,
  updatedAt: event.updatedAt,
});

/** StockEvent Drizzle 实现（ruo 迁移 §3.2）。upsertByExternal 按 (provider, externalId) 幂等。 */
export class DrizzleStockEventRepository implements StockEventRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(event: StockEvent): Promise<void> {
    assertStockEventInvariants(event);
    const row = toRow(event);
    this.db
      .insert(stockEvents)
      .values(row)
      .onConflictDoUpdate({
        target: stockEvents.id,
        set: row,
      })
      .run();
  }

  async findById(id: string): Promise<StockEvent | null> {
    const row = this.db.select().from(stockEvents).where(eq(stockEvents.id, id)).get();
    return row === undefined ? null : toStockEvent(row);
  }

  async findByExternal(provider: string, externalId: string): Promise<StockEvent | null> {
    const row = this.db
      .select()
      .from(stockEvents)
      .where(and(eq(stockEvents.provider, provider), eq(stockEvents.externalId, externalId)))
      .get();
    return row === undefined ? null : toStockEvent(row);
  }

  async upsertByExternal(event: StockEvent): Promise<'inserted' | 'updated'> {
    assertStockEventInvariants(event);
    if (event.provider === undefined || event.externalId === undefined) {
      await this.save(event);
      return 'inserted';
    }
    const existing = await this.findByExternal(event.provider, event.externalId);
    if (existing === null) {
      await this.save(event);
      return 'inserted';
    }
    this.db
      .update(stockEvents)
      .set({
        title: event.title,
        description: event.description ?? null,
        occursAt: event.occursAt,
        allDay: event.allDay,
        importance: event.importance,
        status: event.status,
        sourceUrl: event.sourceUrl ?? null,
        observedAt: event.observedAt ?? null,
        fetchedAt: event.fetchedAt ?? null,
        stale: event.stale,
        remindBeforeDays: [...event.remindBeforeDays],
        updatedAt: event.updatedAt,
      })
      .where(eq(stockEvents.id, existing.id))
      .run();
    return 'updated';
  }

  async list(
    opts: {
      readonly stockId?: string;
      readonly kinds?: readonly StockEventKind[];
      readonly status?: StockEventStatus;
      readonly from?: Date;
      readonly to?: Date;
      readonly importance?: EventImportance;
      readonly limit?: number;
    } = {},
  ): Promise<readonly StockEvent[]> {
    const conditions: SQL[] = [];
    if (opts.stockId !== undefined) conditions.push(eq(stockEvents.stockId, opts.stockId));
    if (opts.kinds !== undefined && opts.kinds.length > 0) {
      conditions.push(inArray(stockEvents.kind, [...opts.kinds]));
    }
    if (opts.status !== undefined) conditions.push(eq(stockEvents.status, opts.status));
    if (opts.importance !== undefined) conditions.push(eq(stockEvents.importance, opts.importance));
    if (opts.from !== undefined) conditions.push(gte(stockEvents.occursAt, opts.from));
    if (opts.to !== undefined) conditions.push(lte(stockEvents.occursAt, opts.to));
    const where = conditions.length === 0 ? undefined : and(...conditions);
    return this.db
      .select()
      .from(stockEvents)
      .where(where)
      .orderBy(asc(stockEvents.occursAt))
      .limit(opts.limit ?? 200)
      .all()
      .map(toStockEvent);
  }

  async listUpcoming(
    stockId: string,
    from: Date,
    to: Date,
    opts: {
      readonly kinds?: readonly StockEventKind[];
      readonly minImportance?: EventImportance;
    } = {},
  ): Promise<readonly StockEvent[]> {
    const conditions: SQL[] = [
      eq(stockEvents.stockId, stockId),
      eq(stockEvents.status, 'scheduled'),
      gte(stockEvents.occursAt, from),
      lte(stockEvents.occursAt, to),
    ];
    if (opts.kinds !== undefined && opts.kinds.length > 0) {
      conditions.push(inArray(stockEvents.kind, [...opts.kinds]));
    }
    if (opts.minImportance !== undefined && opts.minImportance !== 'normal') {
      conditions.push(importanceAtLeast(opts.minImportance));
    }
    return this.db
      .select()
      .from(stockEvents)
      .where(and(...conditions))
      .orderBy(asc(stockEvents.occursAt))
      .all()
      .map(toStockEvent);
  }

  async listStockIdsWithEvents(): Promise<readonly string[]> {
    const rows = this.db.selectDistinct({ stockId: stockEvents.stockId }).from(stockEvents).all();
    return rows.map((r) => r.stockId);
  }

  async markStaleByProvider(provider: string): Promise<number> {
    const result = this.db
      .update(stockEvents)
      .set({ stale: true })
      .where(and(eq(stockEvents.provider, provider), eq(stockEvents.stale, false)))
      .run();
    return typeof result === 'object' && result !== null && 'changes' in result
      ? Number((result as { changes: unknown }).changes)
      : 0;
  }

  async remove(id: string): Promise<void> {
    this.db.delete(stockEvents).where(eq(stockEvents.id, id)).run();
  }
}
