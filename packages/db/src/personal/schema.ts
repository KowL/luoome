import type {
  PersonalAlertEvaluation,
  PersonalAlertPlanMutation,
  PersonalAlertPlanRemoval,
  PersonalWatchFeedback,
  WatchlistImportPreview,
  WatchlistImportResult,
  WatchlistRemovalResult,
} from '@luoome/core';
import { sql } from 'drizzle-orm';
import { integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { DdlExecutor } from '../database.js';

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

export const ensurePersonalSchema = (db: DdlExecutor): void => {
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
