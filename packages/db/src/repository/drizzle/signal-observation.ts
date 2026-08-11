import {
  assertSignalObservationInvariants,
  type SignalObservation,
  type SignalObservationRepository,
} from '@luoome/core';
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
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
  ...(row.dueAt === null ? {} : { dueAt: row.dueAt }),
  ...(row.attemptCount === 0 ? {} : { attemptCount: row.attemptCount }),
  ...(row.lastAttemptAt === null ? {} : { lastAttemptAt: row.lastAttemptAt }),
  ...(row.nextAttemptAt === null ? {} : { nextAttemptAt: row.nextAttemptAt }),
  ...(row.lastErrorKind === null ? {} : { lastErrorKind: row.lastErrorKind }),
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
      dueAt: observation.dueAt ?? null,
      attemptCount: observation.attemptCount ?? 0,
      lastAttemptAt: observation.lastAttemptAt ?? null,
      nextAttemptAt: observation.nextAttemptAt ?? null,
      lastErrorKind: observation.lastErrorKind ?? null,
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
    if (input.dueBefore !== undefined) {
      conditions.push(
        or(
          lte(signalObservations.dueAt, input.dueBefore),
          and(
            isNull(signalObservations.dueAt),
            lte(signalObservations.baselineAt, input.dueBefore),
          ),
        ),
      );
    }
    if (input.retryReadyAt !== undefined) {
      conditions.push(
        or(
          isNull(signalObservations.nextAttemptAt),
          lte(signalObservations.nextAttemptAt, input.retryReadyAt),
        ),
      );
    }
    return this.db
      .select()
      .from(signalObservations)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(
        input.order === 'due-first'
          ? asc(sql`coalesce(${signalObservations.dueAt}, ${signalObservations.baselineAt})`)
          : desc(signalObservations.baselineAt),
      )
      .limit(input.limit ?? 1000)
      .all()
      .map(toObservation);
  }

  async removeBySources(
    sourceKind: SignalObservation['sourceKind'],
    sourceIds: readonly string[],
  ): Promise<void> {
    if (sourceIds.length === 0) return;
    this.db
      .delete(signalObservations)
      .where(
        and(
          eq(signalObservations.sourceKind, sourceKind),
          inArray(signalObservations.sourceId, [...sourceIds]),
        ),
      )
      .run();
  }
}
