import { Database } from 'bun:sqlite';
import type { RepositoryRegistry } from '@luoome/core';
import { sql } from 'drizzle-orm';
import { type BunSQLiteDatabase, drizzle } from 'drizzle-orm/bun-sqlite';

import {
  DrizzleAccountRepository,
  DrizzleAdviceRepository,
  DrizzleDailyBarRepository,
  DrizzleGroupMemberRepository,
  DrizzleHoldingRepository,
  DrizzleNotificationRepository,
  DrizzleQuoteRepository,
  DrizzleStockGroupRepository,
  DrizzleStockPoolRepository,
  DrizzleStockRepository,
  DrizzleTacticRepository,
  DrizzleTradeRepository,
  DrizzleWatchRunRepository,
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
  // v0.6 起：股票池；分组化改造后 source 可空（deprecated）+ 增 group_id 列
  db.run(sql`
    CREATE TABLE IF NOT EXISTS stock_pools (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      source TEXT,
      group_id TEXT,
      rules TEXT NOT NULL,
      cooldown_minutes INTEGER NOT NULL,
      enabled INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  migrateLegacyStockPools(db);
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
      error TEXT
    )
  `);
  db.run(sql`CREATE INDEX IF NOT EXISTS watch_runs_started_at_idx ON watch_runs (started_at)`);
  // 分组化起（docs/stock-group-design.md §3）：股票分组 + 成员快照
  db.run(sql`
    CREATE TABLE IF NOT EXISTS stock_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      resolver TEXT NOT NULL,
      refresh_policy TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(sql`CREATE INDEX IF NOT EXISTS stock_groups_enabled_idx ON stock_groups (enabled)`);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS group_member_snapshots (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      stock_id TEXT NOT NULL,
      refresh_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(
    sql`CREATE INDEX IF NOT EXISTS group_members_group_refresh_idx ON group_member_snapshots (group_id, refresh_id)`,
  );
  db.run(
    sql`CREATE INDEX IF NOT EXISTS group_members_group_ts_idx ON group_member_snapshots (group_id, created_at)`,
  );
  // 阶段 B 存量数据迁移：v0.6 pool.source JSON → 分组 + 回填 group_id（幂等，须在两张新表 DDL 之后）
  migrateLegacyPoolSourcesToGroups(db);
};

/**
 * 旧版 stock_pools（v0.6：`source TEXT NOT NULL`、无 `group_id` 列）结构升级。
 *
 * 仅做结构兼容（沿用 v1 迁移形态，幂等）：
 * - 新库：表已由上方 DDL 按新结构建好，直接跳过
 * - 旧库：放宽 source NOT NULL（SQLite 不支持改列约束 → 表重建）+ 补 group_id 列；
 *   存量行 source 数据原样保留、group_id 置 NULL，数据迁移（拆分组）由
 *   migrateLegacyPoolSourcesToGroups 完成（docs/stock-group-design.md §5）
 */
const migrateLegacyStockPools = (db: DrizzleDb): void => {
  const cols = db.all<{ name: string; notnull: number }>(sql`PRAGMA table_info(stock_pools)`);
  if (cols.length === 0) return;
  const hasGroupId = cols.some((c) => c.name === 'group_id');
  const sourceCol = cols.find((c) => c.name === 'source');
  const legacySourceNotNull = sourceCol !== undefined && sourceCol.notnull === 1;
  if (!legacySourceNotNull) {
    // 已是新结构但缺 group_id（理论上的中间态）→ 仅补列
    if (!hasGroupId) {
      db.run(sql`ALTER TABLE stock_pools ADD COLUMN group_id TEXT`);
    }
    return;
  }
  db.transaction((tx) => {
    tx.run(sql`
      CREATE TABLE stock_pools_mig (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        source TEXT,
        group_id TEXT,
        rules TEXT NOT NULL,
        cooldown_minutes INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    tx.run(sql`
      INSERT INTO stock_pools_mig (id, name, description, source, group_id, rules, cooldown_minutes, enabled, created_at, updated_at)
      SELECT id, name, description, source, NULL, rules, cooldown_minutes, enabled, created_at, updated_at
      FROM stock_pools
    `);
    tx.run(sql`DROP TABLE stock_pools`);
    tx.run(sql`ALTER TABLE stock_pools_mig RENAME TO stock_pools`);
  });
};

