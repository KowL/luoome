import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * 数据商快照（REQ-M4-05 层 3）。
 *
 * **独立于 `financial_fact_revisions`**：层 3 只告警，不入库。
 * 合并会让上游漂移被当成真实修订，PIT 立刻失效。
 */
export const financialIngestSnapshots = sqliteTable(
  'financial_ingest_snapshots',
  {
    id: text('id').primaryKey(),
    stockId: text('stock_id').notNull(),
    metricId: text('metric_id').notNull(),
    periodEnd: integer('period_end', { mode: 'timestamp_ms' }).notNull(),
    ingestHash: text('ingest_hash').notNull(),
    vendorUpdatedAt: integer('vendor_updated_at', { mode: 'timestamp_ms' }),
    capturedAt: integer('captured_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('financial_ingest_snapshots_lookup_idx').on(
      table.stockId,
      table.metricId,
      table.periodEnd,
    ),
  ],
);
