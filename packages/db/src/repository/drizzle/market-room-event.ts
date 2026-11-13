import {
  assertMarketRoomEventInvariants,
  type MarketRoomEvent,
  type MarketRoomEventKind,
  type MarketRoomEventRepository,
  type MarketRoomEventSaveResult,
  MarketRoomEventSchema,
} from '@luoome/core';
import { and, asc, desc, eq, gte, lte } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { marketRoomEvents, type Schema } from '../../schema/index.js';

type EventRow = typeof marketRoomEvents.$inferSelect;

const toEvent = (row: EventRow): MarketRoomEvent => {
  const parsed = MarketRoomEventSchema.parse({
    id: row.id,
    tradingDate: row.tradingDate,
    kind: row.kind,
    sector: {
      sectorId: row.sectorId,
      kind: row.sectorKind,
      vendorCode: row.vendorCode,
      name: row.sectorName,
    },
    sampledAt: row.sampledAt,
    previousSampledAt: row.previousSampledAt,
    status: row.status,
    thresholds: row.thresholds,
    evidence: row.evidence,
    verification: row.verification,
    recordedAt: row.recordedAt,
  });
  assertMarketRoomEventInvariants(parsed);
  return parsed;
};

export class DrizzleMarketRoomEventRepository implements MarketRoomEventRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(event: MarketRoomEvent): Promise<MarketRoomEventSaveResult> {
    const parsed = MarketRoomEventSchema.parse(event);
    assertMarketRoomEventInvariants(parsed);
    const inserted = this.db
      .insert(marketRoomEvents)
      .values({
        id: parsed.id,
        tradingDate: parsed.tradingDate,
        kind: parsed.kind,
        sectorId: parsed.sector.sectorId,
        sectorKind: parsed.sector.kind,
        vendorCode: parsed.sector.vendorCode,
        sectorName: parsed.sector.name,
        sampledAt: parsed.sampledAt,
        previousSampledAt: parsed.previousSampledAt,
        status: parsed.status,
        thresholds: parsed.thresholds,
        evidence: parsed.evidence,
        verification: parsed.verification,
        recordedAt: parsed.recordedAt,
      })
      .onConflictDoNothing({ target: marketRoomEvents.id })
      .returning({ id: marketRoomEvents.id })
      .all();
    const saved = await this.findById(parsed.id);
    if (saved === null) {
      throw new Error('market room event save did not produce a row');
    }
    return { created: inserted.length === 1, event: saved };
  }

  async findById(id: string): Promise<MarketRoomEvent | null> {
    const row = this.db.select().from(marketRoomEvents).where(eq(marketRoomEvents.id, id)).get();
    return row === undefined ? null : toEvent(row);
  }

  async list(
    input: {
      readonly tradingDate?: string;
      readonly kind?: MarketRoomEventKind;
      readonly sectorId?: string;
      readonly from?: Date;
      readonly to?: Date;
      readonly knownAt?: Date;
      readonly order?: 'asc' | 'desc';
      readonly limit?: number;
    } = {},
  ): Promise<MarketRoomEvent[]> {
    const conditions = [];
    if (input.tradingDate !== undefined) {
      conditions.push(eq(marketRoomEvents.tradingDate, input.tradingDate));
    }
    if (input.kind !== undefined) conditions.push(eq(marketRoomEvents.kind, input.kind));
    if (input.sectorId !== undefined) {
      conditions.push(eq(marketRoomEvents.sectorId, input.sectorId));
    }
    if (input.from !== undefined) conditions.push(gte(marketRoomEvents.sampledAt, input.from));
    if (input.to !== undefined) conditions.push(lte(marketRoomEvents.sampledAt, input.to));
    if (input.knownAt !== undefined) {
      conditions.push(lte(marketRoomEvents.recordedAt, input.knownAt));
    }

    const direction = input.order === 'desc' ? desc : asc;
    const query = this.db
      .select()
      .from(marketRoomEvents)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(
        direction(marketRoomEvents.sampledAt),
        asc(marketRoomEvents.kind),
        asc(marketRoomEvents.sectorId),
      );
    const rows = input.limit === undefined ? query.all() : query.limit(input.limit).all();
    return rows.map(toEvent);
  }
}
