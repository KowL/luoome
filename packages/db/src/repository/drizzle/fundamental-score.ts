import {
  type FundamentalScoreResult,
  type FundamentalScoreRun,
  type FundamentalScoreRunRepository,
  type FundamentalScoreVersion,
  type FundamentalScoreVersionRepository,
  InvariantError,
} from '@luoome/core';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import type { DrizzleDb } from '../../client.js';
import {
  fundamentalScoreResults,
  fundamentalScoreRuns,
  fundamentalScoreVersions,
  type Schema,
} from '../../schema/index.js';
import {
  assertRunForCommit,
  assertRunIdentity,
  assertVersionSaveTransition,
  canonicalJson,
  compareResults,
  parseResult,
  parseRun,
  parseVersion,
  resultJson,
  runJson,
} from '../fundamental-score.js';

type VersionRow = typeof fundamentalScoreVersions.$inferSelect;
type RunRow = typeof fundamentalScoreRuns.$inferSelect;
type ResultRow = typeof fundamentalScoreResults.$inferSelect;
type DrizzleTransaction = Parameters<Parameters<BunSQLiteDatabase<Schema>['transaction']>[0]>[0];

const versionFromRow = (row: VersionRow): FundamentalScoreVersion =>
  parseVersion({
    id: row.id,
    version: row.version,
    registryVersion: row.registryVersion,
    registryHash: row.registryHash,
    normalizationVersion:
      row.normalizationVersion as FundamentalScoreVersion['normalizationVersion'],
    components: row.components,
    missingPolicy: row.missingPolicy as FundamentalScoreVersion['missingPolicy'],
    rounding: row.rounding as FundamentalScoreVersion['rounding'],
    definitionHash: row.definitionHash,
    status: row.status,
    createdAt: row.createdAt,
    ...(row.publishedAt === null ? {} : { publishedAt: row.publishedAt }),
  });

const runFromRow = (row: RunRow): FundamentalScoreRun =>
  parseRun({
    id: row.id,
    scoreVersionId: row.scoreVersionId,
    scoreVersionHash: row.scoreVersionHash,
    registryHash: row.registryHash,
    universeSyncId: row.universeSyncId,
    universeMemberChecksum: row.universeMemberChecksum,
    asOf: row.asOf,
    financialVintageKey: row.financialVintageKey,
    normalizerDenominatorHash: row.normalizerDenominatorHash,
    counts: row.counts,
    providerStatus: row.providerStatus,
    evaluatorCodeIdentity: row.evaluatorCodeIdentity,
    status: row.status,
    createdAt: row.createdAt,
    ...(row.committedAt === null ? {} : { committedAt: row.committedAt }),
    ...(row.terminalReason === null ? {} : { terminalReason: row.terminalReason }),
  });

const resultFromRow = (row: ResultRow): FundamentalScoreResult =>
  parseResult({
    scoreRunId: row.scoreRunId,
    stockId: row.stockId,
    status: row.status,
    ...(row.score === null ? {} : { score: row.score }),
    ...(row.rank === null ? {} : { rank: row.rank }),
    components: row.components,
    dataAsOf: row.dataAsOf,
    vintageKey: row.vintageKey,
  });

const versionInsert = (version: FundamentalScoreVersion) => ({
  id: version.id,
  version: version.version,
  registryVersion: version.registryVersion,
  registryHash: version.registryHash,
  normalizationVersion: version.normalizationVersion,
  components: version.components,
  missingPolicy: version.missingPolicy,
  rounding: version.rounding,
  definitionHash: version.definitionHash,
  status: version.status,
  createdAt: version.createdAt,
  publishedAt: version.publishedAt ?? null,
});

const runInsert = (run: FundamentalScoreRun) => ({
  id: run.id,
  scoreVersionId: run.scoreVersionId,
  scoreVersionHash: run.scoreVersionHash,
  registryHash: run.registryHash,
  universeSyncId: run.universeSyncId,
  universeMemberChecksum: run.universeMemberChecksum,
  asOf: run.asOf,
  financialVintageKey: run.financialVintageKey,
  normalizerDenominatorHash: run.normalizerDenominatorHash,
  counts: run.counts,
  providerStatus: run.providerStatus,
  evaluatorCodeIdentity: run.evaluatorCodeIdentity,
  status: run.status,
  createdAt: run.createdAt,
  committedAt: run.committedAt ?? null,
  terminalReason: run.terminalReason ?? null,
});

