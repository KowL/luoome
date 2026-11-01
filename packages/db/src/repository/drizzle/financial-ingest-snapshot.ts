import type { FinancialIngestSnapshot, FinancialIngestSnapshotRepository } from '@luoome/core';
import { and, desc, eq } from 'drizzle-orm';

import type { DrizzleDatabase } from '../../database.js';
import { financialIngestSnapshots as table } from '../../schema/financial-ingest-snapshot.js';
import type { Schema } from '../../schema/index.js';

/** `financial_ingest_snapshots` 的 drizzle 实现（REQ-M4-05 层 3）。 */
export class DrizzleFinancialIngestSnapshotRepository implements FinancialIngestSnapshotRepository {
  constructor(private readonly db: DrizzleDatabase<Schema>) {}

  async append(snapshot: FinancialIngestSnapshot): Promise<void> {
    // 幂等：同 (stock, metric, periodEnd, hash) 已存在则跳过。
    const existing = this.db
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          eq(table.stockId, snapshot.stockId),
          eq(table.metricId, snapshot.metricId),
          eq(table.periodEnd, snapshot.periodEnd),
          eq(table.ingestHash, snapshot.ingestHash),
        ),
      )
      .get();
    if (existing !== undefined) return;
    this.db
      .insert(table)
      .values({
        id: snapshot.id,
        stockId: snapshot.stockId,
        metricId: snapshot.metricId,
        periodEnd: snapshot.periodEnd,
        ingestHash: snapshot.ingestHash,
        vendorUpdatedAt: snapshot.vendorUpdatedAt,
        capturedAt: snapshot.capturedAt,
      })
      .run();
  }

  async latest(input: {
    readonly stockId: string;
    readonly metricId: string;
    readonly periodEnd: Date;
  }): Promise<FinancialIngestSnapshot | null> {
    const row = this.db
      .select()
      .from(table)
      .where(
        and(
          eq(table.stockId, input.stockId),
          eq(table.metricId, input.metricId),
          eq(table.periodEnd, input.periodEnd),
        ),
      )
      .orderBy(desc(table.capturedAt))
      .limit(1)
      .get();
    if (row === undefined) return null;
    return {
      id: row.id,
      stockId: row.stockId,
      metricId: row.metricId,
      periodEnd: row.periodEnd,
      ingestHash: row.ingestHash,
      vendorUpdatedAt: row.vendorUpdatedAt,
      capturedAt: row.capturedAt,
    };
  }
}
