import { Database } from 'bun:sqlite';
import type { RepositoryRegistry } from '@luoome/core';
import { sql } from 'drizzle-orm';
import { type BunSQLiteDatabase, drizzle } from 'drizzle-orm/bun-sqlite';

import {
  DrizzleAccountRepository,
  DrizzleAdviceRepository,
  DrizzleDailyBarRepository,
  DrizzleHoldingRepository,
  DrizzleNotificationRepository,
  DrizzleQuoteRepository,
  DrizzleStockPoolRepository,
  DrizzleStockRepository,
  DrizzleTacticRepository,
  DrizzleTradeRepository,
  DrizzleWatchTriggerRepository,
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
      industry TEXT
    )
  `);
  db.run(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS stocks_code_exchange_unique
    ON stocks (code, exchange)
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
      ts INTEGER NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume INTEGER NOT NULL,
      source TEXT NOT NULL,
      CONSTRAINT price_snapshots_pk PRIMARY KEY (stock_id, ts)
    )
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
      source TEXT NOT NULL,
      CONSTRAINT daily_bars_pk PRIMARY KEY (stock_id, date)
    )
  `);
  db.run(sql`
    CREATE INDEX IF NOT EXISTS daily_bars_stock_idx ON daily_bars (stock_id)
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS tactics (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      tag TEXT NOT NULL,
      description TEXT NOT NULL,
      trigger_when TEXT NOT NULL,
      score_expression TEXT NOT NULL,
      direction TEXT NOT NULL,
      evidence_template TEXT NOT NULL,
      source TEXT NOT NULL,
      defined_at INTEGER NOT NULL
    )
  `);
  db.run(sql`CREATE INDEX IF NOT EXISTS tactics_tag_idx ON tactics (tag)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS tactics_source_idx ON tactics (source)`);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS tactic_signals (
      id TEXT PRIMARY KEY,
      tactic_id TEXT NOT NULL,
      tactic_name TEXT NOT NULL,
      tactic_tag TEXT NOT NULL,
      stock_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      score REAL NOT NULL,
      direction TEXT NOT NULL,
      evidence TEXT NOT NULL,
      trigger_snapshot TEXT
    )
  `);
  db.run(
    sql`CREATE INDEX IF NOT EXISTS tactic_signals_tactic_ts_idx ON tactic_signals (tactic_id, ts)`,
  );
  db.run(
    sql`CREATE INDEX IF NOT EXISTS tactic_signals_stock_ts_idx ON tactic_signals (stock_id, ts)`,
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
  // v0.6 起：股票池
  db.run(sql`
    CREATE TABLE IF NOT EXISTS stock_pools (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      source TEXT NOT NULL,
      rules TEXT NOT NULL,
      cooldown_minutes INTEGER NOT NULL,
      enabled INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(sql`CREATE INDEX IF NOT EXISTS stock_pools_enabled_idx ON stock_pools (enabled)`);
  // v0.6 起：盯盘触发
  db.run(sql`
    CREATE TABLE IF NOT EXISTS watch_triggers (
      id TEXT PRIMARY KEY,
      pool_id TEXT NOT NULL,
      stock_id TEXT NOT NULL,
      rule_kind TEXT NOT NULL,
      direction TEXT NOT NULL,
      reason TEXT NOT NULL,
      evidence TEXT NOT NULL,
      quote_close REAL NOT NULL,
      quote_ts INTEGER NOT NULL,
      notified INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(
    sql`CREATE INDEX IF NOT EXISTS watch_triggers_pool_stock_rule_ts_idx ON watch_triggers (pool_id, stock_id, rule_kind, created_at)`,
  );
  db.run(
    sql`CREATE INDEX IF NOT EXISTS watch_triggers_pool_ts_idx ON watch_triggers (pool_id, created_at)`,
  );
};

/** createDrizzleRepos 的返回句柄：repos + db + close()。 */
export interface DrizzleReposHandle {
  readonly repos: RepositoryRegistry;
  readonly db: DrizzleDb;
  readonly close: () => void;
}

/**
 * 打开（必要时创建）SQLite 数据库，建表，并返回 5 个 Drizzle repository。
 *
 * @param dbPath SQLite 文件路径；传 ':memory:' 用内存库（测试）。
 *
 * 驱动为 Bun 内置 bun:sqlite（drizzle-orm/bun-sqlite），CLI/TUI/Web/MCP 均以
 * bun 启动时可直接加载；vitest 需跑在 Bun 运行时（`bun test` / `bun --bun run vitest`）。
 */
export const createDrizzleRepos = (dbPath: string): DrizzleReposHandle => {
  const sqlite = new Database(dbPath);
  // :memory: 不支持 WAL（pragma 会被静默忽略），文件库开 WAL 提升并发读体验。
  if (dbPath !== ':memory:') {
    sqlite.exec('PRAGMA journal_mode = WAL');
  }
  const db = drizzle(sqlite, { schema });
  ensureSchema(db);
  const repos: RepositoryRegistry = {
    account: new DrizzleAccountRepository(db),
    stock: new DrizzleStockRepository(db),
    holding: new DrizzleHoldingRepository(db),
    trade: new DrizzleTradeRepository(db),
    advice: new DrizzleAdviceRepository(db),
    quote: new DrizzleQuoteRepository(db),
    dailyBar: new DrizzleDailyBarRepository(db),
    tactic: new DrizzleTacticRepository(db),
    notification: new DrizzleNotificationRepository(db),
    // v0.6 起
    stockPool: new DrizzleStockPoolRepository(db),
    watchTrigger: new DrizzleWatchTriggerRepository(db),
  };
  return { repos, db, close: () => sqlite.close() };
};
