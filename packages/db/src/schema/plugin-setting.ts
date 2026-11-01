import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * 插件设置（REQ-M4-06）。
 *
 * **极窄 KV**：`value` 是字符串，语义由 core 的 `assertSettingValue` 校验。
 * 刻意不存 JSON——一旦允许，这张表会变成第二个 `record_json`，什么状态都往里塞。
 */
export const pluginSettings = sqliteTable('plugin_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
