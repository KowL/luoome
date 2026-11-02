import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * 风险官否决（REQ-M5-04）。
 *
 * **绑定键是 `(account_id, subject_kind, subject_id)`**，不是 `context_id` ——
 * 按 context 绑定挡不住「重新取数绕过否决」。
 */
export const riskVetoes = sqliteTable(
  'risk_vetoes',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    subjectKind: text('subject_kind').notNull(),
    subjectId: text('subject_id').notNull(),
    reason: text('reason').notNull(),
    factIdsJson: text('fact_ids_json').notNull(),
    /** 仅用于证据归属校验与审计；**不是绑定键**。 */
    contextId: text('context_id').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('risk_vetoes_subject_idx').on(table.accountId, table.subjectKind, table.subjectId),
  ],
);

/** 人工推翻否决（REQ-M5-04「升级路径」）。 */
export const riskVetoOverrides = sqliteTable('risk_veto_overrides', {
  id: text('id').primaryKey(),
  vetoId: text('veto_id').notNull(),
  /** **只能是 `'user'`**：不接受 agent 自述身份。 */
  overriddenBy: text('overridden_by').notNull(),
  reason: text('reason').notNull(),
  newFactIdsJson: text('new_fact_ids_json').notNull(),
  overriddenAt: integer('overridden_at', { mode: 'timestamp_ms' }).notNull(),
});
