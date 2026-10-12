import type { TenantExportSnapshot, TenantOperationReceipt } from '@luoome/core';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { DrizzleDb } from '../client.js';

export const tenantExportSnapshots = sqliteTable('tenant_export_snapshots', {
  operationId: text('operation_id').primaryKey(),
  inputHash: text('input_hash').notNull(),
  generation: integer('generation').notNull(),
  snapshot: text('snapshot_json', { mode: 'json' }).$type<TenantExportSnapshot>().notNull(),
  receipt: text('receipt_json', { mode: 'json' }).$type<TenantOperationReceipt>().notNull(),
});

export const ensureTenantExportSchema = (db: DrizzleDb): void => {
  db.run(
    sql`CREATE TABLE IF NOT EXISTS tenant_export_snapshots (operation_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, generation INTEGER NOT NULL, snapshot_json TEXT NOT NULL, receipt_json TEXT NOT NULL)`,
  );
};