const resultInsert = (result: FundamentalScoreResult) => ({
  scoreRunId: result.scoreRunId,
  stockId: result.stockId,
  status: result.status,
  score: result.score ?? null,
  rank: result.rank ?? null,
  components: result.components,
  dataAsOf: result.dataAsOf,
  vintageKey: result.vintageKey,
});

const sortedResults = (results: readonly FundamentalScoreResult[]): FundamentalScoreResult[] =>
  [...results].sort(compareResults);

const sameResults = (
  left: readonly FundamentalScoreResult[],
  right: readonly FundamentalScoreResult[],
): boolean => {
  const a = sortedResults(left);
  const b = sortedResults(right);
  return (
    a.length === b.length &&
    a.every((result, index) => {
      const other = b[index];
      return other !== undefined && resultJson(result) === resultJson(other);
    })
  );
};

const listResultRows = (db: DrizzleDb | DrizzleTransaction, runId: string): ResultRow[] =>
  db
    .select()
    .from(fundamentalScoreResults)
    .where(eq(fundamentalScoreResults.scoreRunId, runId))
    .all();

/** Immutable definition repository backed by SQLite. */
export class DrizzleFundamentalScoreVersionRepository implements FundamentalScoreVersionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async save(version: FundamentalScoreVersion): Promise<void> {
    const parsed = parseVersion(version);
    this.db.transaction((tx) => {
      const existingRow = tx
        .select()
        .from(fundamentalScoreVersions)
        .where(eq(fundamentalScoreVersions.id, parsed.id))
        .get();
      if (existingRow === undefined) {
        const hashOwner = tx
          .select({ id: fundamentalScoreVersions.id })
          .from(fundamentalScoreVersions)
          .where(eq(fundamentalScoreVersions.definitionHash, parsed.definitionHash))
          .get();
        if (hashOwner !== undefined && hashOwner.id !== parsed.id) {
          throw new InvariantError(
            `FundamentalScoreVersion.definitionHash 已被其他 id 使用: ${parsed.definitionHash}`,
          );
        }
        tx.insert(fundamentalScoreVersions).values(versionInsert(parsed)).run();
        return;
      }
      const existing = versionFromRow(existingRow);
      assertVersionSaveTransition(existing, parsed);
      if (canonicalJson(existing) === canonicalJson(parsed)) return;
      tx.update(fundamentalScoreVersions)
        .set({ status: parsed.status, publishedAt: parsed.publishedAt ?? null })
        .where(eq(fundamentalScoreVersions.id, parsed.id))
        .run();
    });
  }

  async findById(id: string): Promise<FundamentalScoreVersion | null> {
    const row = this.db
      .select()
      .from(fundamentalScoreVersions)
      .where(eq(fundamentalScoreVersions.id, id))
      .get();
    return row === undefined ? null : versionFromRow(row);
  }

  async list(
    input: { readonly status?: FundamentalScoreVersion['status'] } = {},
  ): Promise<readonly FundamentalScoreVersion[]> {
    const rows = this.db
      .select()
      .from(fundamentalScoreVersions)
      .where(
        input.status === undefined ? undefined : eq(fundamentalScoreVersions.status, input.status),
      )
      .orderBy(asc(fundamentalScoreVersions.version), asc(fundamentalScoreVersions.id))
      .all();
    return rows.map(versionFromRow);
  }
}

/** Score run + result repository. Results are inserted only in the commit transaction. */
export class DrizzleFundamentalScoreRunRepository implements FundamentalScoreRunRepository {
  constructor(private readonly db: DrizzleDb) {}

