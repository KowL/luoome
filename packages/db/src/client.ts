import { Database } from 'bun:sqlite';
import type { RepositoryRegistry } from '@luoome/core';
import { sql } from 'drizzle-orm';
import { type BunSQLiteDatabase, drizzle } from 'drizzle-orm/bun-sqlite';
import {
  DrizzleAccountRepository,
  DrizzleAdviceRepository,
  DrizzleAlertPlanRepository,
  DrizzleChatRepository,
  DrizzleDailyBarRepository,
  DrizzleHoldingRepository,
  DrizzleNotificationRepository,
  DrizzleQuoteRepository,
  DrizzleReportRepository,
  DrizzleResearchIndexRepository,
  DrizzleResearchVaultSyncRunRepository,
  DrizzleSignalObservationRepository,
  DrizzleStockEventRepository,
  DrizzleStockRepository,
  DrizzleStockUniverseRepository,
  DrizzleStrategyRepository,
  DrizzleStrategyRunRepository,
  DrizzleStrategyScheduleRepository,
  DrizzleTradeRepository,
  DrizzleWatchlistMemberRepository,
  DrizzleWatchlistRepository,
  DrizzleWatchRuleStateRepository,
  DrizzleWatchRunRepository,
  DrizzleWatchTriggerRepository,
  DrizzleWorkflowRunRepository,
} from './repository/drizzle/index.js';
import { type Schema, schema } from './schema/index.js';

/** Drizzle + bun:sqlite 的数据库句柄类型（绑定本包 schema）。 */
export type DrizzleDb = BunSQLiteDatabase<Schema>;

/**
 * 编程式建表（CREATE TABLE IF NOT EXISTS）。
 *
 * v0.1 不引入 drizzle-kit：建表 DDL 与 src/schema 的 Drizzle 定义手工保持一致
 * （列名 / 类型 / 可空 / 唯一约束），可重复执行（幂等）。
 * 后续版本若接入 drizzle-kit migration，本函数应被 migrate 取代。
 */
