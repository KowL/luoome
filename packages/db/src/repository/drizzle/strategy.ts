import {
  assertStrategyInvariants,
  assertStrategyRunBundleInvariants,
  assertStrategyVersionInvariants,
  InvariantError,
  type Strategy,
  type StrategyRepository,
  type StrategyResult,
  type StrategyRun,
  type StrategyRunBundle,
  type StrategyRunRepository,
  type StrategySignal,
  type StrategyVersion,
} from '@luoome/core';
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import {
  type Schema,
  strategies,
  strategyResults,
  strategyRunLeases,
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
  ...(row.factReferences === null ? {} : { factReferences: [...row.factReferences] }),
  ...(row.agentTrace === null || row.agentTrace === undefined
    ? {}
    : { agentTrace: [...row.agentTrace] }),
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

  async create(strategy: Strategy): Promise<void> {
    assertStrategyInvariants(strategy);
    if ((await this.findById(strategy.id)) !== null) {
      throw new InvariantError(`Strategy 已存在: ${strategy.id}`);
    }
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
      .run();
  }

  async remove(strategyId: string): Promise<void> {
    this.db.transaction((tx) => {
      tx.delete(strategyVersions).where(eq(strategyVersions.strategyId, strategyId)).run();
      tx.delete(strategies).where(eq(strategies.id, strategyId)).run();
    });
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

  async createVersion(version: StrategyVersion): Promise<void> {
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
    if (existing !== null) throw new InvariantError(`StrategyVersion 已存在: ${version.id}`);
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
        factReferences: version.factReferences ?? null,
        agentTrace: version.agentTrace ?? null,
        validationStatus: version.validationStatus,
        validationErrors: [...version.validationErrors],
        publishedAt: version.publishedAt ?? null,
        createdAt: version.createdAt,
      })
      .run();
  }

  async setVersionValidation(
    versionId: string,
    validation: { readonly status: 'valid' | 'invalid'; readonly errors: readonly string[] },
  ): Promise<void> {
    this.db.transaction((tx) => {
      const version = tx
        .select()
        .from(strategyVersions)
        .where(eq(strategyVersions.id, versionId))
        .get();
      if (version === undefined) throw new InvariantError(`StrategyVersion 不存在: ${versionId}`);
      const strategy = tx
        .select()
        .from(strategies)
        .where(eq(strategies.id, version.strategyId))
        .get();
      if (strategy?.owner !== 'user') throw new InvariantError('builtin StrategyVersion 不可修改');
      if (version.publishedAt !== null) {
        throw new InvariantError('published StrategyVersion 不可重新校验修改');
      }
      tx.update(strategyVersions)
        .set({
          validationStatus: validation.status,
          validationErrors: [...validation.errors],
        })
        .where(eq(strategyVersions.id, versionId))
        .run();
    });
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
        strategy.owner !== 'user' ||
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

  async pause(strategyId: string, at: Date): Promise<void> {
    this.db.transaction((tx) => {
      const strategy = tx.select().from(strategies).where(eq(strategies.id, strategyId)).get();
      if (strategy === undefined) throw new InvariantError(`Strategy 不存在: ${strategyId}`);
      if (strategy.owner !== 'user' || strategy.status !== 'active') {
        throw new InvariantError('只有 active 的用户 Strategy 可暂停');
      }
      tx.update(strategies)
        .set({ status: 'paused', updatedAt: at })
        .where(eq(strategies.id, strategyId))
        .run();
    });
  }

  async resume(strategyId: string, at: Date): Promise<void> {
    this.db.transaction((tx) => {
      const strategy = tx.select().from(strategies).where(eq(strategies.id, strategyId)).get();
      if (strategy === undefined) throw new InvariantError(`Strategy 不存在: ${strategyId}`);
      const version =
        strategy.currentVersionId === null
          ? undefined
          : tx
              .select()
              .from(strategyVersions)
              .where(eq(strategyVersions.id, strategy.currentVersionId))
              .get();
      if (
        strategy.owner !== 'user' ||
        strategy.status !== 'paused' ||
        version?.validationStatus !== 'valid' ||
        version.publishedAt === null
      ) {
        throw new InvariantError('恢复需要 paused 用户 Strategy 及已发布 valid currentVersion');
      }
      tx.update(strategies)
        .set({ status: 'active', updatedAt: at })
        .where(eq(strategies.id, strategyId))
        .run();
    });
  }
}

export class DrizzleStrategyRunRepository implements StrategyRunRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async acquireRunLease(input: {
    readonly strategyId: string;
    readonly strategyVersionId: string;
    readonly owner: string;
    readonly now: Date;
    readonly leaseUntil: Date;
  }): Promise<boolean> {
    const result = this.db.run(sql`
      INSERT INTO strategy_run_leases (strategy_id, strategy_version_id, owner, lease_until)
      VALUES (
        ${input.strategyId}, ${input.strategyVersionId}, ${input.owner}, ${input.leaseUntil.getTime()}
      )
      ON CONFLICT (strategy_id, strategy_version_id) DO UPDATE SET
        owner = excluded.owner,
        lease_until = excluded.lease_until
      WHERE strategy_run_leases.lease_until <= ${input.now.getTime()}
    `);
    return (
      typeof result === 'object' &&
      result !== null &&
      'changes' in result &&
      Number((result as { readonly changes: unknown }).changes) === 1
    );
  }

  async releaseRunLease(input: {
    readonly strategyId: string;
    readonly strategyVersionId: string;
    readonly owner: string;
  }): Promise<void> {
    this.db.run(sql`
      DELETE FROM strategy_run_leases
      WHERE strategy_id = ${input.strategyId}
        AND strategy_version_id = ${input.strategyVersionId}
        AND owner = ${input.owner}
    `);
  }

  async removeByStrategyId(strategyId: string): Promise<void> {
    this.db.transaction((tx) => {
      const runIds = tx
        .select({ id: strategyRuns.id })
        .from(strategyRuns)
        .where(eq(strategyRuns.strategyId, strategyId))
        .all()
        .map((row) => row.id);
      if (runIds.length > 0) {
        tx.delete(strategyResults).where(inArray(strategyResults.runId, runIds)).run();
      }
      tx.delete(strategySignals).where(eq(strategySignals.strategyId, strategyId)).run();
      tx.delete(strategyRuns).where(eq(strategyRuns.strategyId, strategyId)).run();
      tx.delete(strategyRunLeases).where(eq(strategyRunLeases.strategyId, strategyId)).run();
    });
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

  async commitRun(bundle: StrategyRunBundle): Promise<void> {
    assertStrategyRunBundleInvariants(bundle);
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
          .run();
      }
      for (const signal of bundle.signals) {
        tx.insert(strategySignals)
          .values({ ...signal, evidence: [...signal.evidence] })
          .run();
      }
    });
  }
}
