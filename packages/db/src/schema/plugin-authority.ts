import type { PluginAutomationGrant, PluginOperation } from '@luoome/core';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const pluginOperations = sqliteTable(
  'plugin_operations',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    accountId: text('account_id').notNull(),
    state: text('state').notNull(),
    claimToken: text('claim_token'),
    updatedAt: integer('updated_at').notNull(),
    recordJson: text('record_json', { mode: 'json' }).$type<PluginOperation>().notNull(),
  },
  (table) => [index('plugin_operations_state_idx').on(table.state, table.updatedAt)],
);

export const pluginAutomationGrants = sqliteTable(
  'plugin_automation_grants',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    profile: text('profile').notNull(),
    sessionId: text('session_id').notNull(),
    taskId: text('task_id').notNull(),
    version: integer('version').notNull(),
    recordJson: text('record_json', { mode: 'json' }).$type<PluginAutomationGrant>().notNull(),
  },
  (table) => [
    uniqueIndex('plugin_grants_task_idx').on(
      table.userId,
      table.profile,
      table.sessionId,
      table.taskId,
    ),
  ],
);
