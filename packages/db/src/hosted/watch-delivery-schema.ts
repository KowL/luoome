import type { WatchDeliveryIntent, WatchNotificationSettings } from '@luoome/core';
import { sql } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { DrizzleDb } from '../client.js';

export const watchNotificationSettings = sqliteTable('watch_notification_settings', {
  id: text('id').primaryKey(),
  settings: text('settings_json', { mode: 'json' }).$type<WatchNotificationSettings>().notNull(),
});
export const watchDeliveryIntents = sqliteTable('watch_delivery_intents', {
  id: text('id').primaryKey(),
  intent: text('intent_json', { mode: 'json' }).$type<WatchDeliveryIntent>().notNull(),
});
export const ensureWatchDeliverySchema = (db: DrizzleDb): void => {
  db.run(
    sql`CREATE TABLE IF NOT EXISTS watch_notification_settings (id TEXT PRIMARY KEY, settings_json TEXT NOT NULL)`,
  );
  db.run(
    sql`CREATE TABLE IF NOT EXISTS watch_delivery_intents (id TEXT PRIMARY KEY, intent_json TEXT NOT NULL)`,
  );
};
