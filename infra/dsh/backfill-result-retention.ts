// 一次性维护脚本：把存量 StrategyRun 的逐股结果按保留策略收敛。
//
// - 保留入选 / 规则近似 / 排名近似行，删除其余逐股事实；
// - 在 run summary 写入 persistedResultCount、分类计数与 droppedStockIds，
//   保证诊断计数与“裁剪 vs 缺失”的区分在存量运行上同样成立；
// - 默认 dry-run，只有显式 --apply 才写入并删除。
import { DatabaseSync } from 'node:sqlite';

import type { StrategyDslV1, StrategyResult } from '@luoome/core';
import { retainStrategyResults } from './internal/strategy-result-retention.js';

const dbPath = process.argv[2];
const apply = process.argv.includes('--apply');
if (!dbPath) throw new Error('usage: backfill-result-retention.mjs <db> [--apply]');

const db = new DatabaseSync(dbPath);
const rows = (sql: string, ...params: unknown[]) => db.prepare(sql).all(...params);

const runs = rows(
  'select id, strategy_id, strategy_version_id, summary_json, status, scope from strategy_runs',
) as {
  id: string;
  strategy_id: string;
  strategy_version_id: string;
  summary_json: string | null;
  status: string;
  scope: string;
}[];

const definitions = new Map<string, StrategyDslV1>();
const loadDefinition = (versionId: string): StrategyDslV1 => {
  const cached = definitions.get(versionId);
  if (cached !== undefined) return cached;
  const row = rows('select definition_json from strategy_versions where id = ?', versionId)[0] as
    | { definition_json: string }
    | undefined;
  if (row === undefined) throw new Error(`missing strategy version ${versionId}`);
  const definition = JSON.parse(row.definition_json) as StrategyDslV1;
  definitions.set(versionId, definition);
  return definition;
};

const resultRows = db.prepare(
  'select run_id, stock_id, selected, score, rank, rule_evaluations_json, evidence_json, data_as_of from strategy_results where run_id = ?',
);
const deleteResult = db.prepare('delete from strategy_results where run_id = ? and stock_id = ?');
const updateSummary = db.prepare('update strategy_runs set summary_json = ? where id = ?');

let totalBefore = 0;
let totalAfter = 0;
const changed: { id: string; before: number; after: number }[] = [];
const totals = { selected: 0, ruleNearMiss: 0, rankingNearMiss: 0, excluded: 0, incomplete: 0 };

db.exec('begin');
try {
  for (const run of runs) {
    const definition = loadDefinition(run.strategy_version_id);
    const stored = resultRows.all(run.id) as {
      run_id: string;
      stock_id: string;
      selected: number;
      score: number | null;
      rank: number | null;
      rule_evaluations_json: string;
      evidence_json: string;
      data_as_of: number;
    }[];
    totalBefore += stored.length;
    const parsedResults: StrategyResult[] = [];
    const kept: string[] = [];
    const dropped: string[] = [];
    for (const row of stored) {
      const parsed = JSON.parse(row.rule_evaluations_json) as
        | unknown[]
        | { ruleEvaluations: unknown[] };
      const result = {
        runId: row.run_id,
        stockId: row.stock_id,
        selected: row.selected === 1,
        ...(row.score === null ? {} : { score: row.score }),
        ...(row.rank === null ? {} : { rank: row.rank }),
        ruleEvaluations: Array.isArray(parsed) ? parsed : parsed.ruleEvaluations,
        evidence: JSON.parse(row.evidence_json) as unknown[],
        dataAsOf: new Date(row.data_as_of),
      } as unknown as StrategyResult;
      parsedResults.push(result);
    }
    const retention = retainStrategyResults(definition, parsedResults);
    const keptIds = new Set(retention.results.map((row) => row.stockId));
    for (const row of stored) {
      if (keptIds.has(row.stock_id)) kept.push(row.stock_id);
      else dropped.push(row.stock_id);
    }
    const counts = {
      selected: retention.results.filter((row) => row.selected).length,
      ruleNearMiss: retention.counts.ruleNearMissCount,
      rankingNearMiss: retention.counts.rankingNearMissCount,
      excluded: retention.counts.excludedCount,
      incomplete: retention.counts.incompleteCount,
    };
    totalAfter += kept.length;
    totals.selected += counts.selected;
    totals.ruleNearMiss += counts.ruleNearMiss;
    totals.rankingNearMiss += counts.rankingNearMiss;
    totals.excluded += counts.excluded;
    totals.incomplete += counts.incomplete;
    if (dropped.length === 0) continue;
    changed.push({ id: run.id, before: stored.length, after: kept.length });
    if (!apply) continue;
    const summary = run.summary_json === null ? null : (JSON.parse(run.summary_json) as object);
    if (summary !== null) {
      const next = {
        ...summary,
        persistedResultCount: kept.length,
        ruleNearMissCount: counts.ruleNearMiss,
        rankingNearMissCount: counts.rankingNearMiss,
        excludedCount: counts.excluded,
        droppedStockIds: dropped,
      };
      updateSummary.run(JSON.stringify(next), run.id);
    }
    for (const stockId of dropped) deleteResult.run(run.id, stockId);
  }
  db.exec(apply ? 'commit' : 'rollback');
} catch (error) {
  db.exec('rollback');
  throw error;
}
db.close();
console.log(
  JSON.stringify(
    {
      apply,
      runs: runs.length,
      changedRuns: changed.length,
      rowsBefore: totalBefore,
      rowsAfter: totalAfter,
      droppedRows: totalBefore - totalAfter,
      totals,
      sample: changed.slice(0, 5),
    },
    null,
    2,
  ),
);
