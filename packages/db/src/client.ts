import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import {
  ledgerCoverage,
  migrateLegacyTradingPlan,
  money,
  PortfolioCashFlowSchema,
  type RepositoryRegistry,
  recomputeCashFromLedger,
} from '@luoome/core';
import { and, eq, sql } from 'drizzle-orm';
import { type BunSQLiteDatabase, drizzle } from 'drizzle-orm/bun-sqlite';
import {
  DrizzleAccountRepository,
  DrizzleAdjustmentFactorRepository,
  DrizzleAdviceRepository,
  DrizzleAdviceTrackingRepository,
  DrizzleAlertPlanRepository,
  DrizzleChatRepository,
  DrizzleDailyBarRepository,
  DrizzleDecisionReviewRepository,
  DrizzleForumDigestRepository,
  DrizzleHoldingRepository,
  DrizzleLedgerRepository,
  DrizzleLimitUpBoardHistoryRepository,
  DrizzleLimitUpLadderSampleRepository,
  DrizzleLimitUpLadderSnapshotRepository,
  DrizzleMarketRoomEventRepository,
  DrizzleMarketSnapshotBatchRepository,
  DrizzleMinuteBarRepository,
  DrizzleNotificationRepository,
  DrizzlePortfolioCashFlowRepository,
  DrizzlePortfolioCorporateActionRepository,
  DrizzlePortfolioPerformanceSnapshotRepository,
  DrizzleQuoteRepository,
  DrizzleReportRepository,
  DrizzleSectorCatalogRepository,
  DrizzleSignalObservationRepository,
  DrizzleStockBriefRepository,
  DrizzleStockRepository,
  DrizzleStockUniverseRepository,
  DrizzleStrategyRepository,
  DrizzleStrategyRunRepository,
  DrizzleStrategyWatchlistSubscriptionRepository,
  DrizzleTradeRepository,
  DrizzleTradingPlanRepository,
  DrizzleWatchlistMemberRepository,
  DrizzleWatchlistRepository,
  DrizzleWatchRuleStateRepository,
  DrizzleWatchTriggerRepository,
  DrizzleWorkflowRunRepository,
} from './repository/drizzle/index.js';
import { decodeJsonBlobToText } from './repository/drizzle/json-blob.js';
import { DrizzlePublicMarketStore } from './repository/drizzle/public-market.js';
import { type Schema, schema } from './schema/index.js';
import { SCHEMA_INDEXES, SCHEMA_TABLES } from './schema-ddl.generated.js';
import { RepositoryWriteScope } from './write-scope.js';

/** Drizzle + bun:sqlite 的数据库句柄类型（绑定本包 schema）。 */
export type DrizzleDb = BunSQLiteDatabase<Schema>;

const dropColumn = (db: DrizzleDb, table: string, column: string): void => {
  const columns = new Set(
    db.all<{ name: string }>(sql.raw(`PRAGMA table_info(${table})`)).map((row) => row.name),
  );
  if (columns.has(column)) db.run(sql.raw(`ALTER TABLE ${table} DROP COLUMN ${column}`));
};

const ensureColumn = (db: DrizzleDb, table: string, column: string, definition: string): void => {
  const columns = new Set(
    db.all<{ name: string }>(sql.raw(`PRAGMA table_info(${table})`)).map((row) => row.name),
  );
  if (!columns.has(column)) {
    const stmt = `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`;
    db.run(sql.raw(stmt));
  }
};

/**
 * 编程式建表（CREATE TABLE IF NOT EXISTS）。
 *
 * v0.1 不引入 drizzle-kit：建表 DDL 与 src/schema 的 Drizzle 定义手工保持一致
 * （列名 / 类型 / 可空 / 唯一约束），可重复执行（幂等）。
 * 后续版本若接入 drizzle-kit migration，本函数应被 migrate 取代。
 */
/**
 * 四表版本链 → 单表迁移（S3.2）。
 *
 * 旧库的 decision_reviews 是“主体表 + revisions/link/receipt 附属表”形态；新形态把
 * 最新修订内容内联到 content_json。旧库检测到缺少 content_json 时：
 * 1) 建新表并尽量把 advice/trading-plan 复盘的最新修订内容搬过来；
 * 2) 把旧表重命名为 decision_reviews_legacy 保留原数据（不 DROP）；
 * 3) 其余旧附属表原样保留，启动时不再创建。
 *
 * 迁移是否发生由表结构决定，可重复执行；新库直接跳过。
 */
const migrateDecisionReviewsToSingleTable = (db: DrizzleDb): void => {
  const table = db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'decision_reviews'`,
  );
  if (table.length === 0) return;
  const columns = db.all<{ name: string }>(sql`PRAGMA table_info(decision_reviews)`);
  if (columns.some((column) => column.name === 'content_json')) return;
  // 旧表名不写死：迭代遗留表时避免把旧 schema 名字固化回代码。
  const legacyRevisionTable = db
    .all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'decision_review_%'`,
    )
    .map((row) => row.name)
    .find((name) => name.endsWith('_revisions'));
  db.transaction(
    (tx) => {
      tx.run(sql`CREATE TABLE decision_reviews_v2 (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, subject_kind TEXT NOT NULL,
        subject_id TEXT NOT NULL, stock_id TEXT, content_json TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )`);
      // 旧内容 JSON 总带 triggerFeedback 键；新内容 schema 已移除该字段，迁移时剥掉。
      const contentSelect =
        legacyRevisionTable === undefined
          ? sql`'{"tradeIds":[],"adviceFeedback":null,"lessonTags":[],"note":null}'`
          : sql`json_remove(
              COALESCE(rev.content_json, '{"tradeIds":[],"adviceFeedback":null,"note":null}'),
              '$.triggerFeedback'
            )`;
      const revisionJoin =
        legacyRevisionTable === undefined
          ? sql``
          : sql` LEFT JOIN ${sql.raw(legacyRevisionTable)} rev ON rev.review_id = r.id AND rev.revision = r.current_revision`;
      tx.run(sql`INSERT INTO decision_reviews_v2
          (id, account_id, subject_kind, subject_id, stock_id, content_json, created_at, updated_at)
        SELECT r.id, r.account_id,
          CASE r.subject_kind WHEN 'trading-plan-version' THEN 'trading-plan' ELSE r.subject_kind END,
          r.subject_id, r.stock_id, ${contentSelect}, r.created_at,
          ${legacyRevisionTable === undefined ? sql`r.created_at` : sql`COALESCE(rev.recorded_at, r.created_at)`}
        FROM decision_reviews r${revisionJoin}
        WHERE r.subject_kind IN ('advice', 'trading-plan-version')`);
      tx.run(sql`ALTER TABLE decision_reviews RENAME TO decision_reviews_legacy`);
      tx.run(sql`ALTER TABLE decision_reviews_v2 RENAME TO decision_reviews`);
      // 旧索引随表重命名保留在 legacy 表上；重建新表索引前先释放同名索引。
      tx.run(sql`DROP INDEX IF EXISTS decision_reviews_account_subject_unique`);
      tx.run(sql`DROP INDEX IF EXISTS decision_reviews_account_time_idx`);
    },
    { behavior: 'immediate' },
  );
};

