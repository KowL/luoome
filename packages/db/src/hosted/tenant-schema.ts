import type {
  PersonalAlertEvaluation,
  PersonalAlertPlanMutation,
  PersonalAlertPlanRemoval,
  PersonalWatchFeedback,
  TenantExecutionLease,
  TenantExecutionRequest,
  TenantOperationReceipt,
  TenantOutbox,
  WatchlistImportPreview,
  WatchlistImportResult,
  WatchlistRemovalResult,
} from '@luoome/core';
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { DrizzleDb } from '../client.js';

export const tenantExecutionRequests = sqliteTable('tenant_execution_requests', {
  operationId: text('operation_id').primaryKey(),
  inputHash: text('input_hash').notNull(),
  generation: integer('generation').notNull(),
  request: text('request_json', { mode: 'json' }).$type<TenantExecutionRequest>().notNull(),
});
export const tenantExecutionLeases = sqliteTable('tenant_execution_leases', {
  operationId: text('operation_id').primaryKey(),
  lease: text('lease_json', { mode: 'json' }).$type<TenantExecutionLease>().notNull(),
});
export const tenantOperationReceipts = sqliteTable('tenant_operation_receipts', {
  operationId: text('operation_id').primaryKey(),
  receipt: text('receipt_json', { mode: 'json' }).$type<TenantOperationReceipt>().notNull(),
});
export const tenantOutbox = sqliteTable(
  'tenant_outbox',
  {
    eventId: text('event_id').primaryKey(),
    operationId: text('operation_id').notNull(),
    event: text('event_json', { mode: 'json' }).$type<TenantOutbox>().notNull(),
    acknowledgedAt: integer('acknowledged_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    uniqueIndex('tenant_outbox_operation_unique').on(t.operationId),
    index('tenant_outbox_ack_idx').on(t.acknowledgedAt),
  ],
);
export const watchlistImportPreviews = sqliteTable('watchlist_import_previews', {
  id: text('id').primaryKey(),
  preview: text('preview_json', { mode: 'json' }).$type<WatchlistImportPreview>().notNull(),
});
export const watchlistImportBatches = sqliteTable('watchlist_import_batches', {
  operationId: text('operation_id').primaryKey(),
  previewId: text('preview_id').notNull(),
  result: text('result_json', { mode: 'json' }).$type<WatchlistImportResult>().notNull(),
});
export const personalWatchFeedback = sqliteTable(
  'personal_watch_feedback',
  {
    triggerId: text('trigger_id').notNull(),
    revision: integer('revision').notNull(),
    requestId: text('request_id').notNull(),
    feedback: text('feedback_json', { mode: 'json' }).$type<PersonalWatchFeedback>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.triggerId, t.revision] }),
    uniqueIndex('personal_watch_feedback_request_unique').on(t.triggerId, t.requestId),
  ],
);
export const watchlistFactsReportKeys = sqliteTable('watchlist_facts_report_keys', {
  identity: text('identity').primaryKey(),
  reportId: text('report_id').notNull(),
});
export const watchlistRemovalReceipts = sqliteTable('watchlist_removal_receipts', {
  operationId: text('operation_id').primaryKey(),
  result: text('result_json', { mode: 'json' }).$type<WatchlistRemovalResult>().notNull(),
});
export const personalAlertPlanMutations = sqliteTable('personal_alert_plan_mutations', {
  operationId: text('operation_id').primaryKey(),
  result: text('result_json', { mode: 'json' })
    .$type<PersonalAlertPlanMutation | PersonalAlertPlanRemoval>()
    .notNull(),
});
export const personalAlertEvaluations = sqliteTable(
  'personal_alert_evaluations',
  {
    id: text('id').primaryKey(),
    operationId: text('operation_id').notNull(),
    evaluation: text('evaluation_json', { mode: 'json' })
      .$type<PersonalAlertEvaluation>()
      .notNull(),
  },
  (t) => [uniqueIndex('personal_alert_evaluations_operation_unique').on(t.operationId)],
);

export const ensureTenantSchema = (db: DrizzleDb): void => {
  db.run(
    sql`CREATE TABLE IF NOT EXISTS personal_alert_plan_mutations (operation_id TEXT PRIMARY KEY, result_json TEXT NOT NULL)`,
  );
  db.run(
    sql`CREATE TABLE IF NOT EXISTS personal_alert_evaluations (id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, evaluation_json TEXT NOT NULL)`,
  );
  db.run(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS personal_alert_evaluations_operation_unique ON personal_alert_evaluations (operation_id)`,
  );
  db.run(
    sql`CREATE TABLE IF NOT EXISTS tenant_execution_requests (operation_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, generation INTEGER NOT NULL, request_json TEXT NOT NULL)`,
  );
  db.run(
    sql`CREATE TABLE IF NOT EXISTS tenant_execution_leases (operation_id TEXT PRIMARY KEY, lease_json TEXT NOT NULL)`,
  );
  db.run(
    sql`CREATE TABLE IF NOT EXISTS tenant_operation_receipts (operation_id TEXT PRIMARY KEY, receipt_json TEXT NOT NULL)`,
  );
  db.run(
    sql`CREATE TABLE IF NOT EXISTS tenant_outbox (event_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, event_json TEXT NOT NULL, acknowledged_at INTEGER)`,
  );
  db.run(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS tenant_outbox_operation_unique ON tenant_outbox (operation_id)`,
  );
  db.run(sql`CREATE INDEX IF NOT EXISTS tenant_outbox_ack_idx ON tenant_outbox (acknowledged_at)`);
  db.run(
    sql`CREATE TABLE IF NOT EXISTS watchlist_import_previews (id TEXT PRIMARY KEY, preview_json TEXT NOT NULL)`,
  );
  db.run(
    sql`CREATE TABLE IF NOT EXISTS watchlist_import_batches (operation_id TEXT PRIMARY KEY, preview_id TEXT NOT NULL, result_json TEXT NOT NULL)`,
  );
  db.run(
    sql`CREATE TABLE IF NOT EXISTS personal_watch_feedback (trigger_id TEXT NOT NULL, revision INTEGER NOT NULL, request_id TEXT NOT NULL, feedback_json TEXT NOT NULL, PRIMARY KEY (trigger_id, revision))`,
  );
  db.run(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS personal_watch_feedback_request_unique ON personal_watch_feedback (trigger_id, request_id)`,
  );
  db.run(
    sql`CREATE TABLE IF NOT EXISTS watchlist_facts_report_keys (identity TEXT PRIMARY KEY, report_id TEXT NOT NULL)`,
  );
  db.run(
    sql`CREATE TABLE IF NOT EXISTS watchlist_removal_receipts (operation_id TEXT PRIMARY KEY, result_json TEXT NOT NULL)`,
  );
};
