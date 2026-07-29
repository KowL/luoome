import type { Database } from 'bun:sqlite';

/**
 * W0 旧模型 fixture。只使用 Strategy/Watchlist 重构前的表，覆盖：
 * Tactic + signal、四种 resolver、多 refreshId、Pool + Trigger + RuleState。
 */
export const seedLegacyStrategyWatchlistFixture = (db: Database): void => {
  db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, currency TEXT NOT NULL,
      initial_capital REAL NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE stocks (
      id TEXT PRIMARY KEY, code TEXT NOT NULL, exchange TEXT NOT NULL, name TEXT NOT NULL,
      industry TEXT, name_source TEXT NOT NULL DEFAULT 'manual', name_updated_at INTEGER,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE holdings (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, stock_id TEXT NOT NULL, quantity INTEGER NOT NULL,
      available_quantity INTEGER NOT NULL, avg_cost REAL NOT NULL, opened_at INTEGER NOT NULL,
      closed_at INTEGER
    );
    CREATE TABLE tactics (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, tag TEXT NOT NULL, description TEXT NOT NULL,
      trigger_when TEXT NOT NULL, score_expression TEXT NOT NULL, direction TEXT NOT NULL,
      evidence_template TEXT NOT NULL, source TEXT NOT NULL, defined_at INTEGER NOT NULL
    );
    CREATE TABLE tactic_signals (
      id TEXT PRIMARY KEY, tactic_id TEXT NOT NULL, tactic_name TEXT NOT NULL, tactic_tag TEXT NOT NULL,
      stock_id TEXT NOT NULL, ts INTEGER NOT NULL, score REAL NOT NULL, direction TEXT NOT NULL,
      evidence TEXT NOT NULL, trigger_snapshot TEXT
    );
    CREATE TABLE stock_groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, resolver TEXT NOT NULL,
      refresh_policy TEXT NOT NULL, enabled INTEGER NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE group_member_snapshots (
      id TEXT PRIMARY KEY, group_id TEXT NOT NULL, stock_id TEXT NOT NULL, refresh_id TEXT NOT NULL,
      reason TEXT NOT NULL, score REAL, evidence_json TEXT NOT NULL DEFAULT '[]', data_as_of INTEGER,
      tactic_id TEXT, signal_ts INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE stock_pools (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, source TEXT, group_id TEXT,
      rules TEXT NOT NULL, cooldown_minutes INTEGER NOT NULL, enabled INTEGER NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, logic TEXT NOT NULL DEFAULT 'ANY',
      trigger_mode TEXT NOT NULL DEFAULT 'on-enter', priority TEXT,
      daily_notification_limit INTEGER NOT NULL DEFAULT 20,
      notify_on_recovery INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE watch_triggers (
      id TEXT PRIMARY KEY, pool_id TEXT NOT NULL, stock_id TEXT NOT NULL, rule_kind TEXT NOT NULL,
      direction TEXT NOT NULL, reason TEXT NOT NULL, evidence TEXT NOT NULL, quote_close REAL,
      quote_ts INTEGER, notified INTEGER NOT NULL, created_at INTEGER NOT NULL,
      rule_id TEXT NOT NULL DEFAULT '', trigger_type TEXT NOT NULL DEFAULT 'triggered',
      priority TEXT NOT NULL DEFAULT 'normal',
      delivery_status TEXT NOT NULL DEFAULT 'not-requested', notification_id TEXT,
      eval_snapshot TEXT NOT NULL DEFAULT '{}', feedback TEXT, feedback_at INTEGER, event_id TEXT
    );
    CREATE TABLE watch_rule_states (
      pool_id TEXT NOT NULL, stock_id TEXT NOT NULL, rule_id TEXT NOT NULL, active INTEGER NOT NULL,
      first_triggered_at INTEGER, last_evaluated_at INTEGER NOT NULL, last_value REAL,
      last_recovered_at INTEGER, PRIMARY KEY (pool_id, stock_id, rule_id)
    );

    INSERT INTO accounts VALUES
      ('fixture-account', 'Fixture account', 'real', 'CNY', 100000, 1785254400000);
    INSERT INTO stocks VALUES
      ('600000.SH', '600000', 'SH', '浦发银行', '银行', 'manual', NULL, 1785254400000),
      ('600519.SH', '600519', 'SH', '贵州茅台', '白酒', 'manual', NULL, 1785254400000),
      ('000001.SZ', '000001', 'SZ', '平安银行', '银行', 'manual', NULL, 1785254400000),
      ('002594.SZ', '002594', 'SZ', '比亚迪', '汽车', 'manual', NULL, 1785254400000);
    INSERT INTO holdings VALUES
      ('fixture-holding-active', 'fixture-account', '600000.SH', 100, 100, 10, 1785254400000, NULL),
      ('fixture-holding-closed', 'fixture-account', '000001.SZ', 0, 0, 9, 1785254400000, 1785340800000);

    INSERT INTO tactics VALUES
      ('fixture-builtin', 'Fixture builtin', 'momentum', 'builtin tactic', '1 == 1', '80',
       'bullish', '["builtin evidence"]', 'builtin', 1785254400000),
      ('fixture-user', 'Fixture user', 'risk', 'user tactic', '1 == 1', '70',
       'bearish', '["user evidence"]', 'user', 1785254400000);
    INSERT INTO tactic_signals VALUES
      ('fixture-signal-1', 'fixture-builtin', 'Fixture builtin', 'momentum', '600519.SH',
       1785340800000, 88, 'bullish', '["signal 1"]', '{"expression":"1 == 1","result":true}'),
      ('fixture-signal-2', 'fixture-user', 'Fixture user', 'risk', '002594.SZ',
       1785340801000, 75, 'bearish', '["signal 2"]', '{"expression":"1 == 1","result":true}');

    INSERT INTO stock_groups VALUES
      ('fixture-manual', 'Manual', NULL, '{"kind":"manual","stockIds":["600519.SH","002594.SZ"]}',
       'manual', 1, 1785254400000, 1785254400000),
      ('fixture-holdings', 'Holdings', NULL, '{"kind":"holdings","accountId":"fixture-account"}',
       'manual', 1, 1785254400000, 1785254400000),
      ('fixture-formula', 'Formula', NULL,
       '{"kind":"formula","tacticId":"fixture-builtin","lookbackDays":30,"minScore":60}',
       'daily', 1, 1785254400000, 1785427200000),
      ('fixture-llm', 'LLM', NULL, '{"kind":"llm","prompt":"fixture prompt","maxMembers":10}',
       'daily', 1, 1785254400000, 1785427200000);

    INSERT INTO group_member_snapshots VALUES
      ('formula-old-1', 'fixture-formula', '000001.SZ', 'formula-refresh-1', 'old formula', 61,
       '["old"]', 1785254400000, 'fixture-builtin', 1785254400000, 1785254400000),
      ('formula-new-1', 'fixture-formula', '600519.SH', 'formula-refresh-2', 'new formula 1', 88,
       '["new 1"]', 1785340800000, 'fixture-builtin', 1785340800000, 1785340800000),
      ('formula-new-2', 'fixture-formula', '002594.SZ', 'formula-refresh-2', 'new formula 2', 77,
       '["new 2"]', 1785340800000, 'fixture-builtin', 1785340800000, 1785340800001),
      ('llm-old-1', 'fixture-llm', '000001.SZ', 'llm-refresh-1', 'old llm', 55,
       '["old llm"]', 1785254400000, NULL, NULL, 1785254400000),
      ('llm-new-1', 'fixture-llm', '600000.SH', 'llm-refresh-2', 'new llm', 72,
       '["new llm"]', 1785340800000, NULL, NULL, 1785340800000);

    INSERT INTO stock_pools VALUES
      ('fixture-pool', 'Fixture pool', 'watch behavior golden', NULL, 'fixture-formula',
       '[{"id":"rule-tactic","kind":"tactic","tacticId":"fixture-builtin","minScore":60},{"id":"rule-price","kind":"price-change","pct":0.03,"direction":"up"}]',
       30, 1, 1785254400000, 1785340800000, 'ANY', 'on-enter', 'important', 20, 1);
    INSERT INTO watch_triggers VALUES
      ('fixture-trigger-sent', 'fixture-pool', '600519.SH', 'tactic', 'buy', 'tactic matched',
       '["score=88"]', 1500, 1785340800000, 1, 1785340801000, 'rule-tactic', 'triggered',
       'important', 'sent', 'fixture-notification', '{"ruleId":"rule-tactic","score":88}',
       'useful', 1785340900000, NULL),
      ('fixture-trigger-suppressed', 'fixture-pool', '002594.SZ', 'price-change', 'watch',
       'price moved', '["change=3.2%"]', 250, 1785340800000, 0, 1785340802000,
       'rule-price', 'triggered', 'normal', 'suppressed-cooldown', NULL,
       '{"ruleId":"rule-price","changePct":0.032}', NULL, NULL, NULL);
    INSERT INTO watch_rule_states VALUES
      ('fixture-pool', '600519.SH', 'rule-tactic', 1, 1785340801000, 1785340802000, 88, NULL),
      ('fixture-pool', '002594.SZ', 'rule-price', 0, 1785254400000, 1785340802000, 0.01,
       1785340802000);
  `);
};