/** 不来自 Drizzle schema 的两张运行时表（按 schema 导出会污染领域类型）。 */
const ensureRawTables = (db: DrizzleDb): void => {
  db.run(
    sql`CREATE TABLE IF NOT EXISTS public_market_entries (key TEXT PRIMARY KEY, value TEXT NOT NULL, retain_until INTEGER NOT NULL)`,
  );
  db.run(
    sql`CREATE INDEX IF NOT EXISTS public_market_entries_retention_idx ON public_market_entries (retain_until)`,
  );
  db.run(sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL,
      checksum TEXT NOT NULL,
      details_json TEXT NOT NULL
    )
  `);
};

/** 建表 DDL 由 src/schema 生成（bun run schema:ddl），这里是唯一执行入口。 */
const runSchemaTables = (db: DrizzleDb): void => {
  for (const statement of SCHEMA_TABLES) db.run(sql.raw(statement));
};

/** 索引放在补列/迁移之后建，索引列可能是迁移补上的。 */
const runSchemaIndexes = (db: DrizzleDb): void => {
  for (const statement of SCHEMA_INDEXES) db.run(sql.raw(statement));
};

export const ensureSchema = (db: DrizzleDb): void => {
  ensureRawTables(db);
  runSchemaTables(db);

  migrateDecisionReviewsToSingleTable(db);

  ensureColumn(db, 'signal_observations', 'due_at', 'INTEGER');
  ensureColumn(db, 'signal_observations', 'attempt_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'signal_observations', 'last_attempt_at', 'INTEGER');
  ensureColumn(db, 'signal_observations', 'next_attempt_at', 'INTEGER');
  ensureColumn(db, 'signal_observations', 'last_error_kind', 'TEXT');

  migrateStockProvenanceColumns(db);

  ensureColumn(db, 'trades', 'advice_id', 'TEXT');
  ensureColumn(db, 'trades', 'strategy_version_id', 'TEXT');
  // §6：holding_cash_adjustments + portfolio_cash_flows + portfolio_corporate_actions
  // 合并为 account_ledger_entries（entry_kind 区分事实类型）；旧表不再创建、不 DROP。

  migrateAdviceColumns(db);

  ensureColumn(db, 'advice_outcomes', 'trade_ids', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'advice_outcomes', 'holding_hours', 'REAL');
  ensureColumn(db, 'advice_outcomes', 'notes', 'TEXT');

  migratePriceSnapshotTimeColumns(db);
  migratePriceSnapshotPrevCloseColumn(db);
  migratePriceSnapshotAmountColumns(db);
  migratePriceSnapshotValuationColumns(db);

  migrateDailyBarAdjustmentColumns(db);

  ensureColumn(db, 'strategies', 'schedule_cron', 'TEXT');
  ensureColumn(db, 'strategies', 'last_scheduled_at', 'INTEGER');

  migrateStrategyVersionAuditColumns(db);

  ensureColumn(db, 'strategy_runs', 'scope', "TEXT NOT NULL DEFAULT 'operational'");
  ensureColumn(db, 'strategy_runs', 'provider_coverage_json', 'TEXT');
  ensureColumn(db, 'strategy_runs', 'results_json', 'TEXT');
  // v0.6 起：盯盘触发。v0.7 增 rule_id / trigger_type / priority / delivery_status /
  // notification_id / eval_snapshot / feedback / feedback_at，并把 cooldown 索引改用 rule_id
  // （§3.4 / §3.7）。
  migrateStrategyAlertTriggerColumns(db);
  migrateRuoTriggerColumns(db);
  const watchDeliveryColumns = new Set(
    db.all<{ name: string }>(sql`PRAGMA table_info(watch_triggers)`).map((column) => column.name),
  );
  if (!watchDeliveryColumns.has('delivery_attempts')) {
    db.run(sql`ALTER TABLE watch_triggers ADD COLUMN delivery_attempts INTEGER`);
  }
  if (!watchDeliveryColumns.has('last_delivery_attempt_at')) {
    db.run(sql`ALTER TABLE watch_triggers ADD COLUMN last_delivery_attempt_at INTEGER`);
  }
  if (!watchDeliveryColumns.has('delivery_completed_at')) {
    db.run(sql`ALTER TABLE watch_triggers ADD COLUMN delivery_completed_at INTEGER`);
  }

  migrateAlertPlanReferenceColumns(db);

  ensureColumn(db, 'strategy_watchlist_subscriptions', 'investment_binding_json', 'TEXT');

  ensureColumn(db, 'watchlist_member_sources', 'owner_user_id', 'TEXT');
  ensureColumn(db, 'watchlist_member_sources', 'import_batch_id', 'TEXT');

  // ruo 迁移起（docs/ddd/ruo-feature-migration-detailed-design.md §3）：workflow 审计
  ensureColumn(db, 'reports', 'version', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'reports', 'supersedes_report_id', 'TEXT');
  ensureColumn(db, 'reports', 'delivery_attempt_id', 'TEXT');
  ensureColumn(db, 'reports', 'notification_policy', 'TEXT');
  ensureColumn(db, 'reports', 'watchlist_facts_snapshot', 'TEXT');
  ensureColumn(db, 'reports', 'decision_review_fingerprint', 'TEXT');
  // SQLite 在 DROP COLUMN 之后的补列会把列名当默认值写入存量行，这里强制回填整数版本。
  db.run(sql`UPDATE reports SET version = 1 WHERE typeof(version) <> 'integer'`);

  // 阶段 C 存量数据迁移：v0.5 → MVP（AccountKind 收窄到 'real'）—— 见下方函数。
  migrateLegacyAccountKinds(db);
  migrateLegacyLedgerEntries(db);
  migrateLegacyStrategyResults(db);
  migrateAccountCashBalance(db);
  migrateLegacyTradingPlans(db);
  // 旧版把模板误播种为 builtin Strategy；升级后保留数据但转换成可编辑、可删除的用户实例。
  migrateLegacyBuiltinStrategyOwners(db);
  migrateLegacyAdviceTradeLinksToReviews(db);
  migrateLegacyStrategySchedules(db);
  // 存储形态迁移：去掉 rowid 表与复合/TEXT 主键的重复存储。
  migrateSignalObservationsStorage(db);
  migrateDailyBarsToRaw(db);
  dropLegacyDailyBarRevisions(db);
  // 存量明文逐股明细压缩（一次性，按 schema_migrations 标记跳过）。
  migrateCompressStrategyResults(db);
  // 信号主键改 64 位整数 + 引用改写（一次性）。
  migrateStrategySignalIds(db);
  // 逐信号 JSON 的压缩是负收益，回退为明文（一次性）。
  migrateStrategySignalJsonToPlain(db);

  // 严格回测已下线，历史库残留的空表直接清掉。
  db.run(sql`DROP TABLE IF EXISTS strategy_backtest_runs`);

  // 可发布性状态机已下线：先删引用该列的旧索引，再删列（SQLite 不允许带索引删列）。
  db.run(sql`DROP INDEX IF EXISTS strategy_runs_published_current_idx`);
  dropColumn(db, 'strategy_runs', 'publication_json');
  dropColumn(db, 'strategy_runs', 'publication_status');

  // 旧版索引列名/唯一性已变：先删除再按 schema 重建。
  db.run(sql`DROP INDEX IF EXISTS watch_triggers_pool_stock_rule_ts_idx`);
  db.run(sql`DROP INDEX IF EXISTS reports_period_unique`);
  db.run(sql`DROP INDEX IF EXISTS strategy_signals_identity_unique`);
  db.run(sql`DROP INDEX IF EXISTS strategy_signals_run_identity_unique`);
  runSchemaIndexes(db);
};

/**
 * advices 表补 stock_name 列（v0.8 起，幂等）。
 * 旧库无此列时 ALTER ADD；新库 DDL 已含，直接跳过。
 */
const migrateAdviceColumns = (db: DrizzleDb): void => {
  const cols = db.all<{ name: string }>(sql`PRAGMA table_info(advices)`);
  if (cols.length === 0) return;
  const have = new Set(cols.map((column) => column.name));
  if (!have.has('stock_name')) db.run(sql`ALTER TABLE advices ADD COLUMN stock_name TEXT`);
  if (!have.has('entry_price')) db.run(sql`ALTER TABLE advices ADD COLUMN entry_price REAL`);
  if (!have.has('entry_price_low'))
    db.run(sql`ALTER TABLE advices ADD COLUMN entry_price_low REAL`);
  if (!have.has('entry_price_high'))
    db.run(sql`ALTER TABLE advices ADD COLUMN entry_price_high REAL`);
  if (!have.has('target_position_pct'))
    db.run(sql`ALTER TABLE advices ADD COLUMN target_position_pct REAL`);
  if (!have.has('target_price')) db.run(sql`ALTER TABLE advices ADD COLUMN target_price REAL`);
  if (!have.has('stop_loss')) db.run(sql`ALTER TABLE advices ADD COLUMN stop_loss REAL`);
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

/** price_snapshots 补齐单股详情所需的股本、市值与估值字段（幂等）。 */
const migratePriceSnapshotValuationColumns = (db: DrizzleDb): void => {
  const cols = db.all<{ name: string }>(sql`PRAGMA table_info(price_snapshots)`);
  if (cols.length === 0) return;
  const have = new Set(cols.map((column) => column.name));
  const definitions = [
    ['total_shares', 'REAL'],
    ['float_shares', 'REAL'],
    ['total_market_cap', 'REAL'],
    ['float_market_cap', 'REAL'],
    ['pe_dynamic', 'REAL'],
    ['pe_ttm', 'REAL'],
    ['pe_static', 'REAL'],
    ['ps_ttm', 'REAL'],
    ['pb', 'REAL'],
  ] as const;
  for (const [name, type] of definitions) {
    if (!have.has(name)) db.run(sql.raw(`ALTER TABLE price_snapshots ADD COLUMN ${name} ${type}`));
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
 * - 放宽 quote_close / quote_ts 的 NOT NULL（存量 event-date 触发无实时行情）：
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
  const have = new Set(cols.map((column) => column.name));
  const alertPlanId = have.has('alert_plan_id') ? sql`alert_plan_id` : sql`pool_id`;
  const deliveryAttempts = have.has('delivery_attempts') ? sql`delivery_attempts` : sql`NULL`;
  const lastDeliveryAttemptAt = have.has('last_delivery_attempt_at')
    ? sql`last_delivery_attempt_at`
    : sql`NULL`;
  const deliveryCompletedAt = have.has('delivery_completed_at')
    ? sql`delivery_completed_at`
    : sql`NULL`;
  db.transaction((tx) => {
    tx.run(sql`
      CREATE TABLE watch_triggers_mig (
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
        event_id TEXT,
        delivery_attempts INTEGER,
        last_delivery_attempt_at INTEGER,
        delivery_completed_at INTEGER
      )
    `);
    tx.run(sql`
      INSERT INTO watch_triggers_mig (
        id, alert_plan_id, pool_id, stock_id, rule_kind, direction, reason, evidence,
        quote_close, quote_ts, notified, created_at, rule_id, trigger_type,
        priority, delivery_status, notification_id, eval_snapshot, feedback,
        feedback_at, event_id, delivery_attempts, last_delivery_attempt_at,
        delivery_completed_at
      )
      SELECT id, ${alertPlanId}, pool_id, stock_id, rule_kind, direction, reason, evidence,
             quote_close, quote_ts, notified, created_at, rule_id, trigger_type,
             priority, delivery_status, notification_id, eval_snapshot, feedback,
             feedback_at, event_id, ${deliveryAttempts}, ${lastDeliveryAttemptAt},
             ${deliveryCompletedAt}
      FROM watch_triggers
    `);
    tx.run(sql`DROP TABLE watch_triggers`);
    tx.run(sql`ALTER TABLE watch_triggers_mig RENAME TO watch_triggers`);
  });
};

/**
 * 阶段 C 存量数据迁移：v0.5 → MVP（AccountKind 收窄到 'real'）。
 *
 * v0.5 时期 fixtures（packages/adapters/src/testing/fixtures.ts 的 MOCK_ACCOUNT 等）
 * 写入 kind='mock'，且 web 启动会自动 seedMockData(MOCK_ACCOUNTS) 把 3 条 mock 行灌入
 * 持久库。MVP（47857cc）把 AccountKind 收窄到 z.literal('real')，同时移除 web 启动 seed，
 * 但 ensureSchema 没有数据迁移——升级用户的 accounts 表残留 kind='mock' 行，触发
 * list_accounts output zod 校验失败 → defineTool 返回 internal（Web alert "激活失败"、
 * 其它入口静默失败）。本迁移在每次 createDrizzleRepos 启动时把残留 kind='mock' 升级为
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

/**
 * §6 存量迁移：把三张旧账本表的数据搬入 account_ledger_entries。
 * 幂等（INSERT OR IGNORE + 旧表存在性检查）；旧表保留不 DROP。
 */
const migrateLegacyLedgerEntries = (db: DrizzleDb): void => {
  const tableExists = (name: string): boolean =>
    db.get(sql`SELECT name FROM sqlite_master WHERE type='table' AND name=${name}`) !== undefined;
  db.transaction(
    (tx) => {
      if (tableExists('holding_cash_adjustments')) {
        tx.run(sql`
          INSERT OR IGNORE INTO account_ledger_entries
            (id, account_id, entry_kind, occurred_at, amount, holding_id, stock_id, quantity_delta, created_at)
          SELECT id, account_id, 'holding-adjustment', occurred_at, amount, holding_id, stock_id, quantity_delta, occurred_at
          FROM holding_cash_adjustments
        `);
      }
      if (tableExists('portfolio_cash_flows')) {
        tx.run(sql`
          INSERT OR IGNORE INTO account_ledger_entries
            (id, account_id, entry_kind, occurred_at, amount, currency, stock_id, flow_kind, source, note, created_at)
          SELECT id, account_id, 'cash-flow', occurred_at, amount, currency, stock_id, kind, source, note, created_at
          FROM portfolio_cash_flows
        `);
      }
      if (tableExists('portfolio_corporate_actions')) {
        tx.run(sql`
          INSERT OR IGNORE INTO account_ledger_entries
            (id, account_id, entry_kind, occurred_at, stock_id, action_kind, ratio, cash_per_share, source, note, created_at)
          SELECT id, account_id, 'corporate-action', occurred_at, stock_id, kind, ratio, cash_per_share, source, note, created_at
          FROM portfolio_corporate_actions
        `);
      }
    },
    { behavior: 'immediate' },
  );
};

/** 迁移检查、建表、历史调整和余额回填必须一起提交，避免中断后留下半迁移。 */
const migrateAccountCashBalance = (db: DrizzleDb): void => {
  db.transaction(
    (tx) => {
      const cols = tx.all<{ name: string }>(sql`PRAGMA table_info(accounts)`);
      const hadCash = cols.some((column) => column.name === 'cash_balance');
      const hadAdjustments =
        tx.get(
          sql`SELECT name FROM sqlite_master WHERE type='table' AND name='account_ledger_entries'`,
        ) !== undefined &&
        tx.get(
          sql`SELECT 1 AS present FROM account_ledger_entries WHERE entry_kind='holding-adjustment' LIMIT 1`,
        ) !== undefined;
      if (!hadCash)
        tx.run(sql`ALTER TABLE accounts ADD COLUMN cash_balance REAL NOT NULL DEFAULT 0`);
      tx.run(sql`CREATE TABLE IF NOT EXISTS account_ledger_entries (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, entry_kind TEXT NOT NULL,
      occurred_at INTEGER NOT NULL, amount REAL, currency TEXT, holding_id TEXT,
      stock_id TEXT, quantity_delta INTEGER, flow_kind TEXT, action_kind TEXT,
      ratio REAL, cash_per_share REAL, source TEXT, note TEXT, created_at INTEGER
    )`);
      for (const account of tx.select().from(schema.accounts).all()) {
        const needsCash = !hadCash || account.cashBalance === null;
        if (hadAdjustments && !needsCash) continue;
        const holdings = tx
          .select()
          .from(schema.holdings)
          .where(eq(schema.holdings.accountId, account.id))
          .all();
        const trades = tx
          .select()
          .from(schema.trades)
          .where(eq(schema.trades.accountId, account.id))
          .all();
        const adjustmentRows = (): ReadonlyArray<{
          readonly id: string;
          readonly accountId: string;
          readonly holdingId: string | null;
          readonly stockId: string | null;
          readonly amount: number | null;
          readonly quantityDelta: number | null;
          readonly occurredAt: Date;
        }> =>
          tx
            .select()
            .from(schema.accountLedgerEntries)
            .where(
              and(
                eq(schema.accountLedgerEntries.accountId, account.id),
                eq(schema.accountLedgerEntries.entryKind, 'holding-adjustment'),
              ),
            )
            .all();
        let holdingAdjustments = adjustmentRows().map((row) => ({
          id: row.id,
          accountId: row.accountId,
          holdingId: row.holdingId ?? '',
          stockId: row.stockId ?? '',
          amount: money(row.amount ?? 0),
          quantityDelta: row.quantityDelta ?? 0,
          occurredAt: row.occurredAt,
        }));
        // 只能恢复当前未被交易覆盖的持仓成本；无法恢复的历史缺口仍由对账显式报告。
        const gaps = ledgerCoverage({ holdings, trades, holdingAdjustments });
        for (const gap of gaps) {
          if (gap.uncoveredQuantity === 0) continue;
          const holding = holdings.find(
            (item) => item.stockId === gap.stockId && item.closedAt === null,
          );
          if (holding === undefined) continue;
          tx.insert(schema.accountLedgerEntries)
            .values({
              id: `legacy-holding:${holding.id}`,
              accountId: account.id,
              entryKind: 'holding-adjustment',
              holdingId: holding.id,
              stockId: holding.stockId,
              amount: money(-gap.uncoveredQuantity * holding.avgCost),
              quantityDelta: gap.uncoveredQuantity,
              occurredAt: holding.openedAt,
              createdAt: holding.openedAt,
            })
            .run();
        }
        if (needsCash) {
          holdingAdjustments = adjustmentRows().map((row) => ({
            id: row.id,
            accountId: row.accountId,
            holdingId: row.holdingId ?? '',
            stockId: row.stockId ?? '',
            amount: money(row.amount ?? 0),
            quantityDelta: row.quantityDelta ?? 0,
            occurredAt: row.occurredAt,
          }));
          const cashFlows = tx
            .select()
            .from(schema.accountLedgerEntries)
            .where(
              and(
                eq(schema.accountLedgerEntries.accountId, account.id),
                eq(schema.accountLedgerEntries.entryKind, 'cash-flow'),
              ),
            )
            .all()
            .flatMap((row) => {
              const parsed = PortfolioCashFlowSchema.safeParse({
                id: row.id,
                accountId: row.accountId,
                occurredAt: row.occurredAt,
                kind: row.flowKind,
                amount: row.amount,
                currency: row.currency,
                ...(row.stockId === null ? {} : { stockId: row.stockId }),
                source: row.source,
                ...(row.note === null ? {} : { note: row.note }),
                createdAt: row.createdAt ?? row.occurredAt,
              });
              return parsed.success ? [parsed.data] : [];
            });
          const cashBalance = recomputeCashFromLedger({
            account,
            holdings,
            trades,
            cashFlows,
            holdingAdjustments,
          });
          // 历史缺口可能使重算为负；保留事实，由账户事实读边界阻止其用于计划预算。
          tx.update(schema.accounts)
            .set({ cashBalance })
            .where(eq(schema.accounts.id, account.id))
            .run();
        }
      }
    },
    { behavior: 'immediate' },
  );
};

/**
 * §6 存量迁移：把 strategy_results 逐股明细搬入 strategy_runs.results_json
 * （仅在 results_json 为空时写入，幂等；旧表保留不 DROP）。
 */
const migrateLegacyStrategyResults = (db: DrizzleDb): void => {
  const exists =
    db.get(sql`SELECT name FROM sqlite_master WHERE type='table' AND name='strategy_results'`) !==
    undefined;
  if (!exists) return;
  const unmigrated = db.all<{ id: string }>(
    sql`SELECT id FROM strategy_runs WHERE results_json IS NULL OR results_json = 'null'`,
  );
  if (unmigrated.length === 0) return;
  const unmigratedIds = new Set(unmigrated.map((row) => row.id));
  const runIds = db
    .all<{ run_id: string }>(sql`SELECT DISTINCT run_id FROM strategy_results`)
    .map((row) => row.run_id)
    .filter((id) => unmigratedIds.has(id));
  for (const runId of runIds) {
    const rows = db.all<{
      run_id: string;
      stock_id: string;
      selected: number;
      score: number | null;
      rank: number | null;
      rule_evaluations_json: string;
      evidence_json: string;
      data_as_of: number;
    }>(
      sql`SELECT run_id, stock_id, selected, score, rank, rule_evaluations_json, evidence_json, data_as_of
          FROM strategy_results WHERE run_id = ${runId}
          ORDER BY CASE WHEN rank IS NULL THEN 1 ELSE 0 END, rank, stock_id`,
    );
    if (rows.length === 0) continue;
    const results = rows.map((row) => {
      const stored = JSON.parse(row.rule_evaluations_json) as unknown;
      const evaluation: { ruleEvaluations: unknown[]; scoringBreakdown?: unknown[] } =
        Array.isArray(stored)
          ? { ruleEvaluations: stored }
          : (stored as { ruleEvaluations: unknown[]; scoringBreakdown?: unknown[] });
      return {
        runId: row.run_id,
        stockId: row.stock_id,
        selected: row.selected !== 0,
        ...(row.score === null ? {} : { score: row.score }),
        ...(row.rank === null ? {} : { rank: row.rank }),
        ruleEvaluations: evaluation.ruleEvaluations,
        ...(evaluation.scoringBreakdown === undefined
          ? {}
          : { scoringBreakdown: evaluation.scoringBreakdown }),
        evidence: JSON.parse(row.evidence_json) as unknown[],
        dataAsOf: new Date(row.data_as_of).toISOString(),
      };
    });
    db.run(
      sql`UPDATE strategy_runs SET results_json = ${JSON.stringify(results)}
          WHERE id = ${runId} AND (results_json IS NULL OR results_json = 'null')`,
    );
  }
};

const migrateLegacyTradingPlans = (db: DrizzleDb): void => {
  db.transaction(
    (tx) => {
      for (const row of tx.select().from(schema.tradingPlans).all()) {
        const migrated = migrateLegacyTradingPlan(row.plan);
        if (migrated === null) continue;
        tx.update(schema.tradingPlans)
          .set({ plan: migrated, status: migrated.status })
          .where(eq(schema.tradingPlans.versionId, row.versionId))
          .run();
      }
    },
    { behavior: 'immediate' },
  );
};

const migrateLegacyAdviceTradeLinksToReviews = (db: DrizzleDb): void => {
  const migrationId = 'mvp3-legacy-explicit-trade-links-v1';
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  db.transaction(
    (tx) => {
      const priorMigration = tx
        .select()
        .from(schema.schemaMigrations)
        .where(eq(schema.schemaMigrations.id, migrationId))
        .get();
      const groups = new Map<
        string,
        {
          accountId: string;
          adviceId: string;
          stockId: string | null;
          tradeRows: (typeof schema.trades.$inferSelect)[];
        }
      >();
      let missing = 0;
      let invalid = 0;
      for (const trade of tx.select().from(schema.trades).all()) {
        if (trade.adviceId === null) continue;
        const advice = tx
          .select()
          .from(schema.advices)
          .where(eq(schema.advices.id, trade.adviceId))
          .get();
        if (advice === undefined) {
          missing++;
          continue;
        }
        let stockId: string | null = null;
        if (advice.subjectKind === 'stock') {
          stockId = advice.subjectId;
          if (
            advice.basedOn.strategy?.accountId !== undefined &&
            advice.basedOn.strategy.accountId !== trade.accountId
          ) {
            invalid++;
            continue;
          }
        } else if (advice.subjectKind === 'position') {
          const holding = tx
            .select()
            .from(schema.holdings)
            .where(eq(schema.holdings.id, advice.subjectId))
            .get();
          if (holding === undefined || holding.accountId !== trade.accountId) {
            invalid++;
            continue;
          }
          stockId = holding.stockId;
        } else if (advice.subjectKind === 'portfolio') {
          if (advice.subjectId !== trade.accountId) {
            invalid++;
            continue;
          }
        } else {
          invalid++;
          continue;
        }
        if (
          (stockId !== null && trade.stockId !== stockId) ||
          trade.executedAt < advice.createdAt
        ) {
          invalid++;
          continue;
        }
        const key = JSON.stringify([trade.accountId, trade.adviceId]);
        const group = groups.get(key);
        if (group !== undefined) group.tradeRows.push(trade);
        else
          groups.set(key, {
            accountId: trade.accountId,
            adviceId: trade.adviceId,
            stockId,
            tradeRows: [trade],
          });
      }
      let created = 0;
      let skippedExisting = 0;
      for (const group of groups.values()) {
        const old = tx
          .select()
          .from(schema.decisionReviews)
          .where(
            sql`${schema.decisionReviews.accountId} = ${group.accountId} AND ${schema.decisionReviews.subjectKind} = 'advice' AND ${schema.decisionReviews.subjectId} = ${group.adviceId}`,
          )
          .get();
        if (old !== undefined) {
          skippedExisting++;
          continue;
        }
        if (group.tradeRows.length > 100) {
          invalid += group.tradeRows.length;
          continue;
        }
        const subject = { kind: 'advice' as const, id: group.adviceId };
        const id = hash([group.accountId, subject.kind, subject.id]);
        const capturedAt = new Date();
        tx.insert(schema.decisionReviews)
          .values({
            id,
            accountId: group.accountId,
            subjectKind: 'advice',
            subjectId: group.adviceId,
            stockId: group.stockId,
            content: {
              tradeIds: group.tradeRows.map((row) => row.id).sort(),
              adviceFeedback: null,
              lessonTags: [],
              note: null,
            },
            createdAt: capturedAt,
            updatedAt: capturedAt,
          })
          .run();
        created++;
      }
      if (priorMigration === undefined || created > 0) {
        tx.insert(schema.schemaMigrations)
          .values({
            id: migrationId,
            appliedAt: new Date(),
            checksum: hash(migrationId),
            details: { created, missing, invalid, skippedExisting },
          })
          .onConflictDoUpdate({
            target: schema.schemaMigrations.id,
            set: { appliedAt: new Date(), details: { created, missing, invalid, skippedExisting } },
          })
          .run();
      }
    },
    { behavior: 'immediate' },
  );
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

/**
 * S2.3 存量迁移：将旧 strategy_schedules 表的 cron 与 last_scheduled_at 回填至 strategies 表。
 * （仅在 schedule_cron 为 NULL 且 strategy_schedules 存在启用配置时写入，幂等；旧表保留不 DROP）。
 */
const migrateLegacyStrategySchedules = (db: DrizzleDb): void => {
  const exists =
    db.get(sql`SELECT name FROM sqlite_master WHERE type='table' AND name='strategy_schedules'`) !==
    undefined;
  if (!exists) return;
  const result = db.run(sql`
    UPDATE strategies
    SET schedule_cron = (
      SELECT cron FROM strategy_schedules
      WHERE strategy_schedules.strategy_id = strategies.id AND strategy_schedules.enabled = 1
    ),
    last_scheduled_at = COALESCE(
      (
        SELECT sr.started_at FROM strategy_schedules ss
        JOIN strategy_runs sr ON sr.id = ss.last_run_id
        WHERE ss.strategy_id = strategies.id AND ss.enabled = 1
      ),
      strategies.last_scheduled_at
    )
    WHERE schedule_cron IS NULL AND EXISTS (
      SELECT 1 FROM strategy_schedules
      WHERE strategy_schedules.strategy_id = strategies.id AND strategy_schedules.enabled = 1
    )
  `);
  const changes =
    typeof result === 'object' && result !== null && 'changes' in result
      ? Number((result as { changes: unknown }).changes)
      : 0;
  if (changes > 0) {
    console.warn(
      `[migrate] strategies: 将 ${changes} 个旧 StrategySchedule 调度配置回填至 strategies 表`,
    );
  }
};

const tableDdl = (db: DrizzleDb, table: string): string | undefined =>
  db.all<{ sql: string | null }>(
    sql`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${table}`,
  )[0]?.sql ?? undefined;

const tableColumnNames = (db: DrizzleDb, table: string): readonly string[] =>
  db.all<{ name: string }>(sql.raw(`PRAGMA table_info(${table})`)).map((row) => row.name);

/**
 * signal_observations 存储形态迁移：改为自然键 (source_kind, source_id, horizon) 的
 * WITHOUT ROWID 聚簇表。
 *
 * 旧形态把 `id = signal-observation:<kind>:<sourceId>:<horizon>` 存成 TEXT 主键，4.7M 行
 * 下这串 100+ 字符的 id 会同时进入聚簇主键和每个二级索引；id 完全可由自然键派生，
 * 因此重建时删列、删重复的 source_idx，读取侧用 parseSignalObservationId 还原。
 * 顺带清掉已无代码引用的 vintage 列与索引。幂等：已是自然键聚簇表时直接返回。
 */
const migrateSignalObservationsStorage = (db: DrizzleDb): void => {
  const ddl = tableDdl(db, 'signal_observations');
  if (ddl === undefined) return;
  const columns = tableColumnNames(db, 'signal_observations');
  if (!columns.includes('id') && ddl.includes('WITHOUT ROWID')) return;
  db.transaction((tx) => {
    tx.run(sql`
      CREATE TABLE signal_observations_rebuild (
        source_kind TEXT NOT NULL, source_id TEXT NOT NULL, stock_id TEXT NOT NULL,
        baseline_price REAL, baseline_at INTEGER, horizon TEXT NOT NULL,
        close_price REAL, return_pct REAL, max_favorable_excursion_pct REAL,
        max_adverse_excursion_pct REAL, benchmark_return_pct REAL,
        benchmark_status TEXT NOT NULL, status TEXT NOT NULL, provenance TEXT NOT NULL,
        unavailable_reason TEXT, observed_at INTEGER, due_at INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0, last_attempt_at INTEGER,
        next_attempt_at INTEGER, last_error_kind TEXT,
        PRIMARY KEY (source_kind, source_id, horizon)
      ) WITHOUT ROWID
    `);
    // 自然键在旧库里唯一（id 由同一组字段派生）；OR REPLACE 只用于兜底异常数据。
    tx.run(sql`
      INSERT OR REPLACE INTO signal_observations_rebuild (
        source_kind, source_id, horizon, stock_id, baseline_price, baseline_at,
        close_price, return_pct, max_favorable_excursion_pct, max_adverse_excursion_pct,
        benchmark_return_pct, benchmark_status, status, provenance, unavailable_reason,
        observed_at, due_at, attempt_count, last_attempt_at, next_attempt_at, last_error_kind
      )
      SELECT
        source_kind, source_id, horizon, stock_id, baseline_price, baseline_at,
        close_price, return_pct, max_favorable_excursion_pct, max_adverse_excursion_pct,
        benchmark_return_pct, benchmark_status, status, provenance, unavailable_reason,
        observed_at, due_at, attempt_count, last_attempt_at, next_attempt_at, last_error_kind
      FROM signal_observations
    `);
    tx.run(sql`DROP TABLE signal_observations`);
    tx.run(sql`ALTER TABLE signal_observations_rebuild RENAME TO signal_observations`);
    tx.run(
      sql`CREATE INDEX signal_observations_status_baseline_idx ON signal_observations (status, baseline_at)`,
    );
    tx.run(
      sql`CREATE INDEX signal_observations_due_idx ON signal_observations (status, due_at, next_attempt_at)`,
    );
  });
  console.warn('[migrate] signal_observations: 重建为自然键 WITHOUT ROWID 聚簇表');
};

/**
 * 日线口径迁移：daily_bars 从「前复权」改为「原始价 + 因子投影」。
 *
 * 只有带 `source_adj_factor` 的存量行能被精确还原（raw = qfq / factor）；其余行没有
 * 写入时的累计因子，强行标记 raw 会把 qfq 当原始价、在因子到达后二次复权。这些行保留
 * `adjustment='qfq'`，按原值读出，直到市场 dump 的原始价覆盖同一 (stockId, date)。
 * 因子表为空时不动；完成后写标记，重复启动不再除。
 */
const migrateDailyBarsToRaw = (db: DrizzleDb): void => {
  const migrationId = 'daily-bars-raw-v1';
  const applied = db.all<{ id: string }>(
    sql`SELECT id FROM schema_migrations WHERE id = ${migrationId}`,
  )[0];
  if (applied !== undefined) return;
  const factors =
    db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM adjustment_factors`)[0]?.n ?? 0;
  if (factors === 0) return;
  let converted = 0;
  db.transaction((tx) => {
    converted =
      tx.all<{ n: number }>(
        sql`SELECT COUNT(*) AS n FROM daily_bars
            WHERE source_adj_factor IS NOT NULL AND source_adj_factor > 0`,
      )[0]?.n ?? 0;
    tx.run(sql`
      UPDATE daily_bars SET
        open = open / source_adj_factor,
        high = high / source_adj_factor,
        low = low / source_adj_factor,
        close = close / source_adj_factor,
        adj_factor = 1,
        source_adj_factor = NULL,
        adjustment = 'raw'
      WHERE source_adj_factor IS NOT NULL AND source_adj_factor > 0
    `);
    tx.run(sql`
      INSERT INTO schema_migrations (id, applied_at, checksum, details_json)
      VALUES (${migrationId}, ${Date.now()}, ${migrationId}, ${JSON.stringify({ converted })})
      ON CONFLICT(id) DO NOTHING
    `);
  });
  const provisional =
    db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM daily_bars WHERE adjustment <> 'raw'`)[0]
      ?.n ?? 0;
  console.warn(
    `[migrate] daily_bars: ${converted} 行按 source_adj_factor 还原为原始价；` +
      `${provisional} 行无因子来源，保留 qfq 原值读取`,
  );
};

/** 日线固定、盘后同步，不再保留修订流水；旧库直接删表。 */
const dropLegacyDailyBarRevisions = (db: DrizzleDb): void => {
  const exists = db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'daily_bar_revisions'`,
  )[0];
  if (exists === undefined) return;
  db.run(sql`DROP TABLE daily_bar_revisions`);
  console.warn('[migrate] daily_bar_revisions: 已废弃并删除');
};

