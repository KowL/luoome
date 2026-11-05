import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
export const goalRuns = sqliteTable(
  'goal_runs',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    requestId: text('request_id').notNull(),
    status: text('status').notNull(),
    version: integer('version').notNull(),
    recordJson: text('record_json').notNull(),
  },
  (table) => [uniqueIndex('goal_runs_request_unique').on(table.accountId, table.requestId)],
);
