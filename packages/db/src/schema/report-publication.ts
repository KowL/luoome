import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * 报告发布记录（REQ-M5-02）。
 *
 * `report_id` 是**主键**：同一报告只能发布一次，不保留历史发布记录
 * （「重新发布」是另一个需求，当前不支持）。
 */
export const reportPublications = sqliteTable('report_publications', {
  reportId: text('report_id').primaryKey(),
  version: integer('version').notNull(),
  publishedAt: integer('published_at', { mode: 'timestamp_ms' }).notNull(),
  documentHash: text('document_hash').notNull(),
  frozenAt: integer('frozen_at', { mode: 'timestamp_ms' }).notNull(),
});