/**
 * 逐股明细压缩迁移：V4 存量行的 results_json 是明文 JSON（单行可达 22MB）。
 *
 * 逐行改写而不是一次性读出，避免 8GB 级内存峰值；每行独立提交，中断后重跑会跳过
 * 已压缩行（前缀判定），迁移完成才写 schema_migrations 标记。
 */
const STRATEGY_SIGNAL_ID_EPOCH_MS = Date.UTC(2025, 0, 1);
const STRATEGY_SIGNAL_ID_SEQUENCE_BITS = 22;
const STRATEGY_SIGNAL_ID_SEQUENCE = 2 ** STRATEGY_SIGNAL_ID_SEQUENCE_BITS;

/**
 * strategy_signals 主键从 100 字符拼接串改为 64 位整数（snowflake 布局，十进制字符串）。
 *
 * 旧 id 是 `${runId}:${ruleId}:${stockId}:${iso}`，会被复制进 signal_observations.source_id
 * （470 万行）与两张二级索引；改成 19 字符整数后这三处一起缩小。同一迁移顺带把
 * evidence_json / evaluation_snapshot_json 换成 zlib+base64，并改写引用旧 id 的
 * signal_observations.source_id、advices.based_on、trading_plans.plan_json。
 *
 * 全流程单事务：失败整体回滚；完成后写 schema_migrations 标记。
 */
