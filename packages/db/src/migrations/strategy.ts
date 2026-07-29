import type { Database } from 'bun:sqlite';
import {
  mapLegacyTacticSignal,
  mapLegacyTacticToStrategy,
  type Tactic,
  type TacticSignal,
} from '@luoome/core';
import { ALERT_PLAN_MIGRATIONS } from './alert-plan.js';
import { defineSchemaMigration, resolveLegacyTargetId, type SchemaMigration } from './runner.js';
import { WATCHLIST_MIGRATIONS } from './watchlist.js';

interface TacticRow {
  readonly id: string;
  readonly name: string;
  readonly tag: Tactic['tag'];
  readonly description: string;
  readonly trigger_when: string;
  readonly score_expression: string;
  readonly direction: Tactic['direction'];
  readonly evidence_template: string;
  readonly source: Tactic['source'];
  readonly defined_at: number;
}

interface TacticSignalRow {
  readonly id: string;
  readonly tactic_id: string;
  readonly tactic_name: string;
  readonly tactic_tag: Tactic['tag'];
  readonly stock_id: string;
  readonly ts: number;
  readonly score: number;
  readonly direction: Tactic['direction'];
  readonly evidence: string;
  readonly trigger_snapshot: string | null;
}

const readTactic = (row: TacticRow): Tactic => ({
  id: row.id,
  name: row.name,
  tag: row.tag,
  description: row.description,
  triggerWhen: row.trigger_when,
  scoreExpression: row.score_expression,
  direction: row.direction,
  evidenceTemplate: JSON.parse(row.evidence_template) as string[],
  source: row.source,
  definedAt: new Date(row.defined_at),
});

const readSignal = (row: TacticSignalRow): TacticSignal => ({
  tacticId: row.tactic_id,
  tacticName: row.tactic_name,
  tacticTag: row.tactic_tag,
  stockId: row.stock_id,
  ts: new Date(row.ts),
  score: row.score,
  direction: row.direction,
  evidence: JSON.parse(row.evidence) as readonly string[],
  ...(row.trigger_snapshot === null
    ? {}
    : {
        triggerSnapshot: JSON.parse(row.trigger_snapshot) as {
          readonly expression: string;
          readonly result: boolean;
        },
      }),
});