/**
 * 阶段 B 存量数据迁移（docs/stock-group-design.md §5）：把 v0.6 pool.source JSON 拆成分组。
 *
 * - 找 group_id 为空（NULL 或 ''）且 source 列有 JSON 的旧 pool 行
 * - 按 source.kind 建分组（id=`<poolId>-group`）：
 *   manual → manual resolver；holdings → holdings resolver；
 *   tactic → formula resolver（tacticId/lookbackDays/minScore 平移，lookbackDays 缺省 30）
 * - 回填 pool.group_id；source 列数据保留不删（审计线索）
 * - tactic source 迁移后不立即跑刷新（db 层拿不到 LLM/tool），console.warn 提示用户手动跑
 * - 幂等：已回填 group_id 的行跳过；分组已存在时跳过创建但仍回填（崩在中途可重入）
 */
const migrateLegacyPoolSourcesToGroups = (db: DrizzleDb): void => {
  const rows = db.all<{ id: string; name: string; source: unknown }>(sql`
    SELECT id, name, source FROM stock_pools
    WHERE (group_id IS NULL OR group_id = '') AND source IS NOT NULL
  `);
  if (rows.length === 0) return;
  const nowMs = Date.now();

  for (const row of rows) {
    let source: unknown = row.source;
    if (typeof source === 'string') {
      try {
        source = JSON.parse(source);
      } catch {
        console.warn(`[migrate] pool ${row.id} 的 source JSON 解析失败，跳过`);
        continue;
      }
    }
    const s = source as {
      kind?: unknown;
      stockIds?: unknown;
      accountId?: unknown;
      tacticId?: unknown;
      lookbackDays?: unknown;
      minScore?: unknown;
    };

    let resolver: unknown;
    let refreshPolicy = 'manual';
    if (s.kind === 'manual') {
      const stockIds = Array.isArray(s.stockIds)
        ? s.stockIds.filter((x): x is string => typeof x === 'string' && x.length > 0)
        : [];
      if (stockIds.length === 0) {
        console.warn(`[migrate] pool ${row.id} 的 manual source stockIds 为空，跳过`);
        continue;
      }
      resolver = { kind: 'manual', stockIds };
    } else if (s.kind === 'holdings') {
      if (typeof s.accountId !== 'string' || s.accountId.length === 0) {
        console.warn(`[migrate] pool ${row.id} 的 holdings source 缺 accountId，跳过`);
        continue;
      }
      resolver = { kind: 'holdings', accountId: s.accountId };
    } else if (s.kind === 'tactic') {
      if (typeof s.tacticId !== 'string' || s.tacticId.length === 0) {
        console.warn(`[migrate] pool ${row.id} 的 tactic source 缺 tacticId，跳过`);
        continue;
      }
      resolver = {
        kind: 'formula',
        tacticId: s.tacticId,
        lookbackDays:
          typeof s.lookbackDays === 'number' && s.lookbackDays > 0 ? s.lookbackDays : 30,
        ...(typeof s.minScore === 'number' ? { minScore: s.minScore } : {}),
      };
      refreshPolicy = 'daily';
    } else {
      console.warn(`[migrate] pool ${row.id} 的 source kind 无法识别（${String(s.kind)}），跳过`);
      continue;
    }

    const groupId = `${row.id}-group`;
    const resolverJson = JSON.stringify(resolver);
    db.transaction((tx) => {
      const existing = tx.all<{ id: string }>(
        sql`SELECT id FROM stock_groups WHERE id = ${groupId}`,
      );
      if (existing.length === 0) {
        tx.run(sql`
          INSERT INTO stock_groups (id, name, description, resolver, refresh_policy, enabled, created_at, updated_at)
          VALUES (${groupId}, ${row.name}, ${'由 v0.6 pool.source 迁移（docs/stock-group-design.md §5）'}, ${resolverJson}, ${refreshPolicy}, 1, ${nowMs}, ${nowMs})
        `);
      }
      tx.run(sql`UPDATE stock_pools SET group_id = ${groupId} WHERE id = ${row.id}`);
    });

    if (s.kind === 'tactic') {
      console.warn(
        `[migrate] pool ${row.id} 的 tactic source 已迁移为 formula 分组 ${groupId}；` +
          `请手动跑一次刷新落首批快照：luoome tools call refresh_stock_group --input '{"groupId":"${groupId}"}'`,
      );
    }
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
    watchRun: new DrizzleWatchRunRepository(db),
    // 分组化起
    stockGroup: new DrizzleStockGroupRepository(db),
    groupMember: new DrizzleGroupMemberRepository(db),
  };
  return { repos, db, close: () => sqlite.close() };
};
