import {
  assertFinancialFactInvariants,
  type FinancialFact,
  type FinancialFactRepository,
  FinancialFactSchema,
  InvariantError,
  resolveStrictPitFinancialVintage,
} from '@luoome/core';
import { and, eq, gte, inArray, lte, type SQL } from 'drizzle-orm';

import type { DrizzleDb } from '../../client.js';
import { financialFactRevisions } from '../../schema/index.js';

type FactRow = typeof financialFactRevisions.$inferSelect;

const fromRow = (row: FactRow): FinancialFact => {
  const fact = FinancialFactSchema.parse({
    id: row.id,
    stockId: row.stockId,
    metricId: row.metricId,
    periodType: row.periodType,
    ...(row.periodStart === null ? {} : { periodStart: row.periodStart }),
    periodEnd: row.periodEnd,
    value: row.value,
    canonicalUnit: row.canonicalUnit,
    ...(row.currency === null ? {} : { currency: row.currency }),
    ...(row.rawValue === null ? {} : { rawValue: row.rawValue }),
    ...(row.rawUnit === null ? {} : { rawUnit: row.rawUnit }),
    source: row.source,
    sourceRecordId: row.sourceRecordId,
    sourceRevision: row.sourceRevision,
    publishedAt: row.publishedAt,
    revisionPublishedAt: row.revisionPublishedAt,
    recordedAt: row.recordedAt,
    status: row.status,
    ...(row.supersedesId === null ? {} : { supersedesId: row.supersedesId }),
    ...(row.industryKey === null ? {} : { industryKey: row.industryKey }),
    contentHash: row.contentHash,
  });
  assertFinancialFactInvariants(fact);
  return fact;
};

const toRow = (fact: FinancialFact): typeof financialFactRevisions.$inferInsert => ({
  id: fact.id,
  stockId: fact.stockId,
  metricId: fact.metricId,
  periodType: fact.periodType,
  periodStart: fact.periodStart ?? null,
  periodEnd: fact.periodEnd,
  value: fact.value,
  canonicalUnit: fact.canonicalUnit,
  currency: fact.currency ?? null,
  rawValue: fact.rawValue ?? null,
  rawUnit: fact.rawUnit ?? null,
  source: fact.source,
  sourceRecordId: fact.sourceRecordId,
  sourceRevision: fact.sourceRevision,
  publishedAt: fact.publishedAt,
  revisionPublishedAt: fact.revisionPublishedAt,
  recordedAt: fact.recordedAt,
  status: fact.status,
  supersedesId: fact.supersedesId ?? null,
  industryKey: fact.industryKey ?? null,
  contentHash: fact.contentHash,
});

const compareRows = (left: FactRow, right: FactRow): number =>
  left.stockId.localeCompare(right.stockId) ||
  left.metricId.localeCompare(right.metricId) ||
  left.periodEnd.getTime() - right.periodEnd.getTime() ||
  left.revisionPublishedAt.getTime() - right.revisionPublishedAt.getTime() ||
  left.sourceRevision.localeCompare(right.sourceRevision) ||
  left.recordedAt.getTime() - right.recordedAt.getTime() ||
  left.contentHash.localeCompare(right.contentHash) ||
  left.id.localeCompare(right.id);

const assertSupersedes = (fact: FinancialFact, superseded: FinancialFact | undefined): void => {
  if (fact.supersedesId === undefined) return;
  if (superseded === undefined) {
    throw new InvariantError(
      `FinancialFact.supersedesId 未找到目标 revision: ${fact.supersedesId}`,
    );
  }
  if (
    superseded.stockId !== fact.stockId ||
    superseded.metricId !== fact.metricId ||
    superseded.periodType !== fact.periodType ||
    superseded.periodStart?.getTime() !== fact.periodStart?.getTime() ||
    superseded.periodEnd.getTime() !== fact.periodEnd.getTime()
  ) {
    throw new InvariantError(
      'FinancialFact.supersedesId 必须指向同 stock/metric/period 的 revision',
    );
  }
  if (superseded.revisionPublishedAt >= fact.revisionPublishedAt) {
    throw new InvariantError('FinancialFact.supersedesId 必须指向较早 revision');
  }
};

/** FinancialFact 的 Drizzle/SQLite append-only 实现。 */
export class DrizzleFinancialFactRepository implements FinancialFactRepository {
  constructor(private readonly db: DrizzleDb) {}

