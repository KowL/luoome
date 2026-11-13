import {
  assertMarketSnapshotBatchInvariants,
  type MarketCoverage,
  type MarketSnapshotBatch,
  type MarketSnapshotBatchPublishResult,
  type MarketSnapshotBatchRepository,
  MarketSnapshotBatchSchema,
} from '@luoome/core';
import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { marketSnapshotBatches, type Schema } from '../../schema/index.js';

type BatchRow = typeof marketSnapshotBatches.$inferSelect;

const toBatch = (row: BatchRow): MarketSnapshotBatch => {
  const parsed = MarketSnapshotBatchSchema.parse({
    id: row.id,
    coverage: row.coverage,
    tradingDate: row.tradingDate,
    sampledAt: row.sampledAt,
    source: row.source,
    fetchedAt: row.fetchedAt,
    ...(row.observedAt === null ? {} : { observedAt: row.observedAt }),
    ...(row.dataAsOf === null ? {} : { dataAsOf: row.dataAsOf }),
    completeness: row.completeness,
    gaps: row.gaps,
    items: row.items,
  });
  assertMarketSnapshotBatchInvariants(parsed);
  return parsed;
};

export class DrizzleMarketSnapshotBatchRepository implements MarketSnapshotBatchRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async publish(batch: MarketSnapshotBatch): Promise<MarketSnapshotBatchPublishResult> {
    const parsed = MarketSnapshotBatchSchema.parse(batch);
    assertMarketSnapshotBatchInvariants(parsed);
    const inserted = this.db
      .insert(marketSnapshotBatches)
      .values({
        id: parsed.id,
        coverage: parsed.coverage,
        tradingDate: parsed.tradingDate,
        sampledAt: parsed.sampledAt,
        source: parsed.source,
        fetchedAt: parsed.fetchedAt,
        observedAt: parsed.observedAt ?? null,
        dataAsOf: parsed.dataAsOf ?? null,
        completeness: parsed.completeness,
        gaps: [...parsed.gaps],
        items: [...parsed.items],
      })
      .onConflictDoNothing({ target: marketSnapshotBatches.id })
      .returning({ id: marketSnapshotBatches.id })
      .all();
    const saved = await this.findById(parsed.id);
    if (saved === null) {
      throw new Error('market snapshot batch publish did not produce a row');
    }
    return { created: inserted.length === 1, batch: saved };
  }

  async findById(id: string): Promise<MarketSnapshotBatch | null> {
    const row = this.db
      .select()
      .from(marketSnapshotBatches)
      .where(eq(marketSnapshotBatches.id, id))
      .get();
    return row === undefined ? null : toBatch(row);
  }

  async findLatest(
    input: { readonly coverage?: MarketCoverage } = {},
  ): Promise<MarketSnapshotBatch | null> {
    const query = this.db
      .select()
      .from(marketSnapshotBatches)
      .orderBy(desc(marketSnapshotBatches.sampledAt), desc(marketSnapshotBatches.id));
    const row =
      input.coverage === undefined
        ? query.limit(1).get()
        : query.where(eq(marketSnapshotBatches.coverage, input.coverage)).limit(1).get();
    return row === undefined ? null : toBatch(row);
  }

  async findNearestAt(input: {
    readonly coverage?: MarketCoverage;
    readonly tradingDate: string;
    readonly sampledAt: Date;
    readonly toleranceMs: number;
  }): Promise<MarketSnapshotBatch | null> {
    const distance = sql<number>`abs(${marketSnapshotBatches.sampledAt} - ${input.sampledAt.getTime()})`;
    const row = this.db
      .select()
      .from(marketSnapshotBatches)
      .where(
        and(
          eq(marketSnapshotBatches.tradingDate, input.tradingDate),
          lte(distance, input.toleranceMs),
          ...(input.coverage === undefined
            ? []
            : [eq(marketSnapshotBatches.coverage, input.coverage)]),
        ),
      )
      .orderBy(asc(distance), desc(marketSnapshotBatches.sampledAt))
      .limit(1)
      .get();
    return row === undefined ? null : toBatch(row);
  }
}