const migrateStrategySignalIds = (db: DrizzleDb): void => {
  const migrationId = 'strategy-signal-int64-id-v1';
  const applied = db.all<{ id: string }>(
    sql`SELECT id FROM schema_migrations WHERE id = ${migrationId}`,
  )[0];
  if (applied !== undefined) return;
  const total = db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM strategy_signals`)[0]?.n ?? 0;
  if (total === 0) {
    db.run(sql`
      INSERT INTO schema_migrations (id, applied_at, checksum, details_json)
      VALUES (${migrationId}, ${Date.now()}, ${migrationId}, '{"rewritten":0}')
      ON CONFLICT(id) DO NOTHING
    `);
    return;
  }

  db.transaction(
    (tx) => {
      // 1) 旧 id → 新 id：时间戳取信号自身的 ts，序号取同一毫秒内的稳定行号。
      tx.run(sql`DROP TABLE IF EXISTS signal_id_map`);
      tx.run(sql`
        CREATE TEMP TABLE signal_id_map AS
        SELECT id AS old_id,
               CAST(
                 (ts - ${STRATEGY_SIGNAL_ID_EPOCH_MS}) * ${STRATEGY_SIGNAL_ID_SEQUENCE} +
                 (ROW_NUMBER() OVER (PARTITION BY ts ORDER BY rowid) - 1)
                 AS TEXT
               ) AS new_id
        FROM strategy_signals
      `);
      tx.run(sql`CREATE UNIQUE INDEX signal_id_map_old_idx ON signal_id_map (old_id)`);

      // 2) 重建 signals：换 id，并把两个 JSON 列压成 zlib+base64。
      tx.run(sql`
        CREATE TABLE strategy_signals_rebuild (
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
      type RebuildRow = {
        rid: number;
        new_id: string;
        strategy_id: string;
        strategy_version_id: string;
        run_id: string;
        rule_id: string;
        stock_id: string;
        ts: number;
        score: number;
        direction: string;
        evidence_json: string;
        evaluation_snapshot_json: string;
      };
      const batchSize = 500;
      let cursor = 0;
      let rewritten = 0;
      for (;;) {
        const rows = tx.all<RebuildRow>(sql`
          SELECT s.rowid AS rid, m.new_id, s.strategy_id, s.strategy_version_id, s.run_id,
                 s.rule_id, s.stock_id, s.ts, s.score, s.direction,
                 s.evidence_json, s.evaluation_snapshot_json
          FROM strategy_signals s
          JOIN signal_id_map m ON m.old_id = s.id
          WHERE s.rowid > ${cursor}
          ORDER BY s.rowid
          LIMIT ${batchSize}
        `);
        if (rows.length === 0) break;
        cursor = rows[rows.length - 1]?.rid ?? cursor;
        const values = rows.map(
          (row) => sql`(
            ${row.new_id}, ${row.strategy_id}, ${row.strategy_version_id}, ${row.run_id},
            ${row.rule_id}, ${row.stock_id}, ${row.ts}, ${row.score}, ${row.direction},
            ${decodeJsonBlobToText(row.evidence_json)},
            ${decodeJsonBlobToText(row.evaluation_snapshot_json)}
          )`,
        );
        tx.run(sql`
          INSERT INTO strategy_signals_rebuild (
            id, strategy_id, strategy_version_id, run_id, rule_id, stock_id,
            ts, score, direction, evidence_json, evaluation_snapshot_json
          ) VALUES ${sql.join(values, sql`, `)}
        `);
        rewritten += rows.length;
      }
      tx.run(sql`DROP TABLE strategy_signals`);
      tx.run(sql`ALTER TABLE strategy_signals_rebuild RENAME TO strategy_signals`);
      tx.run(sql`
        CREATE UNIQUE INDEX strategy_signals_run_event_unique
        ON strategy_signals (run_id, rule_id, stock_id, ts)
      `);
      tx.run(sql`
        CREATE INDEX strategy_signals_strategy_ts_idx ON strategy_signals (strategy_id, ts)
      `);
      tx.run(sql`CREATE INDEX strategy_signals_stock_ts_idx ON strategy_signals (stock_id, ts)`);
      tx.run(sql`CREATE INDEX strategy_signals_run_ts_idx ON strategy_signals (run_id, ts)`);

      // 3) 观察表：source_id 跟着换（其余来源保持原值）。
      tx.run(sql`
        CREATE TABLE signal_observations_rebuild (
          source_kind TEXT NOT NULL, source_id TEXT NOT NULL, stock_id TEXT NOT NULL,
          baseline_price REAL, baseline_at INTEGER, horizon TEXT NOT NULL,
          close_price REAL, return_pct REAL, max_favorable_excursion_pct REAL,
          max_adverse_excursion_pct REAL, benchmark_return_pct REAL,
          benchmark_status TEXT NOT NULL, status TEXT NOT NULL, provenance TEXT NOT NULL,
          unavailable_reason TEXT, observed_at INTEGER, due_at INTEGER,
          attempt_count INTEGER NOT NULL DEFAULT 0, last_attempt_at INTEGER,
          next_attempt_at INTEGER, last_error_kind TEXT,
          PRIMARY KEY (source_kind, source_id, horizon)
        ) WITHOUT ROWID
      `);
      tx.run(sql`
        INSERT INTO signal_observations_rebuild (
          source_kind, source_id, stock_id, baseline_price, baseline_at, horizon,
          close_price, return_pct, max_favorable_excursion_pct, max_adverse_excursion_pct,
          benchmark_return_pct, benchmark_status, status, provenance, unavailable_reason,
          observed_at, due_at, attempt_count, last_attempt_at, next_attempt_at, last_error_kind
        )
        SELECT o.source_kind,
               COALESCE(m.new_id, o.source_id),
               o.stock_id, o.baseline_price, o.baseline_at, o.horizon,
               o.close_price, o.return_pct, o.max_favorable_excursion_pct,
               o.max_adverse_excursion_pct, o.benchmark_return_pct, o.benchmark_status,
               o.status, o.provenance, o.unavailable_reason, o.observed_at, o.due_at,
               o.attempt_count, o.last_attempt_at, o.next_attempt_at, o.last_error_kind
        FROM signal_observations o
        LEFT JOIN signal_id_map m
          ON o.source_kind = 'strategy-signal' AND m.old_id = o.source_id
      `);
      tx.run(sql`DROP TABLE signal_observations`);
      tx.run(sql`ALTER TABLE signal_observations_rebuild RENAME TO signal_observations`);
      tx.run(sql`
        CREATE INDEX signal_observations_status_baseline_idx
        ON signal_observations (status, baseline_at)
      `);
      tx.run(sql`
        CREATE INDEX signal_observations_due_idx
        ON signal_observations (status, due_at, next_attempt_at)
      `);

      // 4) 存量 JSON 里引用旧 signal id 的地方：递归替换成新 id。
      const lookup = (value: string): string | undefined =>
        tx.all<{ new_id: string }>(sql`SELECT new_id FROM signal_id_map WHERE old_id = ${value}`)[0]
          ?.new_id;
      const rewrite = (value: unknown): unknown => {
        if (typeof value === 'string') {
          if (value.length < 40 || !value.includes(':')) return value;
          return lookup(value) ?? value;
        }
        if (Array.isArray(value)) return value.map((item) => rewrite(item));
        if (value !== null && typeof value === 'object') {
          return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([key, item]) => [
              key,
              rewrite(item),
            ]),
          );
        }
        return value;
      };
      const adviceRows = tx.all<{ id: string; based_on: string }>(
        sql`SELECT id, based_on FROM advices WHERE based_on LIKE '%strategy-run-%'`,
      );
      for (const row of adviceRows) {
        tx.run(
          sql`UPDATE advices SET based_on = ${JSON.stringify(rewrite(JSON.parse(row.based_on)))} WHERE id = ${row.id}`,
        );
      }
      const planRows = tx.all<{ version_id: string; plan_json: string }>(
        sql`SELECT version_id, plan_json FROM trading_plans WHERE plan_json LIKE '%strategy-run-%'`,
      );
      for (const row of planRows) {
        tx.run(
          sql`UPDATE trading_plans SET plan_json = ${JSON.stringify(rewrite(JSON.parse(row.plan_json)))} WHERE version_id = ${row.version_id}`,
        );
      }

      tx.run(sql`DROP TABLE signal_id_map`);
      tx.run(sql`
        INSERT INTO schema_migrations (id, applied_at, checksum, details_json)
        VALUES (${migrationId}, ${Date.now()}, ${migrationId}, ${JSON.stringify({
          rewritten,
          advices: adviceRows.length,
          plans: planRows.length,
        })})
        ON CONFLICT(id) DO UPDATE SET
          applied_at = excluded.applied_at,
          details_json = excluded.details_json
      `);
      console.warn(
        `[migrate] strategy_signals: ${rewritten} 条信号改用 64 位整数 id，并压缩 JSON 列`,
      );
    },
    { behavior: 'immediate' },
  );
};