  async appendMany(facts: readonly FinancialFact[]): Promise<void> {
    const parsed = facts.map((fact) => {
      const value = FinancialFactSchema.parse(fact);
      assertFinancialFactInvariants(value);
      return value;
    });
    if (parsed.length === 0) return;
    this.db.transaction((tx) => {
      const knownById = new Map<string, FinancialFact>();
      for (const fact of parsed) {
        let superseded: FinancialFact | undefined;
        if (fact.supersedesId !== undefined) {
          superseded = knownById.get(fact.supersedesId);
          if (superseded === undefined) {
            const targetRow = tx
              .select()
              .from(financialFactRevisions)
              .where(eq(financialFactRevisions.id, fact.supersedesId))
              .get();
            if (targetRow !== undefined) superseded = fromRow(targetRow);
          }
        }
        assertSupersedes(fact, superseded);
        const byId = tx
          .select()
          .from(financialFactRevisions)
          .where(eq(financialFactRevisions.id, fact.id))
          .get();
        if (byId !== undefined) {
          if (byId.contentHash !== fact.contentHash) {
            throw new InvariantError(`FinancialFact revision id 冲突且不得覆盖: ${fact.id}`);
          }
          knownById.set(fact.id, fromRow(byId));
          continue;
        }
        const duplicate = tx
          .select({ id: financialFactRevisions.id })
          .from(financialFactRevisions)
          .where(
            and(
              eq(financialFactRevisions.source, fact.source),
              eq(financialFactRevisions.sourceRecordId, fact.sourceRecordId),
              eq(financialFactRevisions.sourceRevision, fact.sourceRevision),
              eq(financialFactRevisions.contentHash, fact.contentHash),
            ),
          )
          .get();
        if (duplicate !== undefined) continue;
        tx.insert(financialFactRevisions).values(toRow(fact)).onConflictDoNothing().run();
        knownById.set(fact.id, fact);
      }
    });
  }

  private listRows(input: {
    readonly stockIds: readonly string[];
    readonly metricIds?: readonly string[];
    readonly from?: Date;
    readonly to?: Date;
    readonly recordedAt?: Date;
  }): FactRow[] {
    const stockIds = [...new Set(input.stockIds)].sort();
    if (stockIds.length === 0) return [];
    const metricIds =
      input.metricIds === undefined ? undefined : [...new Set(input.metricIds)].sort();
    if (metricIds !== undefined && metricIds.length === 0) return [];
    const rows: FactRow[] = [];
    const metricChunks =
      metricIds === undefined
        ? [undefined]
        : Array.from({ length: Math.ceil(metricIds.length / 400) }, (_, index) =>
            metricIds.slice(index * 400, index * 400 + 400),
          );
    for (let index = 0; index < stockIds.length; index += 400) {
      const chunk = stockIds.slice(index, index + 400);
      for (const metricChunk of metricChunks) {
        const conditions: SQL[] = [inArray(financialFactRevisions.stockId, chunk)];
        if (metricChunk !== undefined) {
          conditions.push(inArray(financialFactRevisions.metricId, metricChunk));
        }
        if (input.from !== undefined) {
          conditions.push(gte(financialFactRevisions.periodEnd, input.from));
        }
        if (input.to !== undefined) {
          conditions.push(lte(financialFactRevisions.periodEnd, input.to));
        }
        if (input.recordedAt !== undefined) {
          conditions.push(lte(financialFactRevisions.recordedAt, input.recordedAt));
        }
        rows.push(
          ...this.db
            .select()
            .from(financialFactRevisions)
            .where(and(...conditions))
            .all(),
        );
      }
    }
    return rows.sort(compareRows);
  }

  async listRevisions(input: {
    readonly stockIds: readonly string[];
    readonly metricIds?: readonly string[];
    readonly from?: Date;
    readonly to?: Date;
    readonly recordedAt?: Date;
  }): Promise<readonly FinancialFact[]> {
    return this.listRows(input).map(fromRow);
  }

  async resolveVintage(input: {
    readonly stockIds: readonly string[];
    readonly metricIds: readonly string[];
    readonly asOf: Date;
    readonly policy: 'strict-pit-v1';
  }) {
    const facts = await this.listRevisions({
      stockIds: input.stockIds,
      metricIds: input.metricIds,
    });
    return resolveStrictPitFinancialVintage({ ...input, facts });
  }
}
