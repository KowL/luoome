import type { Database } from 'bun:sqlite';

import { defineSchemaMigration, resolveLegacyTargetId, type SchemaMigration } from './runner.js';

interface GroupRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly resolver: string;
  readonly enabled: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface SnapshotRow {
  readonly id: string;
  readonly stock_id: string;
  readonly refresh_id: string;
  readonly reason: string;
  readonly score: number | null;
  readonly evidence_json: string;
  readonly data_as_of: number | null;
  readonly created_at: number;
}

const assertWatchlistTables = (db: Database): Record<string, unknown> => {
  const expected = [
    'membership_snapshots',
    'watchlist_member_sources',
    'watchlist_members',
    'watchlist_sync_runs',
    'watchlists',
  ];
  const present = db
    .query<{ readonly name: string }, []>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN
       ('watchlists','watchlist_members','watchlist_member_sources','watchlist_sync_runs','membership_snapshots')
       ORDER BY name`,
    )
    .all()
    .map((row) => row.name);
  if (present.join('\0') !== expected.join('\0')) {
    throw new Error(`Watchlist expand tables 不完整: ${present.join(',')}`);
  }
  return { tables: present };
};

const tacticStrategyMappings = (db: Database): Readonly<Record<string, string>> => {
  const row = db
    .query<{ readonly details_json: string }, []>(
      "SELECT details_json FROM schema_migrations WHERE id = '20260729_02_migrate_tactics'",
    )
    .get();
  if (row === undefined || row === null) return {};
  const details = JSON.parse(row.details_json) as { mappings?: Record<string, string> };
  return details.mappings ?? {};
};

const migrateStockGroups = (db: Database): Record<string, unknown> => {
  const groups = db.query<GroupRow, []>('SELECT * FROM stock_groups ORDER BY id').all();
  const strategyMappings = tacticStrategyMappings(db);
  const occupied = new Set(
    db
      .query<{ readonly id: string }, []>('SELECT id FROM watchlists')
      .all()
      .map((row) => row.id),
  );
  const mappings: Record<string, string> = {};
  const warnings: string[] = [];
  let membersWritten = 0;
  let sourcesWritten = 0;
  let runsWritten = 0;
  let snapshotsWritten = 0;

  const insertWatchlist = db.prepare(`
    INSERT INTO watchlists
      (id,name,description,kind,membership_policy,enabled,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  const insertMember = db.prepare(`
    INSERT OR IGNORE INTO watchlist_members
      (id,watchlist_id,stock_id,stage,priority,first_added_at,last_activity_at,archived_at)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  const insertSource = db.prepare(`
    INSERT OR IGNORE INTO watchlist_member_sources
      (id,member_id,kind,source_key,source_id,source_version_id,sync_run_id,reason,score,rank,status,
       evidence_json,data_as_of,valid_from,valid_until)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const insertRun = db.prepare(`
    INSERT INTO watchlist_sync_runs
      (id,watchlist_id,source_kind,source_key,producer_run_id,status,data_as_of,started_at,finished_at,
       entered_count,exited_count,unchanged_count,missing_dimensions_json,error)
    VALUES (?,?,?,?,?,'complete',?,?,?,?,?,?,? ,NULL)
  `);
  const insertSnapshot = db.prepare(`
    INSERT OR IGNORE INTO membership_snapshots
      (id,sync_run_id,stock_id,selected,change,reason,score,rank,evidence_json,data_as_of)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `);

  for (const group of groups) {
    const resolution = resolveLegacyTargetId({
      legacyId: group.id,
      targetKind: 'watchlist',
      occupiedIds: occupied,
    });
    occupied.add(resolution.targetId);
    mappings[group.id] = resolution.targetId;
    const resolver = JSON.parse(group.resolver) as {
      kind?: string;
      stockIds?: string[];
      accountId?: string;
      tacticId?: string;
    };
    const kind =
      resolver.kind === 'holdings'
        ? 'portfolio'
        : resolver.kind === 'formula'
          ? 'strategy'
          : 'personal';
    const policy =
      resolver.kind === 'manual' ? 'manual' : resolver.kind === 'llm' ? 'mixed' : 'synced';
    insertWatchlist.run(
      resolution.targetId,
      group.name,
      group.description,
      kind,
      policy,
      group.enabled,
      group.created_at,
      group.updated_at,
    );

    const addCurrent = (input: {
      stockId: string;
      stage: 'discovered' | 'watching';
      sourceKind: 'manual' | 'strategy' | 'ai' | 'portfolio';
      sourceKey: string;
      sourceId?: string;
      sourceVersionId?: string;
      syncRunId?: string;
      reason: string;
      score?: number;
      evidence?: readonly string[];
      dataAsOf?: number;
      at: number;
    }): void => {
      const memberId = `${resolution.targetId}:${input.stockId}`;
      const memberResult = insertMember.run(
        memberId,
        resolution.targetId,
        input.stockId,
        input.stage,
        'normal',
        input.at,
        input.at,
        null,
      );
      membersWritten += memberResult.changes;
      const sourceResult = insertSource.run(
        `${input.syncRunId ?? 'migration'}:${memberId}:${input.sourceKey}`,
        memberId,
        input.sourceKind,
        input.sourceKey,
        input.sourceId ?? null,
        input.sourceVersionId ?? null,
        input.syncRunId ?? null,
        input.reason,
        input.score ?? null,
        null,
        'active',
        JSON.stringify(input.evidence ?? []),
        input.dataAsOf ?? null,
        input.at,
        null,
      );
      sourcesWritten += sourceResult.changes;
    };

    if (resolver.kind === 'manual') {
      for (const stockId of [...new Set(resolver.stockIds ?? [])].sort()) {
        const memberId = `${resolution.targetId}:${stockId}`;
        addCurrent({
          stockId,
          stage: 'watching',
          sourceKind: 'manual',
          sourceKey: `manual:${memberId}`,
          reason: '从手工分组迁移',
          at: group.updated_at,
        });
      }
      continue;
    }

    if (resolver.kind === 'holdings') {
      if (resolver.accountId === undefined) {
        warnings.push(`holdings group ${group.id} 缺 accountId`);
        continue;
      }
      const rows = db
        .query<{ readonly stock_id: string; readonly opened_at: number }, [string]>(
          'SELECT stock_id, opened_at FROM holdings WHERE account_id = ? AND closed_at IS NULL ORDER BY stock_id',
        )
        .all(resolver.accountId);
      for (const row of rows) {
        addCurrent({
          stockId: row.stock_id,
          stage: 'discovered',
          sourceKind: 'portfolio',
          sourceKey: `portfolio:${resolver.accountId}`,
          sourceId: resolver.accountId,
          reason: '从当前持仓迁移',
          at: row.opened_at,
        });
      }
      continue;
    }

    if (resolver.kind !== 'formula' && resolver.kind !== 'llm') {
      warnings.push(`group ${group.id} resolver.kind 无法识别: ${String(resolver.kind)}`);
      continue;
    }
    const rows = db
      .query<SnapshotRow, [string]>(
        'SELECT id,stock_id,refresh_id,reason,score,evidence_json,data_as_of,created_at FROM group_member_snapshots WHERE group_id = ? ORDER BY created_at,id',
      )
      .all(group.id);
    const batches = new Map<string, SnapshotRow[]>();
    for (const row of rows) {
      const batch = batches.get(row.refresh_id) ?? [];
      batch.push(row);
      batches.set(row.refresh_id, batch);
    }
    const strategyId =
      resolver.kind === 'formula' && resolver.tacticId !== undefined
        ? (strategyMappings[resolver.tacticId] ?? resolver.tacticId)
        : undefined;
    if (resolver.kind === 'formula' && strategyId === undefined) {
      warnings.push(`formula group ${group.id} 缺 tacticId`);
      continue;
    }
    const sourceKind = resolver.kind === 'formula' ? 'strategy' : 'ai';
    const sourceKey =
      resolver.kind === 'formula' ? `strategy:${strategyId}` : `ai:legacy-group:${group.id}`;
    const sourceVersionId =
      strategyId === undefined
        ? undefined
        : (db
            .query<{ readonly current_version_id: string | null }, [string]>(
              'SELECT current_version_id FROM strategies WHERE id = ?',
            )
            .get(strategyId)?.current_version_id ?? undefined);
    let previous = new Set<string>();
    let latestRows: SnapshotRow[] = [];
    let latestRunId: string | undefined;
    for (const [refreshId, batch] of batches) {
      const runId = `legacy-group-refresh:${group.id}:${refreshId}`;
      const current = new Set(batch.map((row) => row.stock_id));
      const exited = [...previous].filter((stockId) => !current.has(stockId));
      const entered = [...current].filter((stockId) => !previous.has(stockId));
      const unchanged = [...current].filter((stockId) => previous.has(stockId));
      const startedAt = Math.min(...batch.map((row) => row.created_at));
      const finishedAt = Math.max(...batch.map((row) => row.created_at));
      const dataAsOf = Math.max(...batch.map((row) => row.data_as_of ?? row.created_at));
      insertRun.run(
        runId,
        resolution.targetId,
        sourceKind,
        sourceKey,
        refreshId,
        dataAsOf,
        startedAt,
        finishedAt,
        entered.length,
        exited.length,
        unchanged.length,
        '[]',
      );
      runsWritten += 1;
      for (const row of batch) {
        const change = previous.has(row.stock_id) ? 'unchanged' : 'entered';
        insertMember.run(
          `${resolution.targetId}:${row.stock_id}`,
          resolution.targetId,
          row.stock_id,
          'discovered',
          'normal',
          row.created_at,
          row.created_at,
          null,
        );
        insertSnapshot.run(
          `${runId}:${row.stock_id}`,
          runId,
          row.stock_id,
          1,
          change,
          row.reason,
          row.score,
          null,
          row.evidence_json,
          row.data_as_of,
        );
        snapshotsWritten += 1;
      }
      for (const stockId of exited) {
        insertSnapshot.run(
          `${runId}:${stockId}`,
          runId,
          stockId,
          0,
          'exited',
          '旧分组刷新未再入选',
          null,
          null,
          '[]',
          dataAsOf,
        );
        snapshotsWritten += 1;
      }
      previous = current;
      latestRows = batch;
      latestRunId = runId;
    }
    if (latestRunId !== undefined) {
      for (const row of latestRows) {
        addCurrent({
          stockId: row.stock_id,
          stage: 'discovered',
          sourceKind,
          sourceKey,
          ...(strategyId === undefined
            ? { sourceId: `legacy-group:${group.id}` }
            : { sourceId: strategyId }),
          ...(sourceVersionId === undefined ? {} : { sourceVersionId }),
          syncRunId: latestRunId,
          reason: row.reason,
          ...(row.score === null ? {} : { score: row.score }),
          evidence: JSON.parse(row.evidence_json) as string[],
          ...(row.data_as_of === null ? {} : { dataAsOf: row.data_as_of }),
          at: row.created_at,
        });
      }
      const current = new Set(latestRows.map((row) => row.stock_id));
      db.prepare(
        `UPDATE watchlist_members
         SET stage='archived', archived_at=?, last_activity_at=?
         WHERE watchlist_id=? AND stock_id NOT IN (
           SELECT stock_id FROM membership_snapshots WHERE sync_run_id=? AND selected=1
         )`,
      ).run(group.updated_at, group.updated_at, resolution.targetId, latestRunId);
      void current;
    }
  }

  return {
    groupsScanned: groups.length,
    watchlistsWritten: groups.length,
    membersWritten,
    sourcesWritten,
    runsWritten,
    snapshotsWritten,
    mappings,
    warnings,
  };
};

export const WATCHLIST_MIGRATIONS: readonly SchemaMigration[] = [
  defineSchemaMigration({
    id: '20260729_03_watchlist_tables',
    source:
      'ensure watchlists,watchlist_members,watchlist_member_sources,watchlist_sync_runs,membership_snapshots v1',
    up: assertWatchlistTables,
  }),
  defineSchemaMigration({
    id: '20260729_04_migrate_stock_groups',
    source: 'map legacy stock_groups and group_member_snapshots to Watchlist v1',
    up: migrateStockGroups,
  }),
];
