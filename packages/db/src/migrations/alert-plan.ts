import type { Database } from 'bun:sqlite';

import { defineSchemaMigration, resolveLegacyTargetId, type SchemaMigration } from './runner.js';

const migrationMappings = (db: Database, id: string): Readonly<Record<string, string>> => {
  const row = db
    .query<{ readonly details_json: string }, [string]>(
      'SELECT details_json FROM schema_migrations WHERE id = ?',
    )
    .get(id);
  if (row === null) return {};
  return (JSON.parse(row.details_json) as { mappings?: Record<string, string> }).mappings ?? {};
};

const assertAlertPlanTables = (db: Database): Record<string, unknown> => {
  const table = db
    .query<{ readonly name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='alert_plans'",
    )
    .get();
  if (table === null) throw new Error('alert_plans expand table 缺失');
  const triggerColumns = db
    .query<{ readonly name: string }, []>('PRAGMA table_info(watch_triggers)')
    .all()
    .map((row) => row.name);
  const stateColumns = db
    .query<{ readonly name: string }, []>('PRAGMA table_info(watch_rule_states)')
    .all()
    .map((row) => row.name);
  if (!triggerColumns.includes('alert_plan_id') || !stateColumns.includes('alert_plan_id')) {
    throw new Error('watch trigger/state alert_plan_id 兼容列缺失');
  }
  return { table: 'alert_plans', compatibilityColumns: true };
};

interface PoolRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly group_id: string | null;
  readonly rules: string;
  readonly cooldown_minutes: number;
  readonly enabled: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly logic: string;
  readonly trigger_mode: string;
  readonly priority: string | null;
  readonly daily_notification_limit: number;
  readonly notify_on_recovery: number;
}

const migrateStockPools = (db: Database): Record<string, unknown> => {
  const watchlistMappings = migrationMappings(db, '20260729_04_migrate_stock_groups');
  const strategyMappings = migrationMappings(db, '20260729_02_migrate_tactics');
  const occupied = new Set(
    db
      .query<{ readonly id: string }, []>('SELECT id FROM alert_plans')
      .all()
      .map((row) => row.id),
  );
  const mappings: Record<string, string> = {};
  const warnings: string[] = [];
  const pools = db.query<PoolRow, []>('SELECT * FROM stock_pools ORDER BY id').all();
  const insert = db.prepare(`
    INSERT INTO alert_plans
      (id,name,description,watchlist_id,rules,logic,trigger_mode,priority,cooldown_minutes,
       daily_notification_limit,notify_on_recovery,enabled,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  for (const pool of pools) {
    const resolution = resolveLegacyTargetId({
      legacyId: pool.id,
      targetKind: 'alert-plan',
      occupiedIds: occupied,
    });
    occupied.add(resolution.targetId);
    mappings[pool.id] = resolution.targetId;
    const watchlistId = pool.group_id === null ? undefined : watchlistMappings[pool.group_id];
    let enabled = pool.enabled;
    if (watchlistId === undefined) {
      enabled = 0;
      warnings.push(`pool ${pool.id} 找不到 Watchlist 映射，目标已禁用`);
    }
    const rules = (JSON.parse(pool.rules) as Record<string, unknown>[]).map((rule) => {
      if (rule.kind !== 'tactic') return rule;
      const tacticId = typeof rule.tacticId === 'string' ? rule.tacticId : undefined;
      const strategyId = tacticId === undefined ? undefined : strategyMappings[tacticId];
      if (strategyId === undefined) {
        enabled = 0;
        warnings.push(`pool ${pool.id} tactic rule 找不到 Strategy 映射，目标已禁用`);
      }
      const { tacticId: _legacyTacticId, ...rest } = rule;
      void _legacyTacticId;
      return {
        ...rest,
        kind: 'strategy-signal',
        strategyId: strategyId ?? `missing:${tacticId ?? 'unknown'}`,
      };
    });
    insert.run(
      resolution.targetId,
      pool.name,
      pool.description,
      watchlistId ?? `missing:${pool.group_id ?? 'group'}`,
      JSON.stringify(rules),
      pool.logic,
      pool.trigger_mode,
      pool.priority,
      pool.cooldown_minutes,
      pool.daily_notification_limit,
      pool.notify_on_recovery,
      enabled,
      pool.created_at,
      pool.updated_at,
    );
    db.prepare('UPDATE watch_triggers SET alert_plan_id=? WHERE pool_id=?').run(
      resolution.targetId,
      pool.id,
    );
    db.prepare('UPDATE watch_rule_states SET alert_plan_id=? WHERE pool_id=?').run(
      resolution.targetId,
      pool.id,
    );
  }
  return { poolsScanned: pools.length, alertPlansWritten: pools.length, mappings, warnings };
};

export const ALERT_PLAN_MIGRATIONS: readonly SchemaMigration[] = [
  defineSchemaMigration({
    id: '20260729_05_alert_plan_tables',
    source: 'ensure alert_plans and trigger/state alert_plan_id columns v1',
    up: assertAlertPlanTables,
  }),
  defineSchemaMigration({
    id: '20260729_06_migrate_stock_pools',
    source: 'map stock_pools to alert_plans and tactic rules to strategy-signal v1',
    up: migrateStockPools,
  }),
];