export const ensureSchema = (db: DrizzleDb): void => {
  db.run(sql`
    CREATE TABLE IF NOT EXISTS research_topic_index (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT, tags TEXT NOT NULL,
      vault_id TEXT NOT NULL, relative_path TEXT NOT NULL, content_hash TEXT NOT NULL, archived_at INTEGER,
      file_modified_at INTEGER NOT NULL, indexed_at INTEGER NOT NULL, availability TEXT NOT NULL, diagnostic TEXT
    )
  `);
  db.run(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS research_topic_index_vault_path_unique ON research_topic_index (vault_id, relative_path)`,
  );
  db.run(
    sql`CREATE INDEX IF NOT EXISTS research_topic_index_kind_archive_idx ON research_topic_index (kind, archived_at)`,
  );
  db.run(sql`
    CREATE TABLE IF NOT EXISTS research_document_index (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, author TEXT, source_url TEXT, source_status TEXT,
      published_at INTEGER, observed_at INTEGER, imported_at INTEGER NOT NULL, tags TEXT NOT NULL, vault_id TEXT NOT NULL,
      relative_path TEXT NOT NULL, attachment_paths TEXT NOT NULL, content_hash TEXT NOT NULL, excerpt TEXT,
      file_modified_at INTEGER NOT NULL, indexed_at INTEGER NOT NULL, availability TEXT NOT NULL, diagnostic TEXT
    )
  `);
  db.run(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS research_document_index_vault_path_unique ON research_document_index (vault_id, relative_path)`,
  );
  db.run(
    sql`CREATE INDEX IF NOT EXISTS research_document_index_published_idx ON research_document_index (published_at)`,
  );
  db.run(
    sql`CREATE INDEX IF NOT EXISTS research_document_index_observed_idx ON research_document_index (observed_at)`,
  );
  db.run(
    sql`CREATE TABLE IF NOT EXISTS research_topic_documents (topic_id TEXT NOT NULL, document_id TEXT NOT NULL, relation TEXT NOT NULL, sort_order INTEGER, PRIMARY KEY (topic_id, document_id, relation))`,
  );
  db.run(
    sql`CREATE INDEX IF NOT EXISTS research_topic_documents_document_idx ON research_topic_documents (document_id)`,
  );
  db.run(
    sql`CREATE TABLE IF NOT EXISTS research_subject_links (owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_key TEXT NOT NULL, relation TEXT NOT NULL, PRIMARY KEY (owner_kind, owner_id, subject_kind, subject_key, relation))`,
  );
  db.run(
    sql`CREATE INDEX IF NOT EXISTS research_subject_links_subject_idx ON research_subject_links (subject_kind, subject_key, owner_kind)`,
  );
  db.run(
    sql`CREATE TABLE IF NOT EXISTS research_document_chunks (document_id TEXT NOT NULL, ordinal INTEGER NOT NULL, heading_path TEXT NOT NULL, content_hash TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (document_id, ordinal))`,
  );
  // FTS5 是可重建投影，不是权威业务表；旧 SQLite/构建不支持时保留 metadata 降级。
  try {
    db.run(
      sql`CREATE VIRTUAL TABLE IF NOT EXISTS research_document_fts USING fts5(document_id UNINDEXED, ordinal UNINDEXED, content_hash UNINDEXED, title, heading_path, body, tokenize='unicode61')`,
    );
  } catch {
    // searchCapability() 会检测到虚表不可用并返回 metadata。
  }
  db.run(
    sql`CREATE TABLE IF NOT EXISTS research_vault_sync_runs (id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, scanned INTEGER NOT NULL, added INTEGER NOT NULL, updated INTEGER NOT NULL, unchanged INTEGER NOT NULL, missing INTEGER NOT NULL, invalid INTEGER NOT NULL, conflicts INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, error TEXT)`,
  );
  db.run(
    sql`CREATE INDEX IF NOT EXISTS research_vault_sync_runs_vault_started_idx ON research_vault_sync_runs (vault_id, started_at)`,
  );
  db.run(sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL,
      checksum TEXT NOT NULL,
      details_json TEXT NOT NULL
    )
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS signal_observations (
      id TEXT PRIMARY KEY, source_kind TEXT NOT NULL, source_id TEXT NOT NULL, stock_id TEXT NOT NULL,
      baseline_price REAL, baseline_at INTEGER, horizon TEXT NOT NULL, close_price REAL, return_pct REAL,
      max_favorable_excursion_pct REAL, max_adverse_excursion_pct REAL, benchmark_return_pct REAL,
      benchmark_status TEXT NOT NULL, status TEXT NOT NULL, provenance TEXT NOT NULL,
      unavailable_reason TEXT, observed_at INTEGER
    )
  `);
  db.run(
    sql`CREATE INDEX IF NOT EXISTS signal_observations_status_baseline_idx ON signal_observations (status, baseline_at)`,
  );
  db.run(
    sql`CREATE INDEX IF NOT EXISTS signal_observations_source_idx ON signal_observations (source_kind, source_id)`,
  );
  db.run(sql`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(sql`
    CREATE INDEX IF NOT EXISTS chat_sessions_account_updated_idx
    ON chat_sessions (account_id, updated_at)
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      parts TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(sql`
    CREATE INDEX IF NOT EXISTS chat_messages_session_created_idx
    ON chat_messages (session_id, created_at)
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      currency TEXT NOT NULL,
      initial_capital REAL NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS stocks (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      exchange TEXT NOT NULL,
      name TEXT NOT NULL,
      industry TEXT,
      name_source TEXT NOT NULL DEFAULT 'manual',
      name_updated_at INTEGER,
      updated_at INTEGER NOT NULL DEFAULT 0
    )
  `);
  migrateStockProvenanceColumns(db);
  db.run(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS stocks_code_exchange_unique
    ON stocks (code, exchange)
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS stock_universe_memberships (
      source TEXT NOT NULL,
      coverage TEXT NOT NULL,
      stock_id TEXT NOT NULL,
      observed_name TEXT NOT NULL,
      listing_status TEXT NOT NULL,
      state TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      missing_since INTEGER,
      last_sync_id TEXT NOT NULL,
      metadata TEXT,
      CONSTRAINT stock_universe_memberships_pk PRIMARY KEY (source, coverage, stock_id)
    )
  `);
  db.run(sql`
    CREATE INDEX IF NOT EXISTS stock_universe_memberships_coverage_state_idx
    ON stock_universe_memberships (coverage, state, stock_id)
  `);
  db.run(sql`
    CREATE INDEX IF NOT EXISTS stock_universe_memberships_stock_idx
    ON stock_universe_memberships (stock_id)
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS stock_universe_sync_runs (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      coverage TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      observed_at INTEGER,
      reported_total INTEGER,
      observed_count INTEGER NOT NULL DEFAULT 0,
      created_stocks INTEGER NOT NULL DEFAULT 0,
      updated_stocks INTEGER NOT NULL DEFAULT 0,
      reactivated INTEGER NOT NULL DEFAULT 0,
      marked_missing INTEGER NOT NULL DEFAULT 0,
      error_kind TEXT,
      error_message TEXT
    )
  `);
  db.run(sql`
    CREATE INDEX IF NOT EXISTS stock_universe_sync_runs_source_coverage_finished_idx
    ON stock_universe_sync_runs (source, coverage, finished_at)
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS holdings (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      stock_id TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      available_quantity INTEGER NOT NULL,
      avg_cost REAL NOT NULL,
      opened_at INTEGER NOT NULL,
      closed_at INTEGER
    )
  `);
  db.run(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS holdings_account_stock_unique
    ON holdings (account_id, stock_id)
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      stock_id TEXT NOT NULL,
      side TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      price REAL NOT NULL,
      fee REAL NOT NULL,
      executed_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS advices (
      id TEXT PRIMARY KEY,
      subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      stock_name TEXT,
      decision TEXT NOT NULL,
      confidence REAL NOT NULL,
      horizon TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      risks TEXT NOT NULL,
      disclaimers TEXT NOT NULL,
      source_tool TEXT,
      source_workflow TEXT,
      based_on TEXT NOT NULL,
      valid_from INTEGER NOT NULL,
      valid_until INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  migrateAdviceStockNameColumn(db);
  db.run(sql`
    CREATE INDEX IF NOT EXISTS advices_subject_idx ON advices (subject_kind, subject_id)
  `);
  db.run(sql`
    CREATE INDEX IF NOT EXISTS advices_created_at_idx ON advices (created_at)
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS advice_outcomes (
      advice_id TEXT PRIMARY KEY,
      outcome TEXT NOT NULL,
      pnl REAL,
      benchmark_pnl REAL,
      recorded_at INTEGER NOT NULL
    )
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS price_snapshots (
      stock_id TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL,
      timestamp_source TEXT NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume INTEGER NOT NULL,
      amount REAL,
      turnover_rate REAL,
      prev_close REAL,
      source TEXT NOT NULL,
      CONSTRAINT price_snapshots_pk PRIMARY KEY (stock_id, observed_at, source)
    )
  `);
  migratePriceSnapshotTimeColumns(db);
  migratePriceSnapshotPrevCloseColumn(db);
  migratePriceSnapshotAmountColumns(db);
  db.run(sql`
    CREATE INDEX IF NOT EXISTS price_snapshots_stock_observed_idx
    ON price_snapshots (stock_id, observed_at)
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS daily_bars (
      stock_id TEXT NOT NULL,
      date INTEGER NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume INTEGER NOT NULL,
      adj_factor REAL NOT NULL,
      adjustment TEXT NOT NULL DEFAULT 'raw',
      source_adj_factor REAL,
      source TEXT NOT NULL,
      CONSTRAINT daily_bars_pk PRIMARY KEY (stock_id, date)
    )
  `);
  migrateDailyBarAdjustmentColumns(db);
  db.run(sql`
    CREATE INDEX IF NOT EXISTS daily_bars_stock_idx ON daily_bars (stock_id)
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS strategies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      owner TEXT NOT NULL,
      status TEXT NOT NULL,
      current_version_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(sql`CREATE INDEX IF NOT EXISTS strategies_status_idx ON strategies (status)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS strategies_owner_idx ON strategies (owner)`);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS strategy_versions (
      id TEXT PRIMARY KEY,
      strategy_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      definition_json TEXT NOT NULL,
      definition_hash TEXT NOT NULL,
      parent_version_id TEXT,
      change_summary TEXT,
      fact_references_json TEXT,
      agent_trace_json TEXT,
      validation_status TEXT NOT NULL,
      validation_errors_json TEXT NOT NULL,
      published_at INTEGER,
      created_at INTEGER NOT NULL
    )
  `);
  migrateStrategyVersionAuditColumns(db);
  db.run(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS strategy_versions_strategy_version_unique
    ON strategy_versions (strategy_id, version)
  `);
  db.run(
    sql`CREATE INDEX IF NOT EXISTS strategy_versions_hash_idx ON strategy_versions (definition_hash)`,
  );
  db.run(sql`
    CREATE TABLE IF NOT EXISTS strategy_runs (
      id TEXT PRIMARY KEY,
      strategy_id TEXT NOT NULL,
      strategy_version_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      coverage TEXT NOT NULL,
      data_as_of INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL,
      input_snapshot_json TEXT NOT NULL,
      provider_statuses_json TEXT NOT NULL,
      summary_json TEXT,
      error TEXT
    )
  `);
  db.run(
    sql`CREATE INDEX IF NOT EXISTS strategy_runs_strategy_started_idx ON strategy_runs (strategy_id, started_at)`,
  );
  db.run(
    sql`CREATE INDEX IF NOT EXISTS strategy_runs_status_started_idx ON strategy_runs (status, started_at)`,
  );
  db.run(sql`
    CREATE TABLE IF NOT EXISTS strategy_schedules (
      id TEXT PRIMARY KEY,
      strategy_id TEXT NOT NULL,
      cron TEXT NOT NULL,
      timezone TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      recommendation_policy_json TEXT,
      next_run_at INTEGER,
      last_run_id TEXT,
      lease_owner TEXT,
      lease_until INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  const strategyScheduleColumns = new Set(
    db.all<{ name: string }>(sql`PRAGMA table_info(strategy_schedules)`).map((row) => row.name),
  );
  if (!strategyScheduleColumns.has('recommendation_policy_json')) {
    db.run(sql`ALTER TABLE strategy_schedules ADD COLUMN recommendation_policy_json TEXT`);
  }
  db.run(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS strategy_schedules_strategy_unique ON strategy_schedules (strategy_id)`,
  );
  db.run(
    sql`CREATE INDEX IF NOT EXISTS strategy_schedules_due_idx ON strategy_schedules (enabled, next_run_at)`,
  );
  db.run(
    sql`CREATE INDEX IF NOT EXISTS strategy_schedules_lease_idx ON strategy_schedules (lease_until)`,
  );
  db.run(sql`
    CREATE TABLE IF NOT EXISTS strategy_run_leases (
      strategy_id TEXT NOT NULL,
      strategy_version_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      lease_until INTEGER NOT NULL,
      PRIMARY KEY (strategy_id, strategy_version_id)
    )
  `);
  db.run(
    sql`CREATE INDEX IF NOT EXISTS strategy_run_leases_until_idx ON strategy_run_leases (lease_until)`,
  );
  db.run(sql`
    CREATE TABLE IF NOT EXISTS strategy_results (
      run_id TEXT NOT NULL,
      stock_id TEXT NOT NULL,
      selected INTEGER NOT NULL,
      score REAL,
      rank INTEGER,
      rule_evaluations_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      data_as_of INTEGER NOT NULL,
      PRIMARY KEY (run_id, stock_id)
    )
  `);
  db.run(
    sql`CREATE INDEX IF NOT EXISTS strategy_results_run_rank_idx ON strategy_results (run_id, rank)`,
  );
  db.run(sql`
    CREATE TABLE IF NOT EXISTS strategy_signals (
      id TEXT PRIMARY KEY,
      strategy_id TEXT NOT NULL,
      strategy_version_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      stock_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      score REAL NOT NULL,
      direction TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      evaluation_snapshot_json TEXT NOT NULL
    )
  `);
  db.run(sql`DROP INDEX IF EXISTS strategy_signals_identity_unique`);
  db.run(sql`DROP INDEX IF EXISTS strategy_signals_run_identity_unique`);
  db.run(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS strategy_signals_run_event_unique
    ON strategy_signals (run_id, rule_id, stock_id, ts)
  `);
  db.run(
    sql`CREATE INDEX IF NOT EXISTS strategy_signals_strategy_ts_idx ON strategy_signals (strategy_id, ts)`,
  );
  db.run(
    sql`CREATE INDEX IF NOT EXISTS strategy_signals_run_ts_idx ON strategy_signals (run_id, ts)`,
  );
  db.run(
    sql`CREATE INDEX IF NOT EXISTS strategy_signals_stock_ts_idx ON strategy_signals (stock_id, ts)`,
  );
  db.run(sql`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      payload TEXT NOT NULL,
      result TEXT NOT NULL,
      error_message TEXT,
      advice_id TEXT,
      tactic_signal_id TEXT,
      sent_at INTEGER NOT NULL
    )
  `);
  db.run(sql`CREATE INDEX IF NOT EXISTS notifications_advice_idx ON notifications (advice_id)`);
  db.run(
    sql`CREATE INDEX IF NOT EXISTS notifications_signal_idx ON notifications (tactic_signal_id)`,
  );
  db.run(
    sql`CREATE INDEX IF NOT EXISTS notifications_result_idx ON notifications (result, sent_at)`,
  );
  db.run(sql`
    CREATE TABLE IF NOT EXISTS alert_plans (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
      watchlist_id TEXT NOT NULL, rules TEXT NOT NULL, logic TEXT NOT NULL,
      trigger_mode TEXT NOT NULL, priority TEXT, cooldown_minutes INTEGER NOT NULL,
      daily_notification_limit INTEGER NOT NULL, notify_on_recovery INTEGER NOT NULL,
      enabled INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )
  `);
  db.run(sql`CREATE INDEX IF NOT EXISTS alert_plans_watchlist_idx ON alert_plans (watchlist_id)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS alert_plans_enabled_idx ON alert_plans (enabled)`);
  // v0.6 起：盯盘触发。v0.7 增 rule_id / trigger_type / priority / delivery_status /
  // notification_id / eval_snapshot / feedback / feedback_at，并把 cooldown 索引改用 rule_id
  // （§3.4 / §3.7）。
  db.run(sql`
    CREATE TABLE IF NOT EXISTS watch_triggers (
      id TEXT PRIMARY KEY,
      alert_plan_id TEXT,
      pool_id TEXT NOT NULL,
      stock_id TEXT NOT NULL,
      rule_kind TEXT NOT NULL,
      direction TEXT NOT NULL,
      reason TEXT NOT NULL,
      evidence TEXT NOT NULL,
      quote_close REAL,
      quote_ts INTEGER,
      notified INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      rule_id TEXT NOT NULL DEFAULT '',
      trigger_type TEXT NOT NULL DEFAULT 'triggered',
      priority TEXT NOT NULL DEFAULT 'normal',
      delivery_status TEXT NOT NULL DEFAULT 'not-requested',
      notification_id TEXT,
      eval_snapshot TEXT NOT NULL DEFAULT '{}',
      feedback TEXT,
      feedback_at INTEGER,
      event_id TEXT
    )
  `);
  migrateStrategyAlertTriggerColumns(db);
  migrateRuoTriggerColumns(db);
  // 重建索引（列从 rule_kind 改到 rule_id）
  db.run(sql`DROP INDEX IF EXISTS watch_triggers_pool_stock_rule_ts_idx`);
  db.run(
    sql`CREATE INDEX IF NOT EXISTS watch_triggers_pool_stock_rule_ts_idx ON watch_triggers (pool_id, stock_id, rule_id, created_at)`,
  );
  db.run(
    sql`CREATE INDEX IF NOT EXISTS watch_triggers_pool_ts_idx ON watch_triggers (pool_id, created_at)`,
  );
  db.run(
    sql`CREATE INDEX IF NOT EXISTS watch_triggers_pool_stock_rule_event_idx ON watch_triggers (pool_id, stock_id, rule_id, event_id, created_at)`,
  );
  // v0.7 起：边沿状态机表（§3.5）
  db.run(sql`
    CREATE TABLE IF NOT EXISTS watch_rule_states (
      alert_plan_id TEXT,
      pool_id TEXT NOT NULL,
      stock_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      active INTEGER NOT NULL,
      first_triggered_at INTEGER,
      last_evaluated_at INTEGER NOT NULL,
      last_value REAL,
      last_recovered_at INTEGER,
      PRIMARY KEY (pool_id, stock_id, rule_id)
    )
  `);
  db.run(sql`CREATE INDEX IF NOT EXISTS watch_rule_states_pool_idx ON watch_rule_states (pool_id)`);
  migrateAlertPlanReferenceColumns(db);
  // v0.6 起：每轮 watch 心跳。v0.7 增 suppressed_by_daily_limit / notify_failed（§3.6）。
  db.run(sql`
    CREATE TABLE IF NOT EXISTS watch_runs (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      evaluated_pools INTEGER NOT NULL,
      evaluated_stocks INTEGER NOT NULL,
      triggered INTEGER NOT NULL,
      notified INTEGER NOT NULL,
      suppressed_by_cooldown INTEGER NOT NULL,
      error TEXT,
      suppressed_by_daily_limit INTEGER NOT NULL DEFAULT 0,
      notify_failed INTEGER NOT NULL DEFAULT 0
    )
  `);
  migrateStrategyAlertRunColumns(db);
  db.run(sql`CREATE INDEX IF NOT EXISTS watch_runs_started_at_idx ON watch_runs (started_at)`);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS watchlists (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, kind TEXT NOT NULL,
      membership_policy TEXT NOT NULL, enabled INTEGER NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )
  `);
  db.run(sql`CREATE INDEX IF NOT EXISTS watchlists_enabled_idx ON watchlists (enabled)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS watchlists_kind_idx ON watchlists (kind)`);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS watchlist_members (
      id TEXT PRIMARY KEY, watchlist_id TEXT NOT NULL, stock_id TEXT NOT NULL,
      stage TEXT NOT NULL, priority TEXT NOT NULL, first_added_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL, archived_at INTEGER
    )
  `);
  db.run(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS watchlist_members_watchlist_stock_unique
    ON watchlist_members (watchlist_id, stock_id)
  `);
  db.run(sql`
    CREATE INDEX IF NOT EXISTS watchlist_members_watchlist_stage_idx
    ON watchlist_members (watchlist_id, stage)
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS watchlist_member_sources (
      id TEXT PRIMARY KEY, member_id TEXT NOT NULL, kind TEXT NOT NULL, source_key TEXT NOT NULL,
      source_id TEXT, source_version_id TEXT, sync_run_id TEXT, reason TEXT NOT NULL,
      score REAL, rank INTEGER, status TEXT NOT NULL, evidence_json TEXT NOT NULL,
      data_as_of INTEGER, valid_from INTEGER NOT NULL, valid_until INTEGER
    )
  `);
  db.run(sql`
    CREATE INDEX IF NOT EXISTS watchlist_sources_member_status_idx
    ON watchlist_member_sources (member_id, status)
  `);
  db.run(sql`
    CREATE INDEX IF NOT EXISTS watchlist_sources_key_status_idx
    ON watchlist_member_sources (source_key, status)
  `);
  db.run(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS watchlist_sources_current_unique
    ON watchlist_member_sources (member_id, source_key) WHERE status <> 'ended'
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS watchlist_sync_runs (
      id TEXT PRIMARY KEY, watchlist_id TEXT NOT NULL, source_kind TEXT NOT NULL,
      source_key TEXT NOT NULL, producer_run_id TEXT, status TEXT NOT NULL, data_as_of INTEGER,
      started_at INTEGER NOT NULL, finished_at INTEGER, entered_count INTEGER NOT NULL,
      exited_count INTEGER NOT NULL, unchanged_count INTEGER NOT NULL,
      missing_dimensions_json TEXT NOT NULL, error TEXT
    )
  `);
  db.run(sql`
    CREATE INDEX IF NOT EXISTS watchlist_sync_runs_watchlist_started_idx
    ON watchlist_sync_runs (watchlist_id, started_at)
  `);
  db.run(sql`
    CREATE INDEX IF NOT EXISTS watchlist_sync_runs_producer_idx
    ON watchlist_sync_runs (producer_run_id)
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS membership_snapshots (
      id TEXT PRIMARY KEY, sync_run_id TEXT NOT NULL, stock_id TEXT NOT NULL,
      selected INTEGER NOT NULL, change TEXT NOT NULL, reason TEXT NOT NULL,
      score REAL, rank INTEGER, evidence_json TEXT NOT NULL, data_as_of INTEGER
    )
  `);
  db.run(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS membership_snapshots_run_stock_unique
    ON membership_snapshots (sync_run_id, stock_id)
  `);
  db.run(sql`
    CREATE INDEX IF NOT EXISTS membership_snapshots_run_change_idx
    ON membership_snapshots (sync_run_id, change)
  `);
  // ruo 迁移起（docs/ddd/ruo-feature-migration-detailed-design.md §3）：公司事件 + workflow 审计
  db.run(sql`
    CREATE TABLE IF NOT EXISTS stock_events (
      id TEXT PRIMARY KEY,
      stock_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      occurs_at INTEGER NOT NULL,
      all_day INTEGER NOT NULL,
      importance TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      provider TEXT,
      external_id TEXT,
      source_url TEXT,
      observed_at INTEGER,
      fetched_at INTEGER,
      stale INTEGER NOT NULL,
      remind_before_days TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS stock_events_provider_external_unique ON stock_events (provider, external_id)`,
  );
  db.run(
    sql`CREATE INDEX IF NOT EXISTS stock_events_stock_occurs_idx ON stock_events (stock_id, occurs_at)`,
  );
  db.run(
    sql`CREATE INDEX IF NOT EXISTS stock_events_occurs_status_idx ON stock_events (occurs_at, status)`,
  );
  db.run(
    sql`CREATE INDEX IF NOT EXISTS stock_events_stock_kind_occurs_idx ON stock_events (stock_id, kind, occurs_at)`,
  );
  db.run(sql`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      input_summary TEXT,
      output_summary TEXT,
      provider_statuses TEXT NOT NULL DEFAULT '[]',
      error TEXT
    )
  `);
  db.run(
    sql`CREATE INDEX IF NOT EXISTS workflow_runs_name_started_idx ON workflow_runs (workflow_name, started_at)`,
  );
  db.run(sql`CREATE INDEX IF NOT EXISTS workflow_runs_started_idx ON workflow_runs (started_at)`);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      title TEXT NOT NULL,
      generated_at INTEGER NOT NULL,
      data_as_of INTEGER NOT NULL,
      status TEXT NOT NULL,
      sections_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      missing_dimensions_json TEXT NOT NULL DEFAULT '[]',
      delivery_status TEXT NOT NULL DEFAULT 'not-requested',
      workflow_run_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS reports_period_unique
    ON reports (kind, scope_key, period_start, period_end)
  `);
  db.run(sql`CREATE INDEX IF NOT EXISTS reports_period_end_idx ON reports (period_end)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS reports_kind_period_end_idx ON reports (kind, period_end)`);
  db.run(
    sql`CREATE INDEX IF NOT EXISTS reports_status_period_end_idx ON reports (status, period_end)`,
  );
  db.run(sql`CREATE INDEX IF NOT EXISTS reports_workflow_run_idx ON reports (workflow_run_id)`);
  // 阶段 C 存量数据迁移：v0.5 → MVP（AccountKind 收窄到 'real'）—— 见下方函数。
  migrateLegacyAccountKinds(db);
  // 旧版把模板误播种为 builtin Strategy；升级后保留数据但转换成可编辑、可删除的用户实例。
  migrateLegacyBuiltinStrategyOwners(db);
};

/**
 * advices 表补 stock_name 列（v0.8 起，幂等）。
 * 旧库无此列时 ALTER ADD；新库 DDL 已含，直接跳过。
 */
const migrateAdviceStockNameColumn = (db: DrizzleDb): void => {
  const cols = db.all<{ name: string }>(sql`PRAGMA table_info(advices)`);
  if (cols.length === 0) return;
  if (!cols.some((c) => c.name === 'stock_name')) {
    db.run(sql`ALTER TABLE advices ADD COLUMN stock_name TEXT`);
  }
};

/** StrategyVersion AI 审计字段，旧库按可空 JSON 列幂等补齐。 */
const migrateStrategyVersionAuditColumns = (db: DrizzleDb): void => {
  const cols = db.all<{ name: string }>(sql`PRAGMA table_info(strategy_versions)`);
  if (cols.length === 0) return;
  const have = new Set(cols.map((column) => column.name));
  if (!have.has('fact_references_json')) {
    db.run(sql`ALTER TABLE strategy_versions ADD COLUMN fact_references_json TEXT`);
  }
  if (!have.has('agent_trace_json')) {
    db.run(sql`ALTER TABLE strategy_versions ADD COLUMN agent_trace_json TEXT`);
  }
};

const migrateStockProvenanceColumns = (db: DrizzleDb): void => {
  const cols = db.all<{ name: string }>(sql`PRAGMA table_info(stocks)`);
  if (cols.length === 0) return;
  const have = new Set(cols.map((column) => column.name));
  if (!have.has('name_source')) {
    db.run(sql`ALTER TABLE stocks ADD COLUMN name_source TEXT NOT NULL DEFAULT 'manual'`);
    db.run(sql`UPDATE stocks SET name_source = 'stub' WHERE name = code`);
  }
  if (!have.has('name_updated_at')) {
    db.run(sql`ALTER TABLE stocks ADD COLUMN name_updated_at INTEGER`);
  }
  if (!have.has('updated_at')) {
    db.run(sql`ALTER TABLE stocks ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`);
  }
};

const migratePriceSnapshotTimeColumns = (db: DrizzleDb): void => {
  const cols = db.all<{ name: string }>(sql`PRAGMA table_info(price_snapshots)`);
  const have = new Set(cols.map((column) => column.name));
  if (have.has('observed_at') && have.has('fetched_at') && have.has('timestamp_source')) {
    return;
  }
  if (!have.has('ts')) return;

  db.transaction((tx) => {
    tx.run(sql`
      CREATE TABLE price_snapshots_mig (
        stock_id TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL,
        timestamp_source TEXT NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume INTEGER NOT NULL,
        source TEXT NOT NULL,
        CONSTRAINT price_snapshots_mig_pk PRIMARY KEY (stock_id, observed_at, source)
      )
    `);
    tx.run(sql`
      INSERT INTO price_snapshots_mig (
        stock_id, observed_at, fetched_at, timestamp_source,
        open, high, low, close, volume, source
      )
      SELECT
        stock_id, ts, ts, 'retrieval',
        open, high, low, close, volume, source
      FROM price_snapshots
    `);
    tx.run(sql`DROP TABLE price_snapshots`);
    tx.run(sql`ALTER TABLE price_snapshots_mig RENAME TO price_snapshots`);
  });
};

const migrateDailyBarAdjustmentColumns = (db: DrizzleDb): void => {
  const cols = db.all<{ name: string }>(sql`PRAGMA table_info(daily_bars)`);
  const have = new Set(cols.map((column) => column.name));
  if (!have.has('adjustment')) {
    db.run(sql`ALTER TABLE daily_bars ADD COLUMN adjustment TEXT NOT NULL DEFAULT 'raw'`);
  }
  if (!have.has('source_adj_factor')) {
    db.run(sql`ALTER TABLE daily_bars ADD COLUMN source_adj_factor REAL`);
  }
};

/**
 * price_snapshots 表补 prev_close 列（幂等）。
 * 旧库无此列时 ALTER ADD；新库 DDL 已含，直接跳过。
 */
const migratePriceSnapshotPrevCloseColumn = (db: DrizzleDb): void => {
  const cols = db.all<{ name: string }>(sql`PRAGMA table_info(price_snapshots)`);
  if (cols.length === 0) return;
  if (!cols.some((c) => c.name === 'prev_close')) {
    db.run(sql`ALTER TABLE price_snapshots ADD COLUMN prev_close REAL`);
  }
};

/**
 * price_snapshots 表补 amount / turnover_rate 列（幂等）。
 * 旧库无此列时 ALTER ADD；新库 DDL 已含，直接跳过。
 */
const migratePriceSnapshotAmountColumns = (db: DrizzleDb): void => {
  const cols = db.all<{ name: string }>(sql`PRAGMA table_info(price_snapshots)`);
  if (cols.length === 0) return;
  if (!cols.some((c) => c.name === 'amount')) {
    db.run(sql`ALTER TABLE price_snapshots ADD COLUMN amount REAL`);
  }
  if (!cols.some((c) => c.name === 'turnover_rate')) {
    db.run(sql`ALTER TABLE price_snapshots ADD COLUMN turnover_rate REAL`);
  }
};

/**
 * v0.7 策略预警列补齐：watch_triggers 缺列时 ALTER TABLE ADD；并回填
 * rule_id / delivery_status / trigger_type / priority / eval_snapshot（§3.7）。
 * 同类多规则时 rule_id 置空（PRD §9.2 接受的「冷却重置一轮」）；
 * 单一行失败跳过，不阻断启动。
 */
const migrateStrategyAlertTriggerColumns = (db: DrizzleDb): void => {
  const cols = db.all<{ name: string }>(sql`PRAGMA table_info(watch_triggers)`);
  const have = new Set(cols.map((c) => c.name));
  if (!have.has('rule_id'))
    db.run(sql`ALTER TABLE watch_triggers ADD COLUMN rule_id TEXT NOT NULL DEFAULT ''`);
  if (!have.has('trigger_type'))
    db.run(
      sql`ALTER TABLE watch_triggers ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'triggered'`,
    );
  if (!have.has('priority'))
    db.run(sql`ALTER TABLE watch_triggers ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'`);
  if (!have.has('delivery_status'))
    db.run(
      sql`ALTER TABLE watch_triggers ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'not-requested'`,
    );
  if (!have.has('notification_id'))
    db.run(sql`ALTER TABLE watch_triggers ADD COLUMN notification_id TEXT`);
  if (!have.has('eval_snapshot'))
    db.run(sql`ALTER TABLE watch_triggers ADD COLUMN eval_snapshot TEXT NOT NULL DEFAULT '{}'`);
  if (!have.has('feedback')) db.run(sql`ALTER TABLE watch_triggers ADD COLUMN feedback TEXT`);
  if (!have.has('feedback_at'))
    db.run(sql`ALTER TABLE watch_triggers ADD COLUMN feedback_at INTEGER`);

  // 回填：delivery_status 由 notified 推；priority / trigger_type 默认 ok；eval_snapshot 由现有字段合成。
  db.run(sql`
    UPDATE watch_triggers
    SET delivery_status = CASE WHEN notified = 1 THEN 'sent' ELSE 'suppressed-cooldown' END
    WHERE delivery_status = 'not-requested' AND rule_id = ''
  `);
  db.run(sql`
    UPDATE watch_triggers
    SET eval_snapshot = json_object(
      'ruleId', rule_id,
      'kind', rule_kind,
      'quoteClose', quote_close,
      'quoteTs', quote_ts
    )
    WHERE eval_snapshot = '{}'
  `);
  // ruleId 回填：对每个 pool，找出该 rule_kind 在 pool.rules 数组中是否唯一
  const triggers = db.all<{ id: string; pool_id: string; rule_kind: string }>(sql`
    SELECT id, pool_id, rule_kind FROM watch_triggers WHERE rule_id = ''
  `);
  for (const t of triggers) {
    const poolRow = db.all<{ rules: string }>(
      sql`SELECT rules FROM stock_pools WHERE id = ${t.pool_id}`,
    )[0];
    if (poolRow === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(poolRow.rules);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    const matches = (parsed as Array<Record<string, unknown>>).filter(
      (r) => r.kind === t.rule_kind && typeof r.id === 'string',
    );
    const [match] = matches;
    if (matches.length === 1 && match !== undefined) {
      db.run(sql`UPDATE watch_triggers SET rule_id = ${match.id as string} WHERE id = ${t.id}`);
    } // 多条规则同类 → 留空接受冷却重置一轮（PRD §9.2）
  }
};

const migrateAlertPlanReferenceColumns = (db: DrizzleDb): void => {
  const triggerColumns = new Set(
    db.all<{ name: string }>(sql`PRAGMA table_info(watch_triggers)`).map((row) => row.name),
  );
  if (!triggerColumns.has('alert_plan_id')) {
    db.run(sql`ALTER TABLE watch_triggers ADD COLUMN alert_plan_id TEXT`);
  }
  const stateColumns = new Set(
    db.all<{ name: string }>(sql`PRAGMA table_info(watch_rule_states)`).map((row) => row.name),
  );
  if (!stateColumns.has('alert_plan_id')) {
    db.run(sql`ALTER TABLE watch_rule_states ADD COLUMN alert_plan_id TEXT`);
  }
  db.run(sql`UPDATE watch_triggers SET alert_plan_id = pool_id WHERE alert_plan_id IS NULL`);
  db.run(sql`UPDATE watch_rule_states SET alert_plan_id = pool_id WHERE alert_plan_id IS NULL`);
};

/**
 * ruo 迁移列补齐（docs/ddd/ruo-feature-migration-detailed-design.md §3.6）：
 * - watch_triggers 补 event_id 列（ALTER ADD，幂等）
 * - 放宽 quote_close / quote_ts 的 NOT NULL（event-date 触发无实时行情）：
 *   SQLite 不支持改列约束 → 表重建（仅当检测到旧约束时执行；索引由外层 CREATE INDEX 重建）
 */
const migrateRuoTriggerColumns = (db: DrizzleDb): void => {
  const cols = db.all<{ name: string; notnull: number }>(sql`PRAGMA table_info(watch_triggers)`);
  if (cols.length === 0) return;
  if (!cols.some((c) => c.name === 'event_id')) {
    db.run(sql`ALTER TABLE watch_triggers ADD COLUMN event_id TEXT`);
  }
  const quoteClose = cols.find((c) => c.name === 'quote_close');
  const quoteTs = cols.find((c) => c.name === 'quote_ts');
  const needRelax =
    (quoteClose !== undefined && quoteClose.notnull === 1) ||
    (quoteTs !== undefined && quoteTs.notnull === 1);
  if (!needRelax) return;
  db.transaction((tx) => {
    tx.run(sql`
      CREATE TABLE watch_triggers_mig (
        id TEXT PRIMARY KEY,
        pool_id TEXT NOT NULL,
        stock_id TEXT NOT NULL,
        rule_kind TEXT NOT NULL,
        direction TEXT NOT NULL,
        reason TEXT NOT NULL,
        evidence TEXT NOT NULL,
        quote_close REAL,
        quote_ts INTEGER,
        notified INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        rule_id TEXT NOT NULL DEFAULT '',
        trigger_type TEXT NOT NULL DEFAULT 'triggered',
        priority TEXT NOT NULL DEFAULT 'normal',
        delivery_status TEXT NOT NULL DEFAULT 'not-requested',
        notification_id TEXT,
        eval_snapshot TEXT NOT NULL DEFAULT '{}',
        feedback TEXT,
        feedback_at INTEGER,
        event_id TEXT
      )
    `);
    tx.run(sql`
      INSERT INTO watch_triggers_mig
      SELECT id, pool_id, stock_id, rule_kind, direction, reason, evidence,
             quote_close, quote_ts, notified, created_at, rule_id, trigger_type,
             priority, delivery_status, notification_id, eval_snapshot, feedback,
             feedback_at, event_id
      FROM watch_triggers
    `);
    tx.run(sql`DROP TABLE watch_triggers`);
    tx.run(sql`ALTER TABLE watch_triggers_mig RENAME TO watch_triggers`);
  });
};

/**
 * v0.7 策略预警列补齐：watch_runs 增 2 列。
 */
const migrateStrategyAlertRunColumns = (db: DrizzleDb): void => {
  const cols = db.all<{ name: string }>(sql`PRAGMA table_info(watch_runs)`);
  const have = new Set(cols.map((c) => c.name));
  if (!have.has('suppressed_by_daily_limit'))
    db.run(
      sql`ALTER TABLE watch_runs ADD COLUMN suppressed_by_daily_limit INTEGER NOT NULL DEFAULT 0`,
    );
  if (!have.has('notify_failed'))
    db.run(sql`ALTER TABLE watch_runs ADD COLUMN notify_failed INTEGER NOT NULL DEFAULT 0`);
};

/**
 * 阶段 C 存量数据迁移：v0.5 → MVP（AccountKind 收窄到 'real'）。
 *
 * v0.5 时期 fixtures（packages/adapters/src/testing/fixtures.ts 的 MOCK_ACCOUNT 等）
 * 写入 kind='mock'，且 web 启动会自动 seedMockData(MOCK_ACCOUNTS) 把 3 条 mock 行灌入
 * 持久库。MVP（47857cc）把 AccountKind 收窄到 z.literal('real')，同时移除 web 启动 seed，
 * 但 ensureSchema 没有数据迁移——升级用户的 accounts 表残留 kind='mock' 行，触发
 * list_accounts output zod 校验失败 → defineTool 返回 internal（Web alert "激活失败"、
 * TUI 静默不刷新）。本迁移在每次 createDrizzleRepos 启动时把残留 kind='mock' 升级为
 * 'real'，幂等。
 */
const migrateLegacyAccountKinds = (db: DrizzleDb): void => {
  // drizzle-orm bun-sqlite 的 run 返回 RunResult（含 changes 数）。
  const result = db.run(sql`UPDATE accounts SET kind = 'real' WHERE kind = 'mock'`);
  // 类型守卫：drizzle 在不同 driver 下 result 形状略不同，保守读 changes
  const changes =
    typeof result === 'object' && result !== null && 'changes' in result
      ? Number((result as { changes: unknown }).changes)
      : 0;
  if (changes > 0) {
    console.warn(`[migrate] accounts: 将 ${changes} 行 kind=mock 升级为 real（v0.5 → MVP 兼容）`);
  }
};

const migrateLegacyBuiltinStrategyOwners = (db: DrizzleDb): void => {
  const result = db.run(sql`UPDATE strategies SET owner = 'user' WHERE owner = 'builtin'`);
  const changes =
    typeof result === 'object' && result !== null && 'changes' in result
      ? Number((result as { changes: unknown }).changes)
      : 0;
  if (changes > 0) {
    console.warn(
      `[migrate] strategies: 将 ${changes} 个旧 builtin Strategy 转为可编辑、可删除的 user 实例`,
    );
  }
};

/** createDrizzleRepos 的返回句柄：repos + db + close()。 */
export interface DrizzleReposHandle {
  readonly repos: RepositoryRegistry;
  readonly db: DrizzleDb;
  readonly close: () => void;
}

/**
 * 打开（必要时创建）SQLite 数据库，建表，并返回全部 Drizzle repository。
 *
 * @param dbPath SQLite 文件路径；传 ':memory:' 用内存库（测试）。
 *
 * 驱动为 Bun 内置 bun:sqlite（drizzle-orm/bun-sqlite），CLI/TUI/Web/MCP 均以
 * bun 启动时可直接加载；vitest 需跑在 Bun 运行时（`bun test` / `bun --bun run vitest`）。
 */
export const createDrizzleRepos = (dbPath: string): DrizzleReposHandle => {
  const sqlite = new Database(dbPath);
  // Web chat、策略调度器和确认面板会并发写同一文件。SQLite 默认遇到写锁立即失败；
  // 给短事务留出等待窗口，WAL 下读请求仍可并发。
  sqlite.exec('PRAGMA busy_timeout = 5000');
  // :memory: 不支持 WAL（pragma 会被静默忽略），文件库开 WAL 提升并发读体验。
  if (dbPath !== ':memory:') {
    sqlite.exec('PRAGMA journal_mode = WAL');
    sqlite.exec('PRAGMA synchronous = NORMAL');
  }
  const db = drizzle(sqlite, { schema });
  try {
    ensureSchema(db);
  } catch (error) {
    // 迁移失败时释放 sqlite 句柄，避免调用方重试时泄漏文件锁。
    sqlite.close();
    throw error;
  }
  const repos: RepositoryRegistry = {
    account: new DrizzleAccountRepository(db),
    stock: new DrizzleStockRepository(db),
    stockUniverse: new DrizzleStockUniverseRepository(db),
    holding: new DrizzleHoldingRepository(db),
    trade: new DrizzleTradeRepository(db),
    advice: new DrizzleAdviceRepository(db),
    report: new DrizzleReportRepository(db),
    quote: new DrizzleQuoteRepository(db),
    dailyBar: new DrizzleDailyBarRepository(db),
    signalObservation: new DrizzleSignalObservationRepository(db),
    strategy: new DrizzleStrategyRepository(db),
    strategyRun: new DrizzleStrategyRunRepository(db),
    strategySchedule: new DrizzleStrategyScheduleRepository(db),
    watchlist: new DrizzleWatchlistRepository(db),
    watchlistMember: new DrizzleWatchlistMemberRepository(db),
    notification: new DrizzleNotificationRepository(db),
    // v0.6 起
    alertPlan: new DrizzleAlertPlanRepository(db),
    watchTrigger: new DrizzleWatchTriggerRepository(db),
    // v0.7 起：边沿状态机
    watchRuleState: new DrizzleWatchRuleStateRepository(db),
    watchRun: new DrizzleWatchRunRepository(db),
    // ruo 迁移起
    researchIndex: new DrizzleResearchIndexRepository(db),
    researchVaultSyncRun: new DrizzleResearchVaultSyncRunRepository(db),
    stockEvent: new DrizzleStockEventRepository(db),
    workflowRun: new DrizzleWorkflowRunRepository(db),
    chat: new DrizzleChatRepository(db),
  };
  return { repos, db, close: () => sqlite.close() };
};
