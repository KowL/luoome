import { Database } from 'bun:sqlite';

export interface LegacyStrategyWatchlistBaseline {
  readonly schemaVersion: 1;
  readonly counts: {
    readonly tactics: number;
    readonly tacticSignals: number;
    readonly stockGroups: number;
    readonly groupMemberSnapshots: number;
    readonly stockPools: number;
    readonly watchTriggers: number;
    readonly watchRuleStates: number;
  };
  readonly resolverCounts: Record<'manual' | 'holdings' | 'formula' | 'llm' | 'unknown', number>;
  readonly refreshIdsByGroup: Readonly<Record<string, readonly string[]>>;
  readonly currentMembersByGroup: Readonly<Record<string, readonly string[]>>;
  readonly watchGolden: {
    readonly enabledPoolIds: readonly string[];
    readonly triggers: readonly {
      readonly id: string;
      readonly poolId: string;
      readonly stockId: string;
      readonly ruleId: string;
      readonly deliveryStatus: string;
    }[];
    readonly ruleStates: readonly {
      readonly poolId: string;
      readonly stockId: string;
      readonly ruleId: string;
      readonly active: boolean;
    }[];
  };
  readonly orphanReferences: readonly string[];
}

const tableExists = (db: Database, table: string): boolean =>
  db
    .query<{ readonly count: number }, [string]>(
      "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(table)?.count === 1;

const countRows = (db: Database, table: string): number => {
  if (!tableExists(db, table)) return 0;
  return (
    db.query<{ readonly count: number }, []>(`SELECT count(*) AS count FROM "${table}"`).get()
      ?.count ?? 0
  );
};

interface GroupRow {
  readonly id: string;
  readonly resolver: string;
}

const stockIds = (rows: readonly { readonly stock_id: string }[]): readonly string[] =>
  rows.map((row) => row.stock_id).sort();

/**
 * 只读 W0 baseline。它只查询旧模型，供 expand/backfill 前后的 golden 与 W6 verify 扩展复用。
 */
export const verifyLegacyStrategyWatchlistBaseline = (
  db: Database,
): LegacyStrategyWatchlistBaseline => {
  const resolverCounts = { manual: 0, holdings: 0, formula: 0, llm: 0, unknown: 0 };
  const refreshIdsByGroup: Record<string, readonly string[]> = {};
  const currentMembersByGroup: Record<string, readonly string[]> = {};
  const groups = tableExists(db, 'stock_groups')
    ? db.query<GroupRow, []>('SELECT id, resolver FROM stock_groups ORDER BY id').all()
    : [];

  for (const group of groups) {
    let resolver: Record<string, unknown>;
    try {
      resolver = JSON.parse(group.resolver) as Record<string, unknown>;
    } catch {
      resolver = {};
    }
    const kind = resolver.kind;
    if (kind === 'manual' || kind === 'holdings' || kind === 'formula' || kind === 'llm') {
      resolverCounts[kind] += 1;
    } else {
      resolverCounts.unknown += 1;
    }

    const refreshIds = tableExists(db, 'group_member_snapshots')
      ? db
          .query<{ readonly refresh_id: string }, [string]>(
            'SELECT DISTINCT refresh_id FROM group_member_snapshots WHERE group_id = ? ORDER BY refresh_id',
          )
          .all(group.id)
          .map((row) => row.refresh_id)
      : [];
    refreshIdsByGroup[group.id] = refreshIds;

    if (kind === 'manual') {
      currentMembersByGroup[group.id] = Array.isArray(resolver.stockIds)
        ? resolver.stockIds.filter((id): id is string => typeof id === 'string').sort()
        : [];
      continue;
    }
    if (kind === 'holdings') {
      currentMembersByGroup[group.id] =
        typeof resolver.accountId === 'string' && tableExists(db, 'holdings')
          ? stockIds(
              db
                .query<{ readonly stock_id: string }, [string]>(
                  'SELECT stock_id FROM holdings WHERE account_id = ? AND closed_at IS NULL ORDER BY stock_id',
                )
                .all(resolver.accountId),
            )
          : [];
      continue;
    }
    const latest = tableExists(db, 'group_member_snapshots')
      ? db
          .query<{ readonly refresh_id: string }, [string]>(
            'SELECT refresh_id FROM group_member_snapshots WHERE group_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
          )
          .get(group.id)?.refresh_id
      : undefined;
    currentMembersByGroup[group.id] =
      latest === undefined
        ? []
        : stockIds(
            db
              .query<{ readonly stock_id: string }, [string, string]>(
                'SELECT stock_id FROM group_member_snapshots WHERE group_id = ? AND refresh_id = ? ORDER BY stock_id',
              )
              .all(group.id, latest),
          );
  }

  const orphanReferences: string[] = [];
  if (tableExists(db, 'tactic_signals') && tableExists(db, 'tactics')) {
    for (const row of db
      .query<{ readonly id: string }, []>(
        'SELECT s.id FROM tactic_signals s LEFT JOIN tactics t ON t.id = s.tactic_id WHERE t.id IS NULL ORDER BY s.id',
      )
      .all()) {
      orphanReferences.push(`tactic_signal:${row.id}`);
    }
  }
  if (tableExists(db, 'stock_pools') && tableExists(db, 'stock_groups')) {
    for (const row of db
      .query<{ readonly id: string }, []>(
        'SELECT p.id FROM stock_pools p LEFT JOIN stock_groups g ON g.id = p.group_id WHERE p.group_id IS NOT NULL AND g.id IS NULL ORDER BY p.id',
      )
      .all()) {
      orphanReferences.push(`stock_pool:${row.id}`);
    }
  }

  const triggers = tableExists(db, 'watch_triggers')
    ? db
        .query<
          {
            readonly id: string;
            readonly pool_id: string;
            readonly stock_id: string;
            readonly rule_id: string;
            readonly delivery_status: string;
          },
          []
        >(
          'SELECT id, pool_id, stock_id, rule_id, delivery_status FROM watch_triggers ORDER BY created_at, id',
        )
        .all()
        .map((row) => ({
          id: row.id,
          poolId: row.pool_id,
          stockId: row.stock_id,
          ruleId: row.rule_id,
          deliveryStatus: row.delivery_status,
        }))
    : [];
  const ruleStates = tableExists(db, 'watch_rule_states')
    ? db
        .query<
          {
            readonly pool_id: string;
            readonly stock_id: string;
            readonly rule_id: string;
            readonly active: number;
          },
          []
        >(
          'SELECT pool_id, stock_id, rule_id, active FROM watch_rule_states ORDER BY pool_id, stock_id, rule_id',
        )
        .all()
        .map((row) => ({
          poolId: row.pool_id,
          stockId: row.stock_id,
          ruleId: row.rule_id,
          active: row.active === 1,
        }))
    : [];

  return {
    schemaVersion: 1,
    counts: {
      tactics: countRows(db, 'tactics'),
      tacticSignals: countRows(db, 'tactic_signals'),
      stockGroups: countRows(db, 'stock_groups'),
      groupMemberSnapshots: countRows(db, 'group_member_snapshots'),
      stockPools: countRows(db, 'stock_pools'),
      watchTriggers: countRows(db, 'watch_triggers'),
      watchRuleStates: countRows(db, 'watch_rule_states'),
    },
    resolverCounts,
    refreshIdsByGroup,
    currentMembersByGroup,
    watchGolden: {
      enabledPoolIds: tableExists(db, 'stock_pools')
        ? db
            .query<{ readonly id: string }, []>(
              'SELECT id FROM stock_pools WHERE enabled = 1 ORDER BY id',
            )
            .all()
            .map((row) => row.id)
        : [],
      triggers,
      ruleStates,
    },
    orphanReferences,
  };
};

/** 文件库只读入口，供 `luoome migration verify strategy-watchlist` 使用。 */
export const verifyLegacyStrategyWatchlistDatabase = (
  dbPath: string,
): LegacyStrategyWatchlistBaseline => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return verifyLegacyStrategyWatchlistBaseline(db);
  } finally {
    db.close();
  }
};

