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
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import {
  membershipSnapshots,
  type Schema,
  watchlistMemberSources,
  watchlistMembers,
  watchlistSyncRuns,
  watchlists,
} from '../../schema/index.js';

type WatchlistRow = typeof watchlists.$inferSelect;
type MemberRow = typeof watchlistMembers.$inferSelect;
type SourceRow = typeof watchlistMemberSources.$inferSelect;
type RunRow = typeof watchlistSyncRuns.$inferSelect;
type SnapshotRow = typeof membershipSnapshots.$inferSelect;

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
  reason: row.reason,
  ...(row.score === null ? {} : { score: row.score }),
  ...(row.rank === null ? {} : { rank: row.rank }),
  status: row.status,
  evidence: [...row.evidence],
  ...(row.dataAsOf === null ? {} : { dataAsOf: row.dataAsOf }),
  validFrom: row.validFrom,
  ...(row.validUntil === null ? {} : { validUntil: row.validUntil }),
});

const toRun = (row: RunRow): WatchlistSyncRun => ({
  id: row.id,
  watchlistId: row.watchlistId,
  sourceKind: row.sourceKind,
  sourceKey: row.sourceKey,
  ...(row.producerRunId === null ? {} : { producerRunId: row.producerRunId }),
  status: row.status,
  ...(row.dataAsOf === null ? {} : { dataAsOf: row.dataAsOf }),
  startedAt: row.startedAt,
  ...(row.finishedAt === null ? {} : { finishedAt: row.finishedAt }),
  enteredCount: row.enteredCount,
  exitedCount: row.exitedCount,
  unchangedCount: row.unchangedCount,
  missingDimensions: [...row.missingDimensions],
  ...(row.error === null ? {} : { error: row.error }),
});

const toSnapshot = (row: SnapshotRow): MembershipSnapshot => ({
  id: row.id,
  syncRunId: row.syncRunId,
  stockId: row.stockId,
  selected: row.selected,
  change: row.change,
  reason: row.reason,
  ...(row.score === null ? {} : { score: row.score }),
  ...(row.rank === null ? {} : { rank: row.rank }),
  evidence: [...row.evidence],
  ...(row.dataAsOf === null ? {} : { dataAsOf: row.dataAsOf }),
});

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
  reason: source.reason,
  score: source.score ?? null,
  rank: source.rank ?? null,
  status: source.status,
  evidence: [...source.evidence],
  dataAsOf: source.dataAsOf ?? null,
  validFrom: source.validFrom,
  validUntil: source.validUntil ?? null,
});

const runValues = (run: WatchlistSyncRun) => ({
  id: run.id,
  watchlistId: run.watchlistId,
  sourceKind: run.sourceKind,
  sourceKey: run.sourceKey,
  producerRunId: run.producerRunId ?? null,
  status: run.status,
  dataAsOf: run.dataAsOf ?? null,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt ?? null,
  enteredCount: run.enteredCount,
  exitedCount: run.exitedCount,
  unchangedCount: run.unchangedCount,
  missingDimensions: [...run.missingDimensions],
  error: run.error ?? null,
});

const snapshotValues = (snapshot: MembershipSnapshot) => ({
  id: snapshot.id,
  syncRunId: snapshot.syncRunId,
  stockId: snapshot.stockId,
  selected: snapshot.selected,
  change: snapshot.change,
  reason: snapshot.reason,
  score: snapshot.score ?? null,
  rank: snapshot.rank ?? null,
  evidence: [...snapshot.evidence],
  dataAsOf: snapshot.dataAsOf ?? null,
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

  async saveSyncRun(run: WatchlistSyncRun): Promise<void> {
    assertWatchlistSyncRunInvariants(run);
    this.db
      .insert(watchlistSyncRuns)
      .values(runValues(run))
      .onConflictDoUpdate({ target: watchlistSyncRuns.id, set: runValues(run) })
      .run();
  }

  async saveSnapshots(rows: readonly MembershipSnapshot[]): Promise<void> {
    for (const row of rows) {
      MembershipSnapshotSchema.parse(row);
      if (
        this.db
          .select()
          .from(watchlistSyncRuns)
          .where(eq(watchlistSyncRuns.id, row.syncRunId))
          .get() === undefined
      ) {
        throw new InvariantError(`WatchlistSyncRun 不存在: ${row.syncRunId}`);
      }
      const values = snapshotValues(row);
      this.db
        .insert(membershipSnapshots)
        .values(values)
        .onConflictDoUpdate({
          target: [membershipSnapshots.syncRunId, membershipSnapshots.stockId],
          set: values,
        })
        .run();
    }
  }

  async listSyncRuns(watchlistId: string, limit = 50): Promise<readonly WatchlistSyncRun[]> {
    return this.db
      .select()
      .from(watchlistSyncRuns)
      .where(eq(watchlistSyncRuns.watchlistId, watchlistId))
      .orderBy(desc(watchlistSyncRuns.startedAt), desc(watchlistSyncRuns.id))
      .limit(limit)
      .all()
      .map(toRun);
  }

  async listSnapshots(syncRunId: string): Promise<readonly MembershipSnapshot[]> {
    return this.db
      .select()
      .from(membershipSnapshots)
      .where(eq(membershipSnapshots.syncRunId, syncRunId))
      .orderBy(asc(membershipSnapshots.stockId))
      .all()
      .map(toSnapshot);
  }

  async commitWatchlistSync(input: WatchlistSyncCommit): Promise<WatchlistSyncRun> {
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
      const snapshots: MembershipSnapshot[] = [];
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
        snapshots.push({
          id: `${input.run.id}:${candidate.stockId}`,
          syncRunId: input.run.id,
          stockId: candidate.stockId,
          selected: true,
          change,
          reason: candidate.reason,
          ...(candidate.score === undefined ? {} : { score: candidate.score }),
          ...(candidate.rank === undefined ? {} : { rank: candidate.rank }),
          evidence: candidate.evidence,
          ...(candidate.dataAsOf === undefined ? {} : { dataAsOf: candidate.dataAsOf }),
        });
        if (change === 'entered') entered += 1;
        else unchanged += 1;
      }

      if (input.run.status === 'complete') {
        for (const row of currentRows) {
          const source = toSource(row);
          const member = membersById.get(source.memberId);
          if (member === undefined || candidateMap.has(member.stockId)) continue;
          tx.update(watchlistMemberSources)
            .set({ status: 'ended', validUntil: now })
            .where(eq(watchlistMemberSources.id, source.id))
            .run();
          snapshots.push({
            id: `${input.run.id}:${member.stockId}`,
            syncRunId: input.run.id,
            stockId: member.stockId,
            selected: false,
            change: 'exited',
            reason: '来源完整同步未再入选',
            evidence: [],
            ...(input.run.dataAsOf === undefined ? {} : { dataAsOf: input.run.dataAsOf }),
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
      }

      const run: WatchlistSyncRun = {
        ...input.run,
        enteredCount: entered,
        exitedCount: exited,
        unchangedCount: unchanged,
      };
      assertWatchlistSyncRunInvariants(run);
      tx.insert(watchlistSyncRuns)
        .values(runValues(run))
        .onConflictDoUpdate({ target: watchlistSyncRuns.id, set: runValues(run) })
        .run();
      for (const snapshot of snapshots) {
        MembershipSnapshotSchema.parse(snapshot);
        tx.insert(membershipSnapshots)
          .values(snapshotValues(snapshot))
          .onConflictDoUpdate({
            target: [membershipSnapshots.syncRunId, membershipSnapshots.stockId],
            set: snapshotValues(snapshot),
          })
          .run();
      }
      return run;
    });
  }
}
