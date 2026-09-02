import {
  assertStrategyInvariants,
  assertStrategyRunBundleInvariants,
  assertStrategyRunInvariants,
  assertStrategyVersionInvariants,
  InvariantError,
  normalizeLegacyStrategyRun,
  type Strategy,
  type StrategyLeaseToken,
  type StrategyRepository,
  type StrategyResult,
  type StrategyRun,
  type StrategyRunBundle,
  type StrategyRunRepository,
  StrategyRunSchema,
  type StrategySignal,
  type StrategyVersion,
} from '@luoome/core';
import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
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
type DrizzleTransaction = Parameters<Parameters<BunSQLiteDatabase<Schema>['transaction']>[0]>[0];

/**
 * 可运行版本判定（M2 自治验证，docs/ddd/strategy-ai-lifecycle-detailed-design.md §8/§9.2）：
 * evaluation scope 的持久化 run 是非发布验证证据，允许绑定未发布 valid version，
 * 也允许 draft 状态的 Strategy（AI 新策略首发前的独立验证；draft 无 schedule、
 * 不产生生产信号）；operational 仍要求 active Strategy 的 published valid version。
 */
const isRunnableStrategyVersion = (
  strategy: StrategyRow | undefined,
  version: VersionRow | undefined,
  run: { readonly strategyId: string; readonly scope?: StrategyRun['scope'] },
): boolean =>
  strategy !== undefined &&
  (strategy.status === 'active' || (run.scope === 'evaluation' && strategy.status === 'draft')) &&
  version?.strategyId === run.strategyId &&
  version.validationStatus === 'valid' &&
  (version.publishedAt !== null || run.scope === 'evaluation');

// publication_status 为空时只允许兼容存量非 V4 行；新 Summary V4 缺 publication
// 必须保持 withheld/unknown，不能被 legacy fallback 误当成 current。
const legacyPublishedRunCondition = () =>
  and(
    isNull(strategyRuns.publicationStatus),
    sql`coalesce(json_extract(${strategyRuns.summary}, '$.schemaVersion'), 0) <> 4`,
  );

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

const toRun = (row: RunRow): StrategyRun =>
  normalizeLegacyStrategyRun(
    StrategyRunSchema.parse({
      id: row.id,
      strategyId: row.strategyId,
      strategyVersionId: row.strategyVersionId,
      mode: row.mode,
      coverage: row.coverage,
      dataAsOf: row.dataAsOf,
      startedAt: row.startedAt,
      ...(row.finishedAt === null ? {} : { finishedAt: row.finishedAt }),
      status: row.status,
      scope: row.scope,
      inputSnapshot: row.inputSnapshot,
      providerStatuses: [...row.providerStatuses],
      ...(row.providerCoverage === null || row.providerCoverage === undefined
        ? {}
        : { providerCoverage: [...row.providerCoverage] }),
      ...(row.summary === null ? {} : { summary: row.summary }),
      ...(row.publication === null || row.publication === undefined
        ? {}
        : { publication: row.publication }),
      ...(row.error === null ? {} : { error: row.error }),
    }),
  );

const toResult = (row: ResultRow): StrategyResult => {
  const stored = Array.isArray(row.ruleEvaluations)
    ? { ruleEvaluations: row.ruleEvaluations }
    : row.ruleEvaluations;
  return {
    runId: row.runId,
    stockId: row.stockId,
    selected: row.selected,
    ...(row.score === null ? {} : { score: row.score }),
    ...(row.rank === null ? {} : { rank: row.rank }),
    ruleEvaluations: [...stored.ruleEvaluations],
    ...(stored.scoringBreakdown === undefined
      ? {}
      : { scoringBreakdown: [...stored.scoringBreakdown] }),
    evidence: [...row.evidence],
    dataAsOf: row.dataAsOf,
  };
};

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

  async archive(strategyId: string, at: Date): Promise<void> {
    this.db.transaction((tx) => {
      const strategy = tx.select().from(strategies).where(eq(strategies.id, strategyId)).get();
      if (strategy === undefined) throw new InvariantError(`Strategy 不存在: ${strategyId}`);
      if (strategy.owner !== 'user' || strategy.status !== 'paused') {
        throw new InvariantError('只有 paused 的用户 Strategy 可归档');
      }
      tx.update(strategies)
        .set({ status: 'archived', updatedAt: at })
        .where(eq(strategies.id, strategyId))
        .run();
    });
  }
}