/**
 * 回退 strategy_signals 的 JSON 压缩：单行只有 50–250 字节，gzip 头 + base64 反而更大
 * （实测 evidence 82.7MB → 253.6MB、snapshot 341.8MB → 368.6MB）。只保留 id 改造，
 * 这两列恢复明文 JSON。幂等：没有压缩前缀的行时直接返回。
 */
const migrateStrategySignalJsonToPlain = (db: DrizzleDb): void => {
  const migrationId = 'strategy-signal-json-plain-v1';
  const applied = db.all<{ id: string }>(
    sql`SELECT id FROM schema_migrations WHERE id = ${migrationId}`,
  )[0];
  if (applied !== undefined) return;
  const compressed =
    db.all<{ n: number }>(sql`
    SELECT COUNT(*) AS n FROM strategy_signals
    WHERE evidence_json LIKE 'zlib+base64:%' OR evaluation_snapshot_json LIKE 'zlib+base64:%'
  `)[0]?.n ?? 0;
  if (compressed === 0) {
    db.run(sql`
      INSERT INTO schema_migrations (id, applied_at, checksum, details_json)
      VALUES (${migrationId}, ${Date.now()}, ${migrationId}, '{"rewritten":0}')
      ON CONFLICT(id) DO NOTHING
    `);
    return;
  }
  db.transaction(
    (tx) => {
      tx.run(sql`
        CREATE TABLE strategy_signals_rebuild (
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
      type RebuildRow = {
        rid: number;
        id: string;
        strategy_id: string;
        strategy_version_id: string;
        run_id: string;
        rule_id: string;
        stock_id: string;
        ts: number;
        score: number;
        direction: string;
        evidence_json: string;
        evaluation_snapshot_json: string;
      };
      let cursor = 0;
      let rewritten = 0;
      for (;;) {
        const rows = tx.all<RebuildRow>(sql`
          SELECT rowid AS rid, id, strategy_id, strategy_version_id, run_id, rule_id,
                 stock_id, ts, score, direction, evidence_json, evaluation_snapshot_json
          FROM strategy_signals
          WHERE rowid > ${cursor}
          ORDER BY rowid
          LIMIT 500
        `);
        if (rows.length === 0) break;
        cursor = rows[rows.length - 1]?.rid ?? cursor;
        const values = rows.map(
          (row) => sql`(
            ${row.id}, ${row.strategy_id}, ${row.strategy_version_id}, ${row.run_id},
            ${row.rule_id}, ${row.stock_id}, ${row.ts}, ${row.score}, ${row.direction},
            ${decodeJsonBlobToText(row.evidence_json)},
            ${decodeJsonBlobToText(row.evaluation_snapshot_json)}
          )`,
        );
        tx.run(sql`
          INSERT INTO strategy_signals_rebuild (
            id, strategy_id, strategy_version_id, run_id, rule_id, stock_id,
            ts, score, direction, evidence_json, evaluation_snapshot_json
          ) VALUES ${sql.join(values, sql`, `)}
        `);
        rewritten += rows.length;
      }
      tx.run(sql`DROP TABLE strategy_signals`);
      tx.run(sql`ALTER TABLE strategy_signals_rebuild RENAME TO strategy_signals`);
      tx.run(sql`
        CREATE UNIQUE INDEX strategy_signals_run_event_unique
        ON strategy_signals (run_id, rule_id, stock_id, ts)
      `);
      tx.run(sql`
        CREATE INDEX strategy_signals_strategy_ts_idx ON strategy_signals (strategy_id, ts)
      `);
      tx.run(sql`CREATE INDEX strategy_signals_stock_ts_idx ON strategy_signals (stock_id, ts)`);
      tx.run(sql`CREATE INDEX strategy_signals_run_ts_idx ON strategy_signals (run_id, ts)`);
      tx.run(sql`
        INSERT INTO schema_migrations (id, applied_at, checksum, details_json)
        VALUES (${migrationId}, ${Date.now()}, ${migrationId}, ${JSON.stringify({ rewritten })})
        ON CONFLICT(id) DO UPDATE SET
          applied_at = excluded.applied_at,
          details_json = excluded.details_json
      `);
      console.warn(`[migrate] strategy_signals: ${rewritten} 条信号 JSON 回退为明文`);
    },
    { behavior: 'immediate' },
  );
};

const migrateCompressStrategyResults = (db: DrizzleDb): void => {
  const migrationId = 'strategy-run-results-zlib-v1';
  const applied = db.all<{ id: string }>(
    sql`SELECT id FROM schema_migrations WHERE id = ${migrationId}`,
  )[0];
  if (applied !== undefined) return;
  const pending = db.all<{ id: string }>(sql`
    SELECT id FROM strategy_runs
    WHERE results_json IS NOT NULL AND results_json NOT LIKE 'zlib+base64:%'
  `);
  let compressed = 0;
  let skipped = 0;
  for (const { id } of pending) {
    const stored = db.all<{ results_json: string | null }>(
      sql`SELECT results_json FROM strategy_runs WHERE id = ${id}`,
    )[0]?.results_json;
    if (stored === null || stored === undefined || stored.startsWith('zlib+base64:')) continue;
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) {
      skipped += 1;
      continue;
    }
    const encoded = `zlib+base64:${gzipSync(JSON.stringify(parsed), { level: 6 }).toString('base64')}`;
    db.run(sql`UPDATE strategy_runs SET results_json = ${encoded} WHERE id = ${id}`);
    compressed += 1;
  }
  db.run(sql`
    INSERT INTO schema_migrations (id, applied_at, checksum, details_json)
    VALUES (${migrationId}, ${Date.now()}, ${migrationId}, ${JSON.stringify({ compressed, skipped })})
    ON CONFLICT(id) DO UPDATE SET
      applied_at = excluded.applied_at,
      details_json = excluded.details_json
  `);
  if (compressed > 0) {
    console.warn(`[migrate] strategy_runs: 压缩 ${compressed} 条存量逐股明细`);
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
 * 驱动为 Bun 内置 bun:sqlite（drizzle-orm/bun-sqlite），CLI/Web/MCP 均以
 * bun 启动时可直接加载；vitest 需跑在 Bun 运行时（`bun test` / `bun --bun run vitest`）。
 */
export const createDrizzleRepos = (
  dbPath: string,
  options: { readonly migrate?: boolean } = {},
): DrizzleReposHandle => {
  const sqlite = new Database(dbPath);
  sqlite.exec('PRAGMA foreign_keys = ON');
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
    if (options.migrate !== false) ensureSchema(db);
  } catch (error) {
    // 迁移失败时释放 sqlite 句柄，避免调用方重试时泄漏文件锁。
    sqlite.close();
    throw error;
  }
  const writes = new RepositoryWriteScope();
  const repos: RepositoryRegistry = {
    publicMarket: new DrizzlePublicMarketStore(db),
    withWriteGuard: (check, operation) => writes.run(check, operation),
    account: new DrizzleAccountRepository(db),
    ledger: new DrizzleLedgerRepository(db),
    decisionReview: new DrizzleDecisionReviewRepository(db),
    stock: new DrizzleStockRepository(db, writes),
    stockUniverse: new DrizzleStockUniverseRepository(db, writes),
    sectorCatalog: new DrizzleSectorCatalogRepository(db, writes),
    limitUpLadderSnapshot: new DrizzleLimitUpLadderSnapshotRepository(db, writes),
    limitUpLadderSample: new DrizzleLimitUpLadderSampleRepository(db, writes),
    marketSnapshotBatch: new DrizzleMarketSnapshotBatchRepository(db, writes),
    marketRoomEvent: new DrizzleMarketRoomEventRepository(db, writes),
    limitUpBoardHistory: new DrizzleLimitUpBoardHistoryRepository(db, writes),
    holding: new DrizzleHoldingRepository(db),
    trade: new DrizzleTradeRepository(db),
    portfolioCashFlow: new DrizzlePortfolioCashFlowRepository(db),
    portfolioCorporateAction: new DrizzlePortfolioCorporateActionRepository(db),
    portfolioPerformanceSnapshot: new DrizzlePortfolioPerformanceSnapshotRepository(db, writes),
    advice: new DrizzleAdviceRepository(db, writes),
    stockBrief: new DrizzleStockBriefRepository(db, writes),
    forumDigest: new DrizzleForumDigestRepository(db, writes),
    tradingPlan: new DrizzleTradingPlanRepository(db),
    report: new DrizzleReportRepository(db, writes),
    quote: new DrizzleQuoteRepository(db, writes),
    dailyBar: new DrizzleDailyBarRepository(db, writes),
    adjustmentFactor: new DrizzleAdjustmentFactorRepository(db, writes),
    minuteBar: new DrizzleMinuteBarRepository(db, writes),
    signalObservation: new DrizzleSignalObservationRepository(db),
    strategy: new DrizzleStrategyRepository(db),
    strategyRun: new DrizzleStrategyRunRepository(db, writes),
    strategyWatchlistSubscription: new DrizzleStrategyWatchlistSubscriptionRepository(db),
    watchlist: new DrizzleWatchlistRepository(db),
    watchlistMember: new DrizzleWatchlistMemberRepository(db),
    notification: new DrizzleNotificationRepository(db),
    // v0.6 起
    alertPlan: new DrizzleAlertPlanRepository(db),
    watchTrigger: new DrizzleWatchTriggerRepository(db, writes),
    // v0.7 起：边沿状态机
    watchRuleState: new DrizzleWatchRuleStateRepository(db, writes),
    // ruo 迁移起
    workflowRun: new DrizzleWorkflowRunRepository(db),
    chat: new DrizzleChatRepository(db),
    adviceTracking: new DrizzleAdviceTrackingRepository(db),
  };
  return { repos, db, close: () => sqlite.close() };
};
