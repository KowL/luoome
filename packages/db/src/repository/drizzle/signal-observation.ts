import {
  assertSignalObservationInvariants,
  parseSignalObservationId,
  type SignalObservation,
  type SignalObservationRepository,
  signalObservationId,
} from '@luoome/core';
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { type Schema, signalObservations } from '../../schema/index.js';

type Row = typeof signalObservations.$inferSelect;
const toObservation = (row: Row): SignalObservation => ({
  // id 由自然键派生，存储层不再单独存列。
  id: signalObservationId(row.sourceKind, row.sourceId, row.horizon),
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
    const { id: _derivedId, ...rest } = observation;
    const values = {
      ...rest,
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
      .onConflictDoUpdate({
        target: [
          signalObservations.sourceKind,
          signalObservations.sourceId,
          signalObservations.horizon,
        ],
        set: values,
      })
      .run();
  }

  async findById(id: string): Promise<SignalObservation | null> {
    const key = parseSignalObservationId(id);
    if (key === null) return null;
    const row = this.db
      .select()
      .from(signalObservations)
      .where(
        and(
          eq(signalObservations.sourceKind, key.sourceKind),
          eq(signalObservations.sourceId, key.sourceId),
          eq(signalObservations.horizon, key.horizon),
        ),
      )
      .get();
    return row === undefined ? null : toObservation(row);
  }

  async listBySources(
    input: Parameters<SignalObservationRepository['listBySources']>[0],
  ): Promise<readonly SignalObservation[]> {
    if (input.sourceIds.length === 0) return [];
    const conditions = [inArray(signalObservations.sourceId, [...input.sourceIds])];
    if (input.sourceKind !== undefined) {
      conditions.push(eq(signalObservations.sourceKind, input.sourceKind));
    }
    if (input.horizons !== undefined) {
      if (input.horizons.length === 0) return [];
      conditions.push(inArray(signalObservations.horizon, [...input.horizons]));
    }
    return this.db
      .select()
      .from(signalObservations)
      .where(and(...conditions))
      .orderBy(desc(signalObservations.baselineAt), desc(signalObservations.sourceId))
      .all()
      .map(toObservation);
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

  async pruneSettledBefore(
    cutoff: Date,
    options: { readonly dryRun?: boolean } = {},
  ): Promise<number> {
    const condition = and(
      inArray(signalObservations.status, ['complete', 'unavailable']),
      lte(signalObservations.baselineAt, cutoff),
    );
    if (options.dryRun === true) {
      const row = this.db
        .select({ count: sql<number>`count(*)` })
        .from(signalObservations)
        .where(condition)
        .get();
      return Number(row?.count ?? 0);
    }
    const result = this.db
      .delete(signalObservations)
      .where(condition)
      .returning({ sourceId: signalObservations.sourceId })
      .all();
    return result.length;
  }
}