  async saveStarted(run: FundamentalScoreRun): Promise<void> {
    const parsed = parseRun(run);
    if (parsed.status !== 'started') {
      throw new InvariantError(`saveStarted 只接受 started FundamentalScoreRun: ${parsed.id}`);
    }
    if (parsed.committedAt !== undefined) {
      throw new InvariantError(`started FundamentalScoreRun 不应有 committedAt: ${parsed.id}`);
    }
    this.db.transaction((tx) => {
      const existingRow = tx
        .select()
        .from(fundamentalScoreRuns)
        .where(eq(fundamentalScoreRuns.id, parsed.id))
        .get();
      if (existingRow === undefined) {
        tx.insert(fundamentalScoreRuns).values(runInsert(parsed)).run();
        return;
      }
      const existing = runFromRow(existingRow);
      if (runJson(existing) !== runJson(parsed)) {
        throw new InvariantError(`FundamentalScoreRun identity 冲突且不得覆盖: ${parsed.id}`);
      }
    });
  }

  async commit(input: {
    readonly run: FundamentalScoreRun;
    readonly results: readonly FundamentalScoreResult[];
  }): Promise<void> {
    const run = parseRun(input.run);
    const results = input.results.map(parseResult);
    assertRunForCommit(run, results);
    this.db.transaction((tx) => {
      const existingRow = tx
        .select()
        .from(fundamentalScoreRuns)
        .where(eq(fundamentalScoreRuns.id, run.id))
        .get();
      if (existingRow === undefined) {
        throw new InvariantError(`FundamentalScoreRun 未先 saveStarted: ${run.id}`);
      }
      const existing = runFromRow(existingRow);
      if (existing.status !== 'started') {
        const oldResults = listResultRows(tx, run.id).map(resultFromRow);
        if (runJson(existing) === runJson(run) && sameResults(oldResults, results)) return;
        throw new InvariantError(`FundamentalScoreRun 已进入终态且不得重复提交: ${run.id}`);
      }
      assertRunIdentity(existing, run);
      tx.delete(fundamentalScoreResults)
        .where(eq(fundamentalScoreResults.scoreRunId, run.id))
        .run();
      if (run.status === 'committed' && results.length > 0) {
        tx.insert(fundamentalScoreResults).values(sortedResults(results).map(resultInsert)).run();
      }
      tx.update(fundamentalScoreRuns)
        .set({
          status: run.status,
          committedAt: run.committedAt ?? null,
          terminalReason: run.terminalReason ?? null,
        })
        .where(eq(fundamentalScoreRuns.id, run.id))
        .run();
    });
  }

  async findById(id: string): Promise<FundamentalScoreRun | null> {
    const row = this.db
      .select()
      .from(fundamentalScoreRuns)
      .where(eq(fundamentalScoreRuns.id, id))
      .get();
    return row === undefined ? null : runFromRow(row);
  }

  async list(
    input: {
      readonly scoreVersionId?: string;
      readonly status?: FundamentalScoreRun['status'];
      readonly asOf?: Date;
      readonly limit?: number;
    } = {},
  ): Promise<readonly FundamentalScoreRun[]> {
    const conditions = [];
    if (input.scoreVersionId !== undefined) {
      conditions.push(eq(fundamentalScoreRuns.scoreVersionId, input.scoreVersionId));
    }
    if (input.status !== undefined) {
      conditions.push(eq(fundamentalScoreRuns.status, input.status));
    }
    if (input.asOf !== undefined) {
      conditions.push(eq(fundamentalScoreRuns.asOf, input.asOf));
    }
    const rows = this.db
      .select()
      .from(fundamentalScoreRuns)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(fundamentalScoreRuns.createdAt), desc(fundamentalScoreRuns.id))
      .all();
    const limited = input.limit === undefined ? rows : rows.slice(0, Math.max(0, input.limit));
    return limited.map(runFromRow);
  }

  async listResults(runId: string): Promise<readonly FundamentalScoreResult[]> {
    const run = await this.findById(runId);
    if (run === null || run.status !== 'committed') return [];
    return sortedResults(
      this.db
        .select()
        .from(fundamentalScoreResults)
        .where(eq(fundamentalScoreResults.scoreRunId, runId))
        .all()
        .map(resultFromRow),
    );
  }
}