const assertStrategyTables = (db: Database): Record<string, unknown> => {
  const expected = [
    'strategies',
    'strategy_versions',
    'strategy_runs',
    'strategy_results',
    'strategy_signals',
  ];
  const present = db
    .query<{ readonly name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN
       ('strategies','strategy_versions','strategy_runs','strategy_results','strategy_signals')
       ORDER BY name`,
    )
    .all()
    .map((row) => row.name);
  if (present.length !== expected.length) {
    throw new Error(`Strategy expand tables 不完整: ${present.join(',')}`);
  }
  return { tables: present };
};

const migrateTactics = (db: Database): Record<string, unknown> => {
  const tactics = db.query<TacticRow, []>('SELECT * FROM tactics ORDER BY id').all();
  const occupied = new Set(
    db
      .query<{ readonly id: string }, []>('SELECT id FROM strategies')
      .all()
      .map((row) => row.id),
  );
  const mappings: Record<string, string> = {};
  let strategiesWritten = 0;
  let signalsWritten = 0;
  let signalMerges = 0;
  let idConflicts = 0;

  const insertStrategy = db.prepare(`
    INSERT INTO strategies
      (id, name, description, owner, status, current_version_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertVersion = db.prepare(`
    INSERT INTO strategy_versions
      (id, strategy_id, version, definition_json, definition_hash, parent_version_id,
       change_summary, validation_status, validation_errors_json, published_at, created_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
  `);
  const insertRun = db.prepare(`
    INSERT INTO strategy_runs
      (id, strategy_id, strategy_version_id, mode, coverage, data_as_of, started_at, finished_at,
       status, input_snapshot_json, provider_statuses_json, summary_json, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `);
  const insertSignal = db.prepare(`
    INSERT OR IGNORE INTO strategy_signals
      (id, strategy_id, strategy_version_id, run_id, rule_id, stock_id, ts, score, direction,
       evidence_json, evaluation_snapshot_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const row of tactics) {
    const resolution = resolveLegacyTargetId({
      legacyId: row.id,
      targetKind: 'strategy',
      occupiedIds: occupied,
    });
    occupied.add(resolution.targetId);
    mappings[row.id] = resolution.targetId;
    if (resolution.conflict) idConflicts += 1;

    const signalRows = db
      .query<TacticSignalRow, [string]>(
        'SELECT * FROM tactic_signals WHERE tactic_id = ? ORDER BY id',
      )
      .all(row.id);
    const bundle = mapLegacyTacticToStrategy(
      readTactic(row),
      resolution.targetId,
      signalRows.length,
    );
    const latestTs = signalRows.reduce(
      (latest, signal) => Math.max(latest, signal.ts),
      bundle.run.finishedAt?.getTime() ?? bundle.run.startedAt.getTime(),
    );
    const run = {
      ...bundle.run,
      dataAsOf: new Date(latestTs),
      finishedAt: new Date(latestTs),
    };

    insertStrategy.run(
      bundle.strategy.id,
      bundle.strategy.name,
      bundle.strategy.description,
      bundle.strategy.owner,
      bundle.strategy.status,
      bundle.strategy.currentVersionId ?? null,
      bundle.strategy.createdAt.getTime(),
      bundle.strategy.updatedAt.getTime(),
    );
    insertVersion.run(
      bundle.version.id,
      bundle.version.strategyId,
      bundle.version.version,
      JSON.stringify(bundle.version.definition),
      bundle.version.definitionHash,
      bundle.version.changeSummary ?? null,
      bundle.version.validationStatus,
      JSON.stringify(bundle.version.validationErrors),
      bundle.version.publishedAt?.getTime() ?? null,
      bundle.version.createdAt.getTime(),
    );
    insertRun.run(
      run.id,
      run.strategyId,
      run.strategyVersionId,
      run.mode,
      run.coverage,
      run.dataAsOf.getTime(),
      run.startedAt.getTime(),
      run.finishedAt?.getTime() ?? null,
      run.status,
      JSON.stringify(run.inputSnapshot),
      JSON.stringify(run.providerStatuses),
      JSON.stringify(run.summary ?? {}),
    );
    strategiesWritten += 1;

    for (const signalRow of signalRows) {
      const signal = mapLegacyTacticSignal(readSignal(signalRow), {
        id: signalRow.id,
        strategyId: bundle.strategy.id,
        strategyVersionId: bundle.version.id,
        runId: run.id,
      });
      const result = insertSignal.run(
        signal.id,
        signal.strategyId,
        signal.strategyVersionId,
        signal.runId,
        signal.ruleId,
        signal.stockId,
        signal.ts.getTime(),
        signal.score,
        signal.direction,
        JSON.stringify(signal.evidence),
        JSON.stringify(signal.evaluationSnapshot),
      );
      if (result.changes === 0) signalMerges += 1;
      else signalsWritten += 1;
    }
  }

  return {
    tacticsScanned: tactics.length,
    strategiesWritten,
    signalsScanned: db
      .query<{ readonly count: number }, []>('SELECT count(*) AS count FROM tactic_signals')
      .get()?.count,
    signalsWritten,
    signalMerges,
    idConflicts,
    mappings,
  };
};

export const STRATEGY_MIGRATIONS: readonly SchemaMigration[] = [
  defineSchemaMigration({
    id: '20260729_01_strategy_tables',
    source:
      'ensure strategies,strategy_versions,strategy_runs,strategy_results,strategy_signals v1',
    up: assertStrategyTables,
  }),
  defineSchemaMigration({
    id: '20260729_02_migrate_tactics',
    source: 'map legacy tactics and tactic_signals to Strategy v1 legacy-signal schema',
    up: migrateTactics,
  }),
  ...WATCHLIST_MIGRATIONS,
  ...ALERT_PLAN_MIGRATIONS,
];