export interface StrategyWatchlistMigrationVerification {
  readonly schemaVersion: 2;
  readonly legacy: LegacyStrategyWatchlistBaseline;
  readonly watchlist: {
    readonly counts: {
      readonly watchlists: number;
      readonly members: number;
      readonly sources: number;
      readonly syncRuns: number;
      readonly snapshots: number;
    };
    readonly mappings: Readonly<Record<string, string>>;
    readonly currentMembersByWatchlist: Readonly<Record<string, readonly string[]>>;
    readonly memberSetDifferences: readonly string[];
    readonly orphanReferences: readonly string[];
    readonly readyForW4: boolean;
  };
  readonly alertPlan: {
    readonly counts: {
      readonly stockPools: number;
      readonly alertPlans: number;
      readonly enabledStockPools: number;
      readonly enabledAlertPlans: number;
    };
    readonly mappings: Readonly<Record<string, string>>;
    readonly ruleDifferences: readonly string[];
    readonly orphanReferences: readonly string[];
    readonly readyForW5: boolean;
  };
}

export const verifyStrategyWatchlistMigration = (
  db: Database,
): StrategyWatchlistMigrationVerification => {
  const legacy = verifyLegacyStrategyWatchlistBaseline(db);
  const migration = tableExists(db, 'schema_migrations')
    ? db
        .query<{ readonly details_json: string }, []>(
          "SELECT details_json FROM schema_migrations WHERE id = '20260729_04_migrate_stock_groups'",
        )
        .get()
    : undefined;
  const mappings =
    migration === undefined || migration === null
      ? {}
      : ((JSON.parse(migration.details_json) as { mappings?: Record<string, string> }).mappings ??
        {});
  const currentMembersByWatchlist: Record<string, readonly string[]> = {};
  const memberSetDifferences: string[] = [];
  for (const [groupId, expected] of Object.entries(legacy.currentMembersByGroup)) {
    const watchlistId = mappings[groupId];
    if (watchlistId === undefined) {
      memberSetDifferences.push(`${groupId}:missing-watchlist-mapping`);
      continue;
    }
    const actual = tableExists(db, 'watchlist_members')
      ? db
          .query<{ readonly stock_id: string }, [string]>(
            "SELECT stock_id FROM watchlist_members WHERE watchlist_id = ? AND stage <> 'archived' ORDER BY stock_id",
          )
          .all(watchlistId)
          .map((row) => row.stock_id)
      : [];
    currentMembersByWatchlist[watchlistId] = actual;
    if (actual.join('\0') !== expected.join('\0')) {
      memberSetDifferences.push(
        `${groupId}->${watchlistId}: expected=[${expected.join(',')}] actual=[${actual.join(',')}]`,
      );
    }
  }
  const orphanReferences: string[] = [];
  if (tableExists(db, 'watchlist_members') && tableExists(db, 'watchlists')) {
    for (const row of db
      .query<{ readonly id: string }, []>(
        'SELECT m.id FROM watchlist_members m LEFT JOIN watchlists w ON w.id=m.watchlist_id WHERE w.id IS NULL ORDER BY m.id',
      )
      .all()) {
      orphanReferences.push(`watchlist_member:${row.id}`);
    }
  }
  if (tableExists(db, 'watchlist_member_sources') && tableExists(db, 'watchlist_members')) {
    for (const row of db
      .query<{ readonly id: string }, []>(
        'SELECT s.id FROM watchlist_member_sources s LEFT JOIN watchlist_members m ON m.id=s.member_id WHERE m.id IS NULL ORDER BY s.id',
      )
      .all()) {
      orphanReferences.push(`watchlist_source:${row.id}`);
    }
  }
  if (tableExists(db, 'membership_snapshots') && tableExists(db, 'watchlist_sync_runs')) {
    for (const row of db
      .query<{ readonly id: string }, []>(
        'SELECT s.id FROM membership_snapshots s LEFT JOIN watchlist_sync_runs r ON r.id=s.sync_run_id WHERE r.id IS NULL ORDER BY s.id',
      )
      .all()) {
      orphanReferences.push(`membership_snapshot:${row.id}`);
    }
  }
  const counts = {
    watchlists: countRows(db, 'watchlists'),
    members: countRows(db, 'watchlist_members'),
    sources: countRows(db, 'watchlist_member_sources'),
    syncRuns: countRows(db, 'watchlist_sync_runs'),
    snapshots: countRows(db, 'membership_snapshots'),
  };
  const alertMigration = tableExists(db, 'schema_migrations')
    ? db
        .query<{ readonly details_json: string }, []>(
          "SELECT details_json FROM schema_migrations WHERE id = '20260729_06_migrate_stock_pools'",
        )
        .get()
    : undefined;
  const alertMappings =
    alertMigration === undefined || alertMigration === null
      ? {}
      : ((JSON.parse(alertMigration.details_json) as { mappings?: Record<string, string> })
          .mappings ?? {});
  const ruleDifferences: string[] = [];
  for (const [poolId, alertPlanId] of Object.entries(alertMappings)) {
    const pool = db
      .query<{ readonly rules: string }, [string]>('SELECT rules FROM stock_pools WHERE id=?')
      .get(poolId);
    const plan = db
      .query<{ readonly rules: string }, [string]>('SELECT rules FROM alert_plans WHERE id=?')
      .get(alertPlanId);
    if (pool === null || plan === null) {
      ruleDifferences.push(`${poolId}->${alertPlanId}:missing-row`);
      continue;
    }
    const expected = (JSON.parse(pool.rules) as Record<string, unknown>[]).map((rule) => {
      if (rule.kind !== 'tactic') return rule;
      const { tacticId: _tacticId, ...rest } = rule;
      return { ...rest, kind: 'strategy-signal' };
    });
    const actual = (JSON.parse(plan.rules) as Record<string, unknown>[]).map(
      ({ strategyId: _strategyId, ...rule }) => rule,
    );
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      ruleDifferences.push(`${poolId}->${alertPlanId}:rules-differ`);
    }
  }
  const alertOrphans: string[] = [];
  if (tableExists(db, 'alert_plans') && tableExists(db, 'watchlists')) {
    for (const row of db
      .query<{ readonly id: string }, []>(
        'SELECT p.id FROM alert_plans p LEFT JOIN watchlists w ON w.id=p.watchlist_id WHERE w.id IS NULL ORDER BY p.id',
      )
      .all()) {
      alertOrphans.push(`alert_plan:${row.id}`);
    }
  }
  if (tableExists(db, 'watch_triggers') && tableExists(db, 'alert_plans')) {
    for (const row of db
      .query<{ readonly id: string }, []>(
        'SELECT t.id FROM watch_triggers t LEFT JOIN alert_plans p ON p.id=t.alert_plan_id WHERE p.id IS NULL ORDER BY t.id',
      )
      .all()) {
      alertOrphans.push(`watch_trigger:${row.id}`);
    }
  }
  const alertCounts = {
    stockPools: countRows(db, 'stock_pools'),
    alertPlans: countRows(db, 'alert_plans'),
    enabledStockPools: tableExists(db, 'stock_pools')
      ? (db
          .query<{ readonly count: number }, []>(
            'SELECT count(*) count FROM stock_pools WHERE enabled=1',
          )
          .get()?.count ?? 0)
      : 0,
    enabledAlertPlans: tableExists(db, 'alert_plans')
      ? (db
          .query<{ readonly count: number }, []>(
            'SELECT count(*) count FROM alert_plans WHERE enabled=1',
          )
          .get()?.count ?? 0)
      : 0,
  };
  return {
    schemaVersion: 2,
    legacy,
    watchlist: {
      counts,
      mappings,
      currentMembersByWatchlist,
      memberSetDifferences,
      orphanReferences,
      readyForW4:
        counts.watchlists === legacy.counts.stockGroups &&
        memberSetDifferences.length === 0 &&
        orphanReferences.length === 0,
    },
    alertPlan: {
      counts: alertCounts,
      mappings: alertMappings,
      ruleDifferences,
      orphanReferences: alertOrphans,
      readyForW5:
        alertCounts.stockPools === alertCounts.alertPlans &&
        alertCounts.enabledStockPools === alertCounts.enabledAlertPlans &&
        ruleDifferences.length === 0 &&
        alertOrphans.length === 0,
    },
  };
};

export const verifyStrategyWatchlistDatabase = (
  dbPath: string,
): StrategyWatchlistMigrationVerification => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return verifyStrategyWatchlistMigration(db);
  } finally {
    db.close();
  }
};
