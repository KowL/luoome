import type { DataImportReceipt } from '@luoome/core';
import { sql } from 'drizzle-orm';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { DdlExecutor } from '../database.js';

export const dataImportReceipts = sqliteTable(
  'data_import_receipts',
  {
    userId: text('user_id').notNull(),
    accountId: text('account_id').notNull(),
    requestId: text('request_id').notNull(),
    requestHash: text('request_hash').notNull(),
    archiveDigest: text('archive_digest').notNull(),
    originalRequestId: text('original_request_id').notNull(),
    committedAt: integer('committed_at').notNull(),
    result: text('result_json', { mode: 'json' }).$type<DataImportReceipt>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.accountId, table.requestId] })],
);

export const ensureDataImportSchema = (db: DdlExecutor): void => {
  db.run(sql`CREATE TABLE IF NOT EXISTS data_import_receipts (
    user_id TEXT NOT NULL, account_id TEXT NOT NULL, request_id TEXT NOT NULL,
    request_hash TEXT NOT NULL, archive_digest TEXT NOT NULL, original_request_id TEXT NOT NULL,
    committed_at INTEGER NOT NULL, result_json TEXT NOT NULL,
    PRIMARY KEY (user_id, account_id, request_id)
  )`);
};
