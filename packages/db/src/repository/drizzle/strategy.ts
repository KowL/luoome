import {
  assertStrategyInvariants,
  assertStrategyRunInvariants,
  assertStrategyVersionInvariants,
  InvariantError,
  type Strategy,
  type StrategyRepository,
  type StrategyResult,
  StrategyResultSchema,
  type StrategyRun,
  type StrategyRunRepository,
  type StrategySignal,
  StrategySignalSchema,
  type StrategyVersion,
} from '@luoome/core';
import { and, asc, desc, eq, gte, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import {
  type Schema,
  strategies,
  strategyResults,
  strategyRuns,
  strategySignals,
  strategyVersions,
} from '../../schema/index.js';

type StrategyRow = typeof strategies.$inferSelect;
type VersionRow = typeof strategyVersions.$inferSelect;
type RunRow = typeof strategyRuns.$inferSelect;
type ResultRow = typeof strategyResults.$inferSelect;
type SignalRow = typeof strategySignals.$inferSelect;

const toStrategy = (row: StrategyRow): Strategy => ({
  id: row.id,
  name: row.name,
  description: row.description,
  owner: row.owner,
  status: row.status,
  ...(row.currentVersionId === null ? {} : { currentVersionId: row.currentVersionId }),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toVersion = (row: VersionRow): StrategyVersion => ({
  id: row.id,
  strategyId: row.strategyId,
  version: row.version,
  definition: row.definition,
  definitionHash: row.definitionHash,
  ...(row.parentVersionId === null ? {} : { parentVersionId: row.parentVersionId }),
  ...(row.changeSummary === null ? {} : { changeSummary: row.changeSummary }),
  validationStatus: row.validationStatus,
  validationErrors: [...row.validationErrors],
  ...(row.publishedAt === null ? {} : { publishedAt: row.publishedAt }),
  createdAt: row.createdAt,
});

const toRun = (row: RunRow): StrategyRun => ({
  id: row.id,
  strategyId: row.strategyId,
  strategyVersionId: row.strategyVersionId,
  mode: row.mode,
  coverage: row.coverage,
  dataAsOf: row.dataAsOf,
  startedAt: row.startedAt,
  ...(row.finishedAt === null ? {} : { finishedAt: row.finishedAt }),
  status: row.status,
  inputSnapshot: row.inputSnapshot,
  providerStatuses: [...row.providerStatuses],
  ...(row.summary === null ? {} : { summary: row.summary }),
  ...(row.error === null ? {} : { error: row.error }),
});

const toResult = (row: ResultRow): StrategyResult => ({
  runId: row.runId,
  stockId: row.stockId,
  selected: row.selected,
  ...(row.score === null ? {} : { score: row.score }),
  ...(row.rank === null ? {} : { rank: row.rank }),
  ruleEvaluations: [...row.ruleEvaluations],
  evidence: [...row.evidence],
  dataAsOf: row.dataAsOf,
});

const toSignal = (row: SignalRow): StrategySignal => ({
  id: row.id,
  strategyId: row.strategyId,
  strategyVersionId: row.strategyVersionId,
  runId: row.runId,
  ruleId: row.ruleId,
  stockId: row.stockId,
  ts: row.ts,
  score: row.score,
  direction: row.direction,
  evidence: [...row.evidence],
  evaluationSnapshot: row.evaluationSnapshot,
});

export class DrizzleStrategyRepository implements StrategyRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(strategy: Strategy): Promise<void> {
    assertStrategyInvariants(strategy);
    this.db
      .insert(strategies)
      .values({
        id: strategy.id,
        name: strategy.name,
        description: strategy.description,
        owner: strategy.owner,
        status: strategy.status,
        currentVersionId: strategy.currentVersionId ?? null,
        createdAt: strategy.createdAt,
        updatedAt: strategy.updatedAt,
      })
      .onConflictDoUpdate({
        target: strategies.id,
        set: {
          name: strategy.name,
          description: strategy.description,
          status: strategy.status,
          currentVersionId: strategy.currentVersionId ?? null,
          updatedAt: strategy.updatedAt,
        },
      })
      .run();
  }

  async findById(id: string): Promise<Strategy | null> {
    const row = this.db.select().from(strategies).where(eq(strategies.id, id)).get();
    return row === undefined ? null : toStrategy(row);
  }

  async list(
    filter: { readonly status?: Strategy['status']; readonly owner?: Strategy['owner'] } = {},
  ): Promise<readonly Strategy[]> {
    const conditions = [];
    if (filter.status !== undefined) conditions.push(eq(strategies.status, filter.status));
    if (filter.owner !== undefined) conditions.push(eq(strategies.owner, filter.owner));
    return this.db
      .select()
      .from(strategies)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(asc(strategies.id))
      .all()
      .map(toStrategy);
  }

  async saveVersion(version: StrategyVersion): Promise<void> {
    const strategy = await this.findById(version.strategyId);
    if (strategy === null) throw new InvariantError(`Strategy 不存在: ${version.strategyId}`);
    assertStrategyVersionInvariants(version, strategy.owner);
    if (version.parentVersionId !== undefined) {
      const parent = await this.findVersionById(version.parentVersionId);
      if (parent === null || parent.strategyId !== version.strategyId) {
        throw new InvariantError('parentVersionId 必须指向同一 Strategy');
      }
    }
    const existing = await this.findVersionById(version.id);
    const versions = await this.listVersions(version.strategyId);
    // 预检唯一索引 strategy_versions_strategy_version_unique，避免泄漏 SQLite 错误（与 memory 对齐）。
    const sameNumber = versions.find(
      (candidate) => candidate.version === version.version && candidate.id !== version.id,
    );
    if (sameNumber !== undefined) throw new InvariantError('(strategyId, version) 必须唯一');
    const maxVersion = versions.at(-1)?.version ?? 0;
    if (existing === null && version.version <= maxVersion) {
      throw new InvariantError('新 StrategyVersion.version 必须严格递增');
    }
    if (existing?.publishedAt !== undefined && existing.definitionHash !== version.definitionHash) {
      throw new InvariantError('published StrategyVersion 的 definition 不可修改');
    }
    this.db
      .insert(strategyVersions)
      .values({
        id: version.id,
        strategyId: version.strategyId,
        version: version.version,
        definition: version.definition,
        definitionHash: version.definitionHash,
        parentVersionId: version.parentVersionId ?? null,
        changeSummary: version.changeSummary ?? null,
        validationStatus: version.validationStatus,
        validationErrors: [...version.validationErrors],
        publishedAt: version.publishedAt ?? null,
        createdAt: version.createdAt,
      })
      .onConflictDoUpdate({
        target: strategyVersions.id,
        set: {
          definition: version.definition,
          definitionHash: version.definitionHash,
          parentVersionId: version.parentVersionId ?? null,
          changeSummary: version.changeSummary ?? null,
          validationStatus: version.validationStatus,
          validationErrors: [...version.validationErrors],
          publishedAt: version.publishedAt ?? null,
        },
      })
      .run();
  }

  async findVersionById(id: string): Promise<StrategyVersion | null> {
    const row = this.db.select().from(strategyVersions).where(eq(strategyVersions.id, id)).get();
    return row === undefined ? null : toVersion(row);
  }

  async listVersions(strategyId: string): Promise<readonly StrategyVersion[]> {
    return this.db
      .select()
      .from(strategyVersions)
      .where(eq(strategyVersions.strategyId, strategyId))
      .orderBy(asc(strategyVersions.version))
      .all()
      .map(toVersion);
  }

  async activateVersion(strategyId: string, versionId: string, at: Date): Promise<void> {
    this.db.transaction((tx) => {
      const strategy = tx.select().from(strategies).where(eq(strategies.id, strategyId)).get();
      if (strategy === undefined) throw new InvariantError(`Strategy 不存在: ${strategyId}`);
      const version = tx
        .select()
        .from(strategyVersions)
        .where(eq(strategyVersions.id, versionId))
        .get();
      if (
        version === undefined ||
        version.strategyId !== strategyId ||
        version.validationStatus !== 'valid' ||
        version.publishedAt === null
      ) {
        throw new InvariantError('只能激活同一 Strategy 下已发布且 valid 的 version');
      }
      tx.update(strategies)
        .set({ currentVersionId: versionId, status: 'active', updatedAt: at })
        .where(eq(strategies.id, strategyId))
        .run();
    });
  }

  async publishVersion(strategyId: string, versionId: string, at: Date): Promise<void> {
    this.db.transaction((tx) => {
      const strategy = tx.select().from(strategies).where(eq(strategies.id, strategyId)).get();
      if (strategy === undefined) throw new InvariantError(`Strategy 不存在: ${strategyId}`);
      const version = tx
        .select()
        .from(strategyVersions)
        .where(eq(strategyVersions.id, versionId))
        .get();
      if (
        version === undefined ||
        version.strategyId !== strategyId ||
        version.validationStatus !== 'valid'
      ) {
        throw new InvariantError('只能发布同一 Strategy 下 valid 的 version');
      }
      tx.update(strategyVersions)
        .set({ publishedAt: version.publishedAt ?? at })
        .where(eq(strategyVersions.id, versionId))
        .run();
      tx.update(strategies)
        .set({ currentVersionId: versionId, status: 'active', updatedAt: at })
        .where(eq(strategies.id, strategyId))
        .run();
    });
  }
}

export class DrizzleStrategyRunRepository implements StrategyRunRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async saveRun(run: StrategyRun): Promise<void> {
    assertStrategyRunInvariants(run);
    this.assertRunnableVersion(run.strategyId, run.strategyVersionId);
    this.db
      .insert(strategyRuns)
      .values({
        id: run.id,
        strategyId: run.strategyId,
        strategyVersionId: run.strategyVersionId,
        mode: run.mode,
        coverage: run.coverage,
        dataAsOf: run.dataAsOf,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt ?? null,
        status: run.status,
        inputSnapshot: run.inputSnapshot,
        providerStatuses: [...run.providerStatuses],
        summary: run.summary ?? null,
        error: run.error ?? null,
      })
      .onConflictDoUpdate({
        target: strategyRuns.id,
        set: {
          dataAsOf: run.dataAsOf,
          finishedAt: run.finishedAt ?? null,
          status: run.status,
          providerStatuses: [...run.providerStatuses],
          summary: run.summary ?? null,
          error: run.error ?? null,
        },
      })
      .run();
  }

  async findRunById(id: string): Promise<StrategyRun | null> {
    const row = this.db.select().from(strategyRuns).where(eq(strategyRuns.id, id)).get();
    return row === undefined ? null : toRun(row);
  }

  async listRuns(
    filter: {
      readonly strategyId?: string;
      readonly status?: StrategyRun['status'];
      readonly since?: Date;
      readonly limit?: number;
    } = {},
  ): Promise<readonly StrategyRun[]> {
    const conditions = [];
    if (filter.strategyId !== undefined) {
      conditions.push(eq(strategyRuns.strategyId, filter.strategyId));
    }
    if (filter.status !== undefined) conditions.push(eq(strategyRuns.status, filter.status));
    if (filter.since !== undefined) conditions.push(gte(strategyRuns.startedAt, filter.since));
    const query = this.db
      .select()
      .from(strategyRuns)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(strategyRuns.startedAt), desc(strategyRuns.id));
    const rows = filter.limit === undefined ? query.all() : query.limit(filter.limit).all();
    return rows.map(toRun);
  }

  async saveResults(results: readonly StrategyResult[]): Promise<void> {
    if (results.length === 0) return;
    for (const result of results) StrategyResultSchema.parse(result);
    for (const result of results) {
      if ((await this.findRunById(result.runId)) === null) {
        throw new InvariantError(`StrategyRun 不存在: ${result.runId}`);
      }
      this.db
        .insert(strategyResults)
        .values({
          runId: result.runId,
          stockId: result.stockId,
          selected: result.selected,
          score: result.score ?? null,
          rank: result.rank ?? null,
          ruleEvaluations: [...result.ruleEvaluations],
          evidence: [...result.evidence],
          dataAsOf: result.dataAsOf,
        })
        .onConflictDoUpdate({
          target: [strategyResults.runId, strategyResults.stockId],
          set: {
            selected: result.selected,
            score: result.score ?? null,
            rank: result.rank ?? null,
            ruleEvaluations: [...result.ruleEvaluations],
            evidence: [...result.evidence],
            dataAsOf: result.dataAsOf,
          },
        })
        .run();
    }
  }

  async listResults(runId: string): Promise<readonly StrategyResult[]> {
    return (
      this.db
        .select()
        .from(strategyResults)
        .where(eq(strategyResults.runId, runId))
        // rank 为 NULL 的无排名结果排最后（与 memory 实现一致）。
        .orderBy(
          sql`${strategyResults.rank} IS NULL`,
          asc(strategyResults.rank),
          asc(strategyResults.stockId),
        )
        .all()
        .map(toResult)
    );
  }

  async saveSignals(signals: readonly StrategySignal[]): Promise<void> {
    for (const signal of signals) {
      StrategySignalSchema.parse(signal);
      if ((await this.findRunById(signal.runId)) === null) {
        throw new InvariantError(`StrategyRun 不存在: ${signal.runId}`);
      }
      this.db
        .insert(strategySignals)
        .values({
          ...signal,
          evidence: [...signal.evidence],
        })
        .onConflictDoNothing()
        .run();
    }
  }

  async signalsByStrategy(strategyId: string, since?: Date): Promise<readonly StrategySignal[]> {
    const where =
      since === undefined
        ? eq(strategySignals.strategyId, strategyId)
        : and(eq(strategySignals.strategyId, strategyId), gte(strategySignals.ts, since));
    return this.db
      .select()
      .from(strategySignals)
      .where(where)
      .orderBy(desc(strategySignals.ts), desc(strategySignals.id))
      .all()
      .map(toSignal);
  }

  async signalsByRun(runId: string): Promise<readonly StrategySignal[]> {
    return this.db
      .select()
      .from(strategySignals)
      .where(eq(strategySignals.runId, runId))
      .orderBy(desc(strategySignals.ts), desc(strategySignals.id))
      .all()
      .map(toSignal);
  }

  async signalsByStock(stockId: string, since?: Date): Promise<readonly StrategySignal[]> {
    const where =
      since === undefined
        ? eq(strategySignals.stockId, stockId)
        : and(eq(strategySignals.stockId, stockId), gte(strategySignals.ts, since));
    return this.db
      .select()
      .from(strategySignals)
      .where(where)
      .orderBy(desc(strategySignals.ts), desc(strategySignals.id))
      .all()
      .map(toSignal);
  }

  async commitRun(bundle: {
    readonly run: StrategyRun;
    readonly results: readonly StrategyResult[];
    readonly signals: readonly StrategySignal[];
  }): Promise<void> {
    assertStrategyRunInvariants(bundle.run);
    if (bundle.run.status === 'running') {
      throw new InvariantError('commitRun 只接受终态 StrategyRun');
    }
    for (const result of bundle.results) {
      StrategyResultSchema.parse(result);
      if (result.runId !== bundle.run.id) throw new InvariantError('StrategyResult.runId 不匹配');
    }
    for (const signal of bundle.signals) {
      StrategySignalSchema.parse(signal);
      if (
        signal.runId !== bundle.run.id ||
        signal.strategyId !== bundle.run.strategyId ||
        signal.strategyVersionId !== bundle.run.strategyVersionId
      ) {
        throw new InvariantError('StrategySignal 引用与 run 不匹配');
      }
    }

    this.db.transaction((tx) => {
      const strategy = tx
        .select()
        .from(strategies)
        .where(eq(strategies.id, bundle.run.strategyId))
        .get();
      const version = tx
        .select()
        .from(strategyVersions)
        .where(eq(strategyVersions.id, bundle.run.strategyVersionId))
        .get();
      if (
        strategy?.status !== 'active' ||
        version?.strategyId !== bundle.run.strategyId ||
        version.validationStatus !== 'valid' ||
        version.publishedAt === null
      ) {
        throw new InvariantError('StrategyRun 必须绑定 active Strategy 的 published valid version');
      }
      tx.insert(strategyRuns)
        .values({
          id: bundle.run.id,
          strategyId: bundle.run.strategyId,
          strategyVersionId: bundle.run.strategyVersionId,
          mode: bundle.run.mode,
          coverage: bundle.run.coverage,
          dataAsOf: bundle.run.dataAsOf,
          startedAt: bundle.run.startedAt,
          finishedAt: bundle.run.finishedAt ?? null,
          status: bundle.run.status,
          inputSnapshot: bundle.run.inputSnapshot,
          providerStatuses: [...bundle.run.providerStatuses],
          summary: bundle.run.summary ?? null,
          error: bundle.run.error ?? null,
        })
        .onConflictDoUpdate({
          target: strategyRuns.id,
          set: {
            dataAsOf: bundle.run.dataAsOf,
            finishedAt: bundle.run.finishedAt ?? null,
            status: bundle.run.status,
            providerStatuses: [...bundle.run.providerStatuses],
            summary: bundle.run.summary ?? null,
            error: bundle.run.error ?? null,
          },
        })
        .run();
      for (const result of bundle.results) {
        tx.insert(strategyResults)
          .values({
            runId: result.runId,
            stockId: result.stockId,
            selected: result.selected,
            score: result.score ?? null,
            rank: result.rank ?? null,
            ruleEvaluations: [...result.ruleEvaluations],
            evidence: [...result.evidence],
            dataAsOf: result.dataAsOf,
          })
          .onConflictDoUpdate({
            target: [strategyResults.runId, strategyResults.stockId],
            set: {
              selected: result.selected,
              score: result.score ?? null,
              rank: result.rank ?? null,
              ruleEvaluations: [...result.ruleEvaluations],
              evidence: [...result.evidence],
              dataAsOf: result.dataAsOf,
            },
          })
          .run();
      }
      for (const signal of bundle.signals) {
        tx.insert(strategySignals)
          .values({ ...signal, evidence: [...signal.evidence] })
          .onConflictDoNothing()
          .run();
      }
    });
  }

  private assertRunnableVersion(strategyId: string, versionId: string): void {
    const strategy = this.db.select().from(strategies).where(eq(strategies.id, strategyId)).get();
    const version = this.db
      .select()
      .from(strategyVersions)
      .where(eq(strategyVersions.id, versionId))
      .get();
    if (
      strategy?.status !== 'active' ||
      version?.strategyId !== strategyId ||
      version.validationStatus !== 'valid' ||
      version.publishedAt === null
    ) {
      throw new InvariantError('StrategyRun 必须绑定 active Strategy 的 published valid version');
    }
  }
}
