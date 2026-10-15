import type { ReportDeliveryIntent, ReportExecutionLease } from '@luoome/core';
import { sql } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { DrizzleDb } from '../client.js';

export const reportExecution = sqliteTable('report_execution', {
  id: text('id').primaryKey(),
  lease: text('lease_json', { mode: 'json' }).$type<ReportExecutionLease>().notNull(),
});
export const reportDeliveryIntents = sqliteTable('report_delivery_intents', {
  reportId: text('report_id').primaryKey(),
  intent: text('intent_json', { mode: 'json' }).$type<ReportDeliveryIntent>().notNull(),
});
export const ensureReportAutomationSchema = (db: DrizzleDb): void => {
  db.run(
    sql`CREATE TABLE IF NOT EXISTS report_execution (id TEXT PRIMARY KEY, lease_json TEXT NOT NULL)`,
  );
  db.run(
    sql`CREATE TABLE IF NOT EXISTS report_delivery_intents (report_id TEXT PRIMARY KEY, intent_json TEXT NOT NULL)`,
  );
};