export class DrizzleStrategyRunRepository implements StrategyRunRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async acquireRunLeaseToken(input: {
    readonly strategyId: string;
    readonly strategyVersionId: string;
    readonly owner: string;
    readonly runId?: string;
    readonly now: Date;
    readonly leaseUntil: Date;
  }): Promise<StrategyLeaseToken | null> {
    const result = this.db.run(sql`
      INSERT INTO strategy_run_leases
        (strategy_id, strategy_version_id, owner, lease_until, fence, heartbeat_at)
      VALUES (
        ${input.strategyId}, ${input.strategyVersionId}, ${input.owner},
        ${input.leaseUntil.getTime()}, 1, ${input.now.getTime()}
      )
      ON CONFLICT (strategy_id, strategy_version_id) DO UPDATE SET
        owner = excluded.owner,
        lease_until = excluded.lease_until,
        fence = strategy_run_leases.fence + 1,
        heartbeat_at = excluded.heartbeat_at
      WHERE strategy_run_leases.lease_until <= ${input.now.getTime()}
    `);
    const changed =
      typeof result === 'object' &&
      result !== null &&
      'changes' in result &&
      Number((result as { readonly changes: unknown }).changes) === 1;
    if (!changed) return null;
    const row = this.db
      .select()
      .from(strategyRunLeases)
      .where(
        and(
          eq(strategyRunLeases.strategyId, input.strategyId),
          eq(strategyRunLeases.strategyVersionId, input.strategyVersionId),
        ),
      )
      .get();
    if (row === undefined) return null;
    return {
      strategyId: input.strategyId,
      strategyVersionId: input.strategyVersionId,
      owner: row.owner,
      fence: row.fence,
      leaseUntil: row.leaseUntil,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
    };
  }

  async renewRunLease(input: {
    readonly token: StrategyLeaseToken;
    readonly now: Date;
    readonly leaseUntil: Date;
  }): Promise<boolean> {
    const result = this.db.run(sql`
      UPDATE strategy_run_leases
      SET lease_until = ${input.leaseUntil.getTime()}, heartbeat_at = ${input.now.getTime()}
      WHERE strategy_id = ${input.token.strategyId}
        AND strategy_version_id = ${input.token.strategyVersionId}
        AND owner = ${input.token.owner}
        AND fence = ${input.token.fence}
        AND lease_until > ${input.now.getTime()}
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
    readonly fence?: number;
  }): Promise<void> {
    this.db.run(
      input.fence === undefined
        ? sql`
          DELETE FROM strategy_run_leases
          WHERE strategy_id = ${input.strategyId}
            AND strategy_version_id = ${input.strategyVersionId}
            AND owner = ${input.owner}
        `
        : sql`
          DELETE FROM strategy_run_leases
          WHERE strategy_id = ${input.strategyId}
            AND strategy_version_id = ${input.strategyVersionId}
            AND owner = ${input.owner}
            AND fence = ${input.fence}
        `,
    );
  }

  async commitRunWithFence(input: {
    readonly token: StrategyLeaseToken;
    readonly now: Date;
    readonly bundle: StrategyRunBundle;
  }): Promise<'committed' | 'lease-lost'> {
    assertStrategyRunBundleInvariants(input.bundle);
    if (input.token.runId !== undefined && input.token.runId !== input.bundle.run.id) {
      return 'lease-lost';
    }
    return this.db.transaction((tx) => {
      const lease = tx
        .select()
        .from(strategyRunLeases)
        .where(
          and(
            eq(strategyRunLeases.strategyId, input.token.strategyId),
            eq(strategyRunLeases.strategyVersionId, input.token.strategyVersionId),
            eq(strategyRunLeases.owner, input.token.owner),
            eq(strategyRunLeases.fence, input.token.fence),
            sql`${strategyRunLeases.leaseUntil} > ${input.now.getTime()}`,
          ),
        )
        .get();
      if (lease === undefined) return 'lease-lost';
      if (
        input.bundle.run.strategyId !== input.token.strategyId ||
        input.bundle.run.strategyVersionId !== input.token.strategyVersionId
      ) {
        return 'lease-lost';
      }
      const existingRun = tx
        .select()
        .from(strategyRuns)
        .where(eq(strategyRuns.id, input.bundle.run.id))
        .get();
      if (
        existingRun === undefined ||
        existingRun.status !== 'running' ||
        input.bundle.run.status === 'running' ||
        existingRun.strategyId !== input.bundle.run.strategyId ||
        existingRun.strategyVersionId !== input.bundle.run.strategyVersionId ||
        existingRun.startedAt.getTime() !== input.bundle.run.startedAt.getTime()
      ) {
        return 'lease-lost';
      }
      this.commitRunInTransaction(tx, input.bundle);
      return 'committed';
    });
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
      readonly scope?: StrategyRun['scope'];
      readonly publication?: NonNullable<StrategyRun['publication']>['status'];
      readonly since?: Date;
      readonly limit?: number;
    } = {},
  ): Promise<readonly StrategyRun[]> {
    const conditions = [];
    if (filter.strategyId !== undefined) {
      conditions.push(eq(strategyRuns.strategyId, filter.strategyId));
    }
    if (filter.status !== undefined) conditions.push(eq(strategyRuns.status, filter.status));
    if (filter.scope !== undefined) conditions.push(eq(strategyRuns.scope, filter.scope));
    if (filter.publication !== undefined) {
      conditions.push(eq(strategyRuns.publicationStatus, filter.publication));
    }
    if (filter.since !== undefined) conditions.push(gte(strategyRuns.startedAt, filter.since));
    const query = this.db
      .select()
      .from(strategyRuns)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(strategyRuns.startedAt), desc(strategyRuns.id));
    const rows = filter.limit === undefined ? query.all() : query.limit(filter.limit).all();
    return rows.map(toRun);
  }

  async findLatestPublishedRun(strategyId: string): Promise<StrategyRun | null> {
    const row = this.db
      .select()
      .from(strategyRuns)
      .where(
        and(
          eq(strategyRuns.strategyId, strategyId),
          eq(strategyRuns.scope, 'operational'),
          or(eq(strategyRuns.publicationStatus, 'published'), legacyPublishedRunCondition()),
          inArray(strategyRuns.status, ['complete', 'partial']),
        ),
      )
      .orderBy(desc(strategyRuns.startedAt), desc(strategyRuns.id))
      .limit(1)
      .get();
    return row === undefined ? null : toRun(row);
  }

  async findPreviousPublishedRun(input: {
    readonly strategyId: string;
    readonly beforeStartedAt: Date;
    readonly beforeRunId: string;
  }): Promise<StrategyRun | null> {
    const row = this.db
      .select()
      .from(strategyRuns)
      .where(
        and(
          eq(strategyRuns.strategyId, input.strategyId),
          eq(strategyRuns.scope, 'operational'),
          or(eq(strategyRuns.publicationStatus, 'published'), legacyPublishedRunCondition()),
          inArray(strategyRuns.status, ['complete', 'partial']),
          sql`(${strategyRuns.startedAt} < ${input.beforeStartedAt.getTime()} OR
            (${strategyRuns.startedAt} = ${input.beforeStartedAt.getTime()} AND
             ${strategyRuns.id} < ${input.beforeRunId}))`,
        ),
      )
      .orderBy(desc(strategyRuns.startedAt), desc(strategyRuns.id))
      .limit(1)
      .get();
    return row === undefined ? null : toRun(row);
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

  async listResultsByRuns(runIds: readonly string[]): Promise<readonly StrategyResult[]> {
    if (runIds.length === 0) return [];
    return (
      this.db
        .select()
        .from(strategyResults)
        .where(inArray(strategyResults.runId, [...runIds]))
        // rank 为 NULL 的无排名结果排最后（与 listResults 一致）。
        .orderBy(
          asc(strategyResults.runId),
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

  async signalsByRuns(runIds: readonly string[]): Promise<readonly StrategySignal[]> {
    if (runIds.length === 0) return [];
    return this.db
      .select()
      .from(strategySignals)
      .where(inArray(strategySignals.runId, [...runIds]))
      .orderBy(desc(strategySignals.ts), desc(strategySignals.id))
      .all()
      .map(toSignal);
  }

  async signalsByIds(signalIds: readonly string[]): Promise<readonly StrategySignal[]> {
    if (signalIds.length === 0) return [];
    return this.db
      .select()
      .from(strategySignals)
      .where(inArray(strategySignals.id, [...signalIds]))
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

  async saveStartedRun(run: StrategyRun): Promise<void> {
    assertStrategyRunInvariants(run);
    if (run.status !== 'running') throw new InvariantError('saveStartedRun 只接受 running');
    const strategy = this.db
      .select()
      .from(strategies)
      .where(eq(strategies.id, run.strategyId))
      .get();
    const version = this.db
      .select()
      .from(strategyVersions)
      .where(eq(strategyVersions.id, run.strategyVersionId))
      .get();
    if (!isRunnableStrategyVersion(strategy, version, run)) {
      throw new InvariantError('StrategyRun 必须绑定 active Strategy 的 published valid version');
    }
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
        finishedAt: null,
        status: run.status,
        scope: run.scope ?? 'operational',
        inputSnapshot: run.inputSnapshot,
        providerStatuses: [...run.providerStatuses],
        providerCoverage: run.providerCoverage ?? null,
        summary: null,
        publication: null,
        publicationStatus: null,
        error: null,
      })
      .run();
  }

  async commitRun(bundle: StrategyRunBundle): Promise<void> {
    assertStrategyRunBundleInvariants(bundle);
    this.db.transaction((tx) => this.commitRunInTransaction(tx, bundle));
  }

  private commitRunInTransaction(tx: DrizzleTransaction, bundle: StrategyRunBundle): void {
    const runValues = {
      id: bundle.run.id,
      strategyId: bundle.run.strategyId,
      strategyVersionId: bundle.run.strategyVersionId,
      mode: bundle.run.mode,
      coverage: bundle.run.coverage,
      dataAsOf: bundle.run.dataAsOf,
      startedAt: bundle.run.startedAt,
      finishedAt: bundle.run.finishedAt ?? null,
      status: bundle.run.status,
      scope: bundle.run.scope ?? 'operational',
      inputSnapshot: bundle.run.inputSnapshot,
      providerStatuses: [...bundle.run.providerStatuses],
      providerCoverage: bundle.run.providerCoverage ?? null,
      summary: bundle.run.summary ?? null,
      publication: bundle.run.publication ?? null,
      publicationStatus: bundle.run.publication?.status ?? null,
      error: bundle.run.error ?? null,
    };
    const existing = tx.select().from(strategyRuns).where(eq(strategyRuns.id, bundle.run.id)).get();
    if (existing === undefined) {
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
      if (!isRunnableStrategyVersion(strategy, version, bundle.run)) {
        throw new InvariantError('StrategyRun 必须绑定 active Strategy 的 published valid version');
      }
      tx.insert(strategyRuns).values(runValues).run();
    } else {
      if (
        existing.status !== 'running' ||
        bundle.run.status === 'running' ||
        existing.strategyId !== bundle.run.strategyId ||
        existing.strategyVersionId !== bundle.run.strategyVersionId ||
        existing.startedAt.getTime() !== bundle.run.startedAt.getTime()
      ) {
        throw new InvariantError(`StrategyRun.runId 已存在: ${bundle.run.id}`);
      }
      tx.update(strategyRuns).set(runValues).where(eq(strategyRuns.id, bundle.run.id)).run();
    }
    for (const result of bundle.results) {
      tx.insert(strategyResults)
        .values({
          runId: result.runId,
          stockId: result.stockId,
          selected: result.selected,
          score: result.score ?? null,
          rank: result.rank ?? null,
          ruleEvaluations:
            result.scoringBreakdown === undefined
              ? [...result.ruleEvaluations]
              : {
                  ruleEvaluations: [...result.ruleEvaluations],
                  scoringBreakdown: [...result.scoringBreakdown],
                },
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
  }
}
