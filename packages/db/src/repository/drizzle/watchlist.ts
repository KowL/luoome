import {
  assertWatchlistInvariants,
  assertWatchlistMemberInvariants,
  assertWatchlistMemberSourceInvariants,
  assertWatchlistSyncRunInvariants,
  InvariantError,
  type MembershipSnapshot,
  MembershipSnapshotSchema,
  type Watchlist,
  type WatchlistMember,
  type WatchlistMemberRepository,
  type WatchlistMemberSource,
  type WatchlistRepository,
  type WatchlistSyncCommit,
  type WatchlistSyncRun,
} from '@luoome/core';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import {
  type Schema,
  watchlistMemberSources,
  watchlistMembers,
  watchlists,
  workflowRuns,
} from '../../schema/index.js';

type WatchlistRow = typeof watchlists.$inferSelect;
type MemberRow = typeof watchlistMembers.$inferSelect;
type SourceRow = typeof watchlistMemberSources.$inferSelect;
type WorkflowRunRow = typeof workflowRuns.$inferSelect;

const toWatchlist = (row: WatchlistRow): Watchlist => ({
  id: row.id,
  name: row.name,
  ...(row.description === null ? {} : { description: row.description }),
  kind: row.kind,
  membershipPolicy: row.membershipPolicy,
  enabled: row.enabled,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toMember = (row: MemberRow): WatchlistMember => ({
  id: row.id,
  watchlistId: row.watchlistId,
  stockId: row.stockId,
  stage: row.stage,
  priority: row.priority,
  firstAddedAt: row.firstAddedAt,
  lastActivityAt: row.lastActivityAt,
  ...(row.archivedAt === null ? {} : { archivedAt: row.archivedAt }),
});

const toSource = (row: SourceRow): WatchlistMemberSource => ({
  id: row.id,
  memberId: row.memberId,
  kind: row.kind,
  sourceKey: row.sourceKey,
  ...(row.sourceId === null ? {} : { sourceId: row.sourceId }),
  ...(row.sourceVersionId === null ? {} : { sourceVersionId: row.sourceVersionId }),
  ...(row.syncRunId === null ? {} : { syncRunId: row.syncRunId }),
  ...(row.ownerUserId === null ? {} : { ownerUserId: row.ownerUserId }),
  ...(row.importBatchId === null ? {} : { importBatchId: row.importBatchId }),
  reason: row.reason,
  ...(row.score === null ? {} : { score: row.score }),
  ...(row.rank === null ? {} : { rank: row.rank }),
  status: row.status,
  evidence: [...row.evidence],
  ...(row.dataAsOf === null ? {} : { dataAsOf: row.dataAsOf }),
  validFrom: row.validFrom,
  ...(row.validUntil === null ? {} : { validUntil: row.validUntil }),
});

/** §6：watchlist 同步运行记入 workflow_runs（workflowName='watchlist-sync'），此处是读模型 façade。 */
const WATCHLIST_SYNC_WORKFLOW = 'watchlist-sync';

type StoredSyncChange = {
  readonly stockId: string;
  readonly change: MembershipSnapshot['change'];
  readonly reason: string;
  readonly score?: number;
  readonly rank?: number;
  readonly evidence: readonly string[];
  readonly dataAsOf?: string;
};

const toWorkflowRunValues = (
  run: WatchlistSyncRun,
  changes?: readonly StoredSyncChange[],
): typeof workflowRuns.$inferInsert => ({
  id: run.id,
  workflowName: WATCHLIST_SYNC_WORKFLOW,
  mode: 'manual',
  status:
    run.status === 'complete'
      ? 'succeeded'
      : run.status === 'running'
        ? 'running'
        : run.status === 'partial'
          ? 'partial'
          : 'failed',
  startedAt: run.startedAt,
  ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
  inputSummary: {
    watchlistId: run.watchlistId,
    sourceKind: run.sourceKind,
    sourceKey: run.sourceKey,
    ...(run.producerRunId === undefined ? {} : { producerRunId: run.producerRunId }),
    ...(run.dataAsOf === undefined ? {} : { dataAsOf: run.dataAsOf.toISOString() }),
  },
  outputSummary: {
    status: run.status,
    enteredCount: run.enteredCount,
    exitedCount: run.exitedCount,
    unchangedCount: run.unchangedCount,
    missingDimensions: [...run.missingDimensions],
    ...(changes === undefined ? {} : { changes: [...changes] }),
  },
  providerStatuses: [],
  ...(run.error === undefined ? {} : { error: run.error }),
});

const toSyncRun = (row: WorkflowRunRow): WatchlistSyncRun => {
  const input = (row.inputSummary ?? {}) as Readonly<Record<string, unknown>>;
  const output = (row.outputSummary ?? {}) as Readonly<Record<string, unknown>>;
  const status =
    output.status === 'running' ||
    output.status === 'complete' ||
    output.status === 'partial' ||
    output.status === 'failed'
      ? (output.status as WatchlistSyncRun['status'])
      : row.status === 'succeeded'
        ? 'complete'
        : row.status === 'partial'
          ? 'partial'
          : row.status === 'running'
            ? 'running'
            : 'failed';
  return {
    id: row.id,
    watchlistId: typeof input.watchlistId === 'string' ? input.watchlistId : '',
    sourceKind: (typeof input.sourceKind === 'string'
      ? input.sourceKind
      : 'import') as WatchlistSyncRun['sourceKind'],
    sourceKey: typeof input.sourceKey === 'string' ? input.sourceKey : '',
    ...(typeof input.producerRunId === 'string' ? { producerRunId: input.producerRunId } : {}),
    status,
    ...(typeof input.dataAsOf === 'string' ? { dataAsOf: new Date(input.dataAsOf) } : {}),
    startedAt: row.startedAt,
    ...(row.finishedAt === null ? {} : { finishedAt: row.finishedAt }),
    enteredCount: typeof output.enteredCount === 'number' ? output.enteredCount : 0,
    exitedCount: typeof output.exitedCount === 'number' ? output.exitedCount : 0,
    unchangedCount: typeof output.unchangedCount === 'number' ? output.unchangedCount : 0,
    missingDimensions: Array.isArray(output.missingDimensions)
      ? (output.missingDimensions as WatchlistSyncRun['missingDimensions'])
      : [],
    ...(row.error === null ? {} : { error: row.error }),
  };
};

const memberValues = (member: WatchlistMember) => ({
  id: member.id,
  watchlistId: member.watchlistId,
  stockId: member.stockId,
  stage: member.stage,
  priority: member.priority,
  firstAddedAt: member.firstAddedAt,
  lastActivityAt: member.lastActivityAt,
  archivedAt: member.archivedAt ?? null,
});

const sourceValues = (source: WatchlistMemberSource) => ({
  id: source.id,
  memberId: source.memberId,
  kind: source.kind,
  sourceKey: source.sourceKey,
  sourceId: source.sourceId ?? null,
  sourceVersionId: source.sourceVersionId ?? null,
  syncRunId: source.syncRunId ?? null,
  ownerUserId: source.ownerUserId ?? null,
  importBatchId: source.importBatchId ?? null,
  reason: source.reason,
  score: source.score ?? null,
  rank: source.rank ?? null,
  status: source.status,
  evidence: [...source.evidence],
  dataAsOf: source.dataAsOf ?? null,
  validFrom: source.validFrom,
  validUntil: source.validUntil ?? null,
});

export class DrizzleWatchlistRepository implements WatchlistRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(watchlist: Watchlist): Promise<void> {
    assertWatchlistInvariants(watchlist);
    this.db
      .insert(watchlists)
      .values({
        id: watchlist.id,
        name: watchlist.name,
        description: watchlist.description ?? null,
        kind: watchlist.kind,
        membershipPolicy: watchlist.membershipPolicy,
        enabled: watchlist.enabled,
        createdAt: watchlist.createdAt,
        updatedAt: watchlist.updatedAt,
      })
      .onConflictDoUpdate({
        target: watchlists.id,
        set: {
          name: watchlist.name,
          description: watchlist.description ?? null,
          kind: watchlist.kind,
          membershipPolicy: watchlist.membershipPolicy,
          enabled: watchlist.enabled,
          updatedAt: watchlist.updatedAt,
        },
      })
      .run();
  }

  async findById(id: string): Promise<Watchlist | null> {
    const row = this.db.select().from(watchlists).where(eq(watchlists.id, id)).get();
    return row === undefined ? null : toWatchlist(row);
  }

  async list(
    filter: { readonly enabledOnly?: boolean; readonly kind?: Watchlist['kind'] } = {},
  ): Promise<readonly Watchlist[]> {
    const conditions = [];
    if (filter.enabledOnly) conditions.push(eq(watchlists.enabled, true));
    if (filter.kind !== undefined) conditions.push(eq(watchlists.kind, filter.kind));
    return this.db
      .select()
      .from(watchlists)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(asc(watchlists.id))
      .all()
      .map(toWatchlist);
  }

  async archive(id: string, at: Date): Promise<void> {
    if (this.db.select().from(watchlists).where(eq(watchlists.id, id)).get() === undefined) {
      throw new InvariantError(`Watchlist 不存在: ${id}`);
    }
    this.db
      .update(watchlists)
      .set({ enabled: false, updatedAt: at })
      .where(eq(watchlists.id, id))
      .run();
  }
}

export class DrizzleWatchlistMemberRepository implements WatchlistMemberRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async saveMember(member: WatchlistMember): Promise<void> {
    assertWatchlistMemberInvariants(member);
    if (
      this.db.select().from(watchlists).where(eq(watchlists.id, member.watchlistId)).get() ===
      undefined
    ) {
      throw new InvariantError(`Watchlist 不存在: ${member.watchlistId}`);
    }
    // 预检唯一约束，避免把 SQLite UNIQUE 错误泄漏给调用方（与 memory 实现对齐）。
    const duplicate = await this.findMember(member.watchlistId, member.stockId);
    if (duplicate !== null && duplicate.id !== member.id) {
      throw new InvariantError('(watchlistId, stockId) 必须唯一');
    }
    this.db
      .insert(watchlistMembers)
      .values(memberValues(member))
      .onConflictDoUpdate({
        target: watchlistMembers.id,
        set: {
          stage: member.stage,
          priority: member.priority,
          lastActivityAt: member.lastActivityAt,
          archivedAt: member.archivedAt ?? null,
        },
      })
      .run();
  }

  async findMember(watchlistId: string, stockId: string): Promise<WatchlistMember | null> {
    const row = this.db
      .select()
      .from(watchlistMembers)
      .where(
        and(eq(watchlistMembers.watchlistId, watchlistId), eq(watchlistMembers.stockId, stockId)),
      )
      .get();
    return row === undefined ? null : toMember(row);
  }

  async listMembers(
    watchlistId: string,
    filter: {
      readonly stage?: WatchlistMember['stage'];
      readonly priority?: WatchlistMember['priority'];
      readonly includeArchived?: boolean;
    } = {},
  ): Promise<readonly WatchlistMember[]> {
    const conditions = [eq(watchlistMembers.watchlistId, watchlistId)];
    if (!filter.includeArchived) conditions.push(ne(watchlistMembers.stage, 'archived'));
    if (filter.stage !== undefined) conditions.push(eq(watchlistMembers.stage, filter.stage));
    if (filter.priority !== undefined) {
      conditions.push(eq(watchlistMembers.priority, filter.priority));
    }
    return this.db
      .select()
      .from(watchlistMembers)
      .where(and(...conditions))
      .orderBy(asc(watchlistMembers.stockId))
      .all()
      .map(toMember);
  }

  async saveSource(source: WatchlistMemberSource): Promise<void> {
    assertWatchlistMemberSourceInvariants(source);
    if (
      this.db
        .select()
        .from(watchlistMembers)
        .where(eq(watchlistMembers.id, source.memberId))
        .get() === undefined
    ) {
      throw new InvariantError(`WatchlistMember 不存在: ${source.memberId}`);
    }
    // 预检部分唯一索引 watchlist_sources_current_unique，避免泄漏 SQLite 错误（与 memory 对齐）。
    if (source.status !== 'ended') {
      const current = await this.currentSource(source.memberId, source.sourceKey);
      if (current !== null && current.id !== source.id) {
        throw new InvariantError('(memberId, sourceKey) 只能有一个非 ended 来源');
      }
    }
    this.db
      .insert(watchlistMemberSources)
      .values(sourceValues(source))
      .onConflictDoUpdate({ target: watchlistMemberSources.id, set: sourceValues(source) })
      .run();
  }

  async listSources(
    memberId: string,
    includeEnded = false,
  ): Promise<readonly WatchlistMemberSource[]> {
    return this.db
      .select()
      .from(watchlistMemberSources)
      .where(
        includeEnded
          ? eq(watchlistMemberSources.memberId, memberId)
          : and(
              eq(watchlistMemberSources.memberId, memberId),
              ne(watchlistMemberSources.status, 'ended'),
            ),
      )
      .orderBy(desc(watchlistMemberSources.validFrom), desc(watchlistMemberSources.id))
      .all()
      .map(toSource);
  }

  async currentSource(memberId: string, sourceKey: string): Promise<WatchlistMemberSource | null> {
    const row = this.db
      .select()
      .from(watchlistMemberSources)
      .where(
        and(
          eq(watchlistMemberSources.memberId, memberId),
          eq(watchlistMemberSources.sourceKey, sourceKey),
          ne(watchlistMemberSources.status, 'ended'),
        ),
      )
      .get();
    return row === undefined ? null : toSource(row);
  }

  async commitManualMembers(
    rows: readonly {
      readonly member: WatchlistMember;
      readonly source: WatchlistMemberSource;
    }[],
  ): Promise<void> {
    for (const { member, source } of rows) {
      assertWatchlistMemberInvariants(member);
      assertWatchlistMemberSourceInvariants(source);
      if (source.memberId !== member.id || source.kind !== 'manual') {
        throw new InvariantError('手工成员来源必须引用同一 member 且 kind=manual');
      }
    }
    this.db.transaction((tx) => {
      for (const { member, source } of rows) {
        if (
          tx.select().from(watchlists).where(eq(watchlists.id, member.watchlistId)).get() ===
          undefined
        ) {
          throw new InvariantError(`Watchlist 不存在: ${member.watchlistId}`);
        }
        const duplicate = tx
          .select()
          .from(watchlistMembers)
          .where(
            and(
              eq(watchlistMembers.watchlistId, member.watchlistId),
              eq(watchlistMembers.stockId, member.stockId),
            ),
          )
          .get();
        if (duplicate !== undefined && duplicate.id !== member.id) {
          throw new InvariantError('(watchlistId, stockId) 必须唯一');
        }
        const currentSource = tx
          .select()
          .from(watchlistMemberSources)
          .where(
            and(
              eq(watchlistMemberSources.memberId, source.memberId),
              eq(watchlistMemberSources.sourceKey, source.sourceKey),
              ne(watchlistMemberSources.status, 'ended'),
            ),
          )
          .get();
        if (currentSource !== undefined && currentSource.id !== source.id) {
          throw new InvariantError('(memberId, sourceKey) 只能有一个非 ended 来源');
        }
        tx.insert(watchlistMembers)
          .values(memberValues(member))
          .onConflictDoUpdate({
            target: watchlistMembers.id,
            set: {
              stage: member.stage,
              priority: member.priority,
              lastActivityAt: member.lastActivityAt,
              archivedAt: member.archivedAt ?? null,
            },
          })
          .run();
        tx.insert(watchlistMemberSources).values(sourceValues(source)).run();
      }
    });
  }

  async saveSyncRun(run: WatchlistSyncRun): Promise<void> {
    assertWatchlistSyncRunInvariants(run);
    if (
      this.db.select().from(watchlists).where(eq(watchlists.id, run.watchlistId)).get() ===
      undefined
    ) {
      throw new InvariantError(`Watchlist 不存在: ${run.watchlistId}`);
    }
    const values = toWorkflowRunValues(run);
    this.db
      .insert(workflowRuns)
      .values(values)
      .onConflictDoUpdate({ target: workflowRuns.id, set: values })
      .run();
  }

  async listSyncRuns(watchlistId: string, limit = 50): Promise<readonly WatchlistSyncRun[]> {
    return this.db
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.workflowName, WATCHLIST_SYNC_WORKFLOW),
          sql`json_extract(${workflowRuns.inputSummary}, '$.watchlistId') = ${watchlistId}`,
        ),
      )
      .orderBy(desc(workflowRuns.startedAt), desc(workflowRuns.id))
      .limit(limit)
      .all()
      .map(toSyncRun);
  }

  async listSnapshots(syncRunId: string): Promise<readonly MembershipSnapshot[]> {
    const row = this.db
      .select({ outputSummary: workflowRuns.outputSummary })
      .from(workflowRuns)
      .where(
        and(eq(workflowRuns.workflowName, WATCHLIST_SYNC_WORKFLOW), eq(workflowRuns.id, syncRunId)),
      )
      .get();
    const output = (row?.outputSummary ?? {}) as Readonly<Record<string, unknown>>;
    const changes = Array.isArray(output.changes)
      ? (output.changes as readonly StoredSyncChange[])
      : [];
    return changes
      .map((change) =>
        MembershipSnapshotSchema.parse({
          id: `${syncRunId}:${change.stockId}`,
          syncRunId,
          stockId: change.stockId,
          selected: change.change !== 'exited',
          change: change.change,
          reason: change.reason,
          ...(change.score === undefined ? {} : { score: change.score }),
          ...(change.rank === undefined ? {} : { rank: change.rank }),
          evidence: [...change.evidence],
          ...(change.dataAsOf === undefined ? {} : { dataAsOf: new Date(change.dataAsOf) }),
        }),
      )
      .sort((left, right) => left.stockId.localeCompare(right.stockId));
  }

  async commitWatchlistSync(input: WatchlistSyncCommit): Promise<WatchlistSyncRun> {
    assertWatchlistSyncRunInvariants(input.run);
    if (input.run.status === 'running') {
      throw new InvariantError('commitWatchlistSync 只接受终态 run');
    }
    const candidateMap = new Map(
      input.candidates.map((candidate) => [candidate.stockId, candidate]),
    );
    if (candidateMap.size !== input.candidates.length) {
      throw new InvariantError('Watchlist sync candidates.stockId 必须唯一');
    }
    return this.db.transaction((tx) => {
      if (
        tx.select().from(watchlists).where(eq(watchlists.id, input.run.watchlistId)).get() ===
        undefined
      ) {
        throw new InvariantError(`Watchlist 不存在: ${input.run.watchlistId}`);
      }
      if (input.run.producerRunId !== undefined) {
        const existingRun = tx
          .select()
          .from(workflowRuns)
          .where(
            and(
              eq(workflowRuns.workflowName, WATCHLIST_SYNC_WORKFLOW),
              sql`json_extract(${workflowRuns.inputSummary}, '$.watchlistId') = ${input.run.watchlistId}`,
              sql`json_extract(${workflowRuns.inputSummary}, '$.sourceKey') = ${input.run.sourceKey}`,
              sql`json_extract(${workflowRuns.inputSummary}, '$.producerRunId') = ${input.run.producerRunId}`,
            ),
          )
          .get();
        if (existingRun !== undefined) return toSyncRun(existingRun);
      }
      const memberRows = tx
        .select()
        .from(watchlistMembers)
        .where(eq(watchlistMembers.watchlistId, input.run.watchlistId))
        .all();
      const membersByStock = new Map(memberRows.map((row) => [row.stockId, toMember(row)]));
      const membersById = new Map(memberRows.map((row) => [row.id, toMember(row)]));
      const memberIds = memberRows.map((row) => row.id);
      const currentRows =
        memberIds.length === 0
          ? []
          : tx
              .select()
              .from(watchlistMemberSources)
              .where(
                and(
                  inArray(watchlistMemberSources.memberId, memberIds),
                  eq(watchlistMemberSources.sourceKey, input.run.sourceKey),
                  ne(watchlistMemberSources.status, 'ended'),
                ),
              )
              .all();
      const existingByStock = new Map(
        currentRows.flatMap((row) => {
          const member = membersById.get(row.memberId);
          return member === undefined ? [] : [[member.stockId, toSource(row)] as const];
        }),
      );
      const now = input.run.finishedAt as Date;
      const changes: StoredSyncChange[] = [];
      let entered = 0;
      let unchanged = 0;
      let exited = 0;

      if (input.run.status !== 'complete' && currentRows.length > 0) {
        tx.update(watchlistMemberSources)
          .set({ status: 'stale' })
          .where(
            inArray(
              watchlistMemberSources.id,
              currentRows.map((row) => row.id),
            ),
          )
          .run();
      }

      for (const candidate of input.candidates) {
        let member = membersByStock.get(candidate.stockId);
        const current = existingByStock.get(candidate.stockId);
        const change = current === undefined ? 'entered' : 'unchanged';
        if (member === undefined) {
          member = {
            id: `${input.run.watchlistId}:${candidate.stockId}`,
            watchlistId: input.run.watchlistId,
            stockId: candidate.stockId,
            stage: input.reviveStage ?? 'discovered',
            priority: 'normal',
            firstAddedAt: now,
            lastActivityAt: now,
          };
        } else if (member.stage === 'archived') {
          member = {
            ...member,
            stage: input.reviveStage ?? 'discovered',
            lastActivityAt: now,
          };
          delete (member as { archivedAt?: Date }).archivedAt;
        } else {
          member = { ...member, lastActivityAt: now };
        }
        assertWatchlistMemberInvariants(member);
        tx.insert(watchlistMembers)
          .values(memberValues(member))
          .onConflictDoUpdate({
            target: watchlistMembers.id,
            set: {
              stage: member.stage,
              priority: member.priority,
              lastActivityAt: member.lastActivityAt,
              archivedAt: member.archivedAt ?? null,
            },
          })
          .run();
        membersByStock.set(member.stockId, member);
        membersById.set(member.id, member);
        const source: WatchlistMemberSource =
          current === undefined
            ? {
                id: `${input.run.id}:${member.id}:${input.run.sourceKey}`,
                memberId: member.id,
                kind: input.run.sourceKind,
                sourceKey: input.run.sourceKey,
                ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
                ...(input.sourceVersionId === undefined
                  ? {}
                  : { sourceVersionId: input.sourceVersionId }),
                syncRunId: input.run.id,
                reason: candidate.reason,
                ...(candidate.score === undefined ? {} : { score: candidate.score }),
                ...(candidate.rank === undefined ? {} : { rank: candidate.rank }),
                status: 'active',
                evidence: candidate.evidence,
                ...(candidate.dataAsOf === undefined ? {} : { dataAsOf: candidate.dataAsOf }),
                validFrom: now,
              }
            : {
                ...current,
                ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
                ...(input.sourceVersionId === undefined
                  ? {}
                  : { sourceVersionId: input.sourceVersionId }),
                syncRunId: input.run.id,
                reason: candidate.reason,
                status: 'active',
                evidence: candidate.evidence,
                ...(candidate.score === undefined ? {} : { score: candidate.score }),
                ...(candidate.rank === undefined ? {} : { rank: candidate.rank }),
                ...(candidate.dataAsOf === undefined ? {} : { dataAsOf: candidate.dataAsOf }),
              };
        assertWatchlistMemberSourceInvariants(source);
        tx.insert(watchlistMemberSources)
          .values(sourceValues(source))
          .onConflictDoUpdate({ target: watchlistMemberSources.id, set: sourceValues(source) })
          .run();
        changes.push({
          stockId: candidate.stockId,
          change,
          reason: candidate.reason,
          ...(candidate.score === undefined ? {} : { score: candidate.score }),
          ...(candidate.rank === undefined ? {} : { rank: candidate.rank }),
          evidence: [...candidate.evidence],
          ...(candidate.dataAsOf === undefined
            ? {}
            : { dataAsOf: candidate.dataAsOf.toISOString() }),
        });
        if (change === 'entered') entered += 1;
        else unchanged += 1;
      }

      // complete 结束所有未入选来源；partial 只结束 producer run 中已得到确定
      // 选择结论的股票，未评估股票保持 stale，避免用缺失数据制造退出。
      const evaluatedStockIds = new Set(input.evaluatedStockIds ?? []);
      for (const row of currentRows) {
        const source = toSource(row);
        const member = membersById.get(source.memberId);
        if (member === undefined || candidateMap.has(member.stockId)) continue;
        if (
          input.run.status !== 'complete' &&
          !(input.run.status === 'partial' && evaluatedStockIds.has(member.stockId))
        ) {
          continue;
        }
        tx.update(watchlistMemberSources)
          .set({ status: 'ended', validUntil: now })
          .where(eq(watchlistMemberSources.id, source.id))
          .run();
        changes.push({
          stockId: member.stockId,
          change: 'exited',
          reason:
            input.run.status === 'complete' ? '来源完整同步未再入选' : '来源已确认评估未再入选',
          evidence: [],
          ...(input.run.dataAsOf === undefined
            ? {}
            : { dataAsOf: input.run.dataAsOf.toISOString() }),
        });
        exited += 1;
        const other = tx
          .select({ id: watchlistMemberSources.id })
          .from(watchlistMemberSources)
          .where(
            and(
              eq(watchlistMemberSources.memberId, member.id),
              ne(watchlistMemberSources.status, 'ended'),
            ),
          )
          .get();
        if (other === undefined && member.stage === 'discovered') {
          tx.update(watchlistMembers)
            .set({ stage: 'archived', lastActivityAt: now, archivedAt: now })
            .where(eq(watchlistMembers.id, member.id))
            .run();
        }
      }

      const run: WatchlistSyncRun = {
        ...input.run,
        enteredCount: entered,
        exitedCount: exited,
        unchangedCount: unchanged,
      };
      assertWatchlistSyncRunInvariants(run);
      const runValues = toWorkflowRunValues(run, changes);
      tx.insert(workflowRuns)
        .values(runValues)
        .onConflictDoUpdate({ target: workflowRuns.id, set: runValues })
        .run();
      return run;
    });
  }
}
