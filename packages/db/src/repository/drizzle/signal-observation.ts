import {
  assertSignalObservationInvariants,
  type SignalObservation,
  type SignalObservationRepository,
} from '@luoome/core';
import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { type Schema, signalObservations } from '../../schema/index.js';

type Row = typeof signalObservations.$inferSelect;
const toObservation = (row: Row): SignalObservation => ({
  id: row.id,
  sourceKind: row.sourceKind,
  sourceId: row.sourceId,
  stockId: row.stockId,
  ...(row.baselinePrice === null ? {} : { baselinePrice: row.baselinePrice }),
  ...(row.baselineAt === null ? {} : { baselineAt: row.baselineAt }),
  horizon: row.horizon,
  ...(row.closePrice === null ? {} : { closePrice: row.closePrice }),
  ...(row.returnPct === null ? {} : { returnPct: row.returnPct }),
  ...(row.maxFavorableExcursionPct === null
    ? {}
    : { maxFavorableExcursionPct: row.maxFavorableExcursionPct }),
  ...(row.maxAdverseExcursionPct === null
    ? {}
    : { maxAdverseExcursionPct: row.maxAdverseExcursionPct }),
  ...(row.benchmarkReturnPct === null ? {} : { benchmarkReturnPct: row.benchmarkReturnPct }),
  benchmarkStatus: row.benchmarkStatus,
  status: row.status,
  provenance: row.provenance,
  ...(row.unavailableReason === null ? {} : { unavailableReason: row.unavailableReason }),
  ...(row.observedAt === null ? {} : { observedAt: row.observedAt }),
});
export class DrizzleSignalObservationRepository implements SignalObservationRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}
  async save(observation: SignalObservation): Promise<void> {
    assertSignalObservationInvariants(observation);
    const values = {
      ...observation,
      baselinePrice: observation.baselinePrice ?? null,
      baselineAt: observation.baselineAt ?? null,
      closePrice: observation.closePrice ?? null,
      returnPct: observation.returnPct ?? null,
      maxFavorableExcursionPct: observation.maxFavorableExcursionPct ?? null,
      maxAdverseExcursionPct: observation.maxAdverseExcursionPct ?? null,
      benchmarkReturnPct: observation.benchmarkReturnPct ?? null,
      unavailableReason: observation.unavailableReason ?? null,
      observedAt: observation.observedAt ?? null,
    };
    this.db
      .insert(signalObservations)
      .values(values)
      .onConflictDoUpdate({ target: signalObservations.id, set: values })
      .run();
  }
  async findById(id: string): Promise<SignalObservation | null> {
    const row = this.db
      .select()
      .from(signalObservations)
      .where(eq(signalObservations.id, id))
      .get();
    return row === undefined ? null : toObservation(row);
  }
  async list(
    input: Parameters<SignalObservationRepository['list']>[0] = {},
  ): Promise<readonly SignalObservation[]> {
    const conditions = [];
    if (input.status !== undefined) conditions.push(eq(signalObservations.status, input.status));
    if (input.sourceKind !== undefined)
      conditions.push(eq(signalObservations.sourceKind, input.sourceKind));
    if (input.sourceIds !== undefined) {
      if (input.sourceIds.length === 0) return [];
      conditions.push(inArray(signalObservations.sourceId, [...input.sourceIds]));
    }
    if (input.horizons !== undefined) {
      if (input.horizons.length === 0) return [];
      conditions.push(inArray(signalObservations.horizon, [...input.horizons]));
    }
    if (input.from !== undefined) conditions.push(gte(signalObservations.baselineAt, input.from));
    if (input.to !== undefined) conditions.push(lte(signalObservations.baselineAt, input.to));
    return this.db
      .select()
      .from(signalObservations)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(signalObservations.baselineAt))
      .limit(input.limit ?? 1000)
      .all()
      .map(toObservation);
  }
}
