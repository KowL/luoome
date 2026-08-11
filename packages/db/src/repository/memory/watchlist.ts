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

export class InMemoryWatchlistRepository implements WatchlistRepository {
  private readonly items = new Map<string, Watchlist>();

  async save(watchlist: Watchlist): Promise<void> {
    assertWatchlistInvariants(watchlist);
    this.items.set(watchlist.id, watchlist);
  }

  async findById(id: string): Promise<Watchlist | null> {
    return this.items.get(id) ?? null;
  }

  async list(
    filter: { readonly enabledOnly?: boolean; readonly kind?: Watchlist['kind'] } = {},
  ): Promise<readonly Watchlist[]> {
    return [...this.items.values()]
      .filter(
        (item) =>
          (!filter.enabledOnly || item.enabled) &&
          (filter.kind === undefined || item.kind === filter.kind),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async archive(id: string, at: Date): Promise<void> {
    const item = this.items.get(id);
    if (item === undefined) throw new InvariantError(`Watchlist 不存在: ${id}`);
    this.items.set(id, { ...item, enabled: false, updatedAt: at });
  }
}

export class InMemoryWatchlistMemberRepository implements WatchlistMemberRepository {
  private readonly members = new Map<string, WatchlistMember>();
  private readonly sources = new Map<string, WatchlistMemberSource>();
  private readonly runs = new Map<string, WatchlistSyncRun>();
  private readonly snapshots = new Map<string, MembershipSnapshot>();

  constructor(private readonly watchlists: WatchlistRepository) {}

  async saveMember(member: WatchlistMember): Promise<void> {
    assertWatchlistMemberInvariants(member);
    if ((await this.watchlists.findById(member.watchlistId)) === null) {
      throw new InvariantError(`Watchlist 不存在: ${member.watchlistId}`);
    }
    const duplicate = [...this.members.values()].find(
      (item) =>
        item.watchlistId === member.watchlistId &&
        item.stockId === member.stockId &&
        item.id !== member.id,
    );
    if (duplicate !== undefined) throw new InvariantError('(watchlistId, stockId) 必须唯一');
    this.members.set(member.id, member);
  }

  async findMember(watchlistId: string, stockId: string): Promise<WatchlistMember | null> {
    return (
      [...this.members.values()].find(
        (member) => member.watchlistId === watchlistId && member.stockId === stockId,
      ) ?? null
    );
  }

  async listMembers(
    watchlistId: string,
    filter: {
      readonly stage?: WatchlistMember['stage'];
      readonly priority?: WatchlistMember['priority'];
      readonly includeArchived?: boolean;
    } = {},
  ): Promise<readonly WatchlistMember[]> {
    return [...this.members.values()]
      .filter(
        (member) =>
          member.watchlistId === watchlistId &&
          (filter.includeArchived || member.stage !== 'archived') &&
          (filter.stage === undefined || member.stage === filter.stage) &&
          (filter.priority === undefined || member.priority === filter.priority),
      )
      .sort((left, right) => left.stockId.localeCompare(right.stockId));
  }

  async saveSource(source: WatchlistMemberSource): Promise<void> {
    assertWatchlistMemberSourceInvariants(source);
    if (!this.members.has(source.memberId)) {
      throw new InvariantError(`WatchlistMember 不存在: ${source.memberId}`);
    }
    if (source.status !== 'ended') {
      const duplicate = [...this.sources.values()].find(
        (item) =>
          item.memberId === source.memberId &&
          item.sourceKey === source.sourceKey &&
          item.status !== 'ended' &&
          item.id !== source.id,
      );
      if (duplicate !== undefined) {
        throw new InvariantError('(memberId, sourceKey) 只能有一个非 ended 来源');
      }
    }
    this.sources.set(source.id, source);
  }

  async listSources(
    memberId: string,
    includeEnded = false,
  ): Promise<readonly WatchlistMemberSource[]> {
    return [...this.sources.values()]
      .filter(
        (source) => source.memberId === memberId && (includeEnded || source.status !== 'ended'),
      )
      .sort(
        (left, right) =>
          right.validFrom.getTime() - left.validFrom.getTime() || right.id.localeCompare(left.id),
      );
  }

  async currentSource(memberId: string, sourceKey: string): Promise<WatchlistMemberSource | null> {
    return (
      [...this.sources.values()].find(
        (source) =>
          source.memberId === memberId &&
          source.sourceKey === sourceKey &&
          source.status !== 'ended',
      ) ?? null
    );
  }

  async commitManualMembers(
    rows: readonly {
      readonly member: WatchlistMember;
      readonly source: WatchlistMemberSource;
    }[],
  ): Promise<void> {
    const nextMembers = new Map(this.members);
    const nextSources = new Map(this.sources);
    for (const { member, source } of rows) {
      assertWatchlistMemberInvariants(member);
      assertWatchlistMemberSourceInvariants(source);
      if ((await this.watchlists.findById(member.watchlistId)) === null) {
        throw new InvariantError(`Watchlist 不存在: ${member.watchlistId}`);
      }
      if (source.memberId !== member.id || source.kind !== 'manual') {
        throw new InvariantError('手工成员来源必须引用同一 member 且 kind=manual');
      }
      const duplicate = [...nextMembers.values()].find(
        (item) =>
          item.watchlistId === member.watchlistId &&
          item.stockId === member.stockId &&
          item.id !== member.id,
      );
      if (duplicate !== undefined) throw new InvariantError('(watchlistId, stockId) 必须唯一');
      const current = [...nextSources.values()].find(
        (item) =>
          item.memberId === source.memberId &&
          item.sourceKey === source.sourceKey &&
          item.status !== 'ended',
      );
      if (current !== undefined && current.id !== source.id) {
        throw new InvariantError('(memberId, sourceKey) 只能有一个非 ended 来源');
      }
      nextMembers.set(member.id, member);
      nextSources.set(source.id, source);
    }
    this.members.clear();
    this.sources.clear();
    for (const [id, member] of nextMembers) this.members.set(id, member);
    for (const [id, source] of nextSources) this.sources.set(id, source);
  }

  async saveSyncRun(run: WatchlistSyncRun): Promise<void> {
    assertWatchlistSyncRunInvariants(run);
    if ((await this.watchlists.findById(run.watchlistId)) === null) {
      throw new InvariantError(`Watchlist 不存在: ${run.watchlistId}`);
    }
    this.runs.set(run.id, run);
  }

  async saveSnapshots(rows: readonly MembershipSnapshot[]): Promise<void> {
    for (const row of rows) {
      MembershipSnapshotSchema.parse(row);
      if (!this.runs.has(row.syncRunId)) {
        throw new InvariantError(`WatchlistSyncRun 不存在: ${row.syncRunId}`);
      }
      this.snapshots.set(`${row.syncRunId}\0${row.stockId}`, row);
    }
  }

  async listSyncRuns(watchlistId: string, limit = 50): Promise<readonly WatchlistSyncRun[]> {
    return [...this.runs.values()]
      .filter((run) => run.watchlistId === watchlistId)
      .sort(
        (left, right) =>
          right.startedAt.getTime() - left.startedAt.getTime() || right.id.localeCompare(left.id),
      )
      .slice(0, limit);
  }

  async listSnapshots(syncRunId: string): Promise<readonly MembershipSnapshot[]> {
    return [...this.snapshots.values()]
      .filter((snapshot) => snapshot.syncRunId === syncRunId)
      .sort((left, right) => left.stockId.localeCompare(right.stockId));
  }

  async commitWatchlistSync(input: WatchlistSyncCommit): Promise<WatchlistSyncRun> {
    if (input.run.status === 'running') {
      throw new InvariantError('commitWatchlistSync 只接受终态 run');
    }
    if ((await this.watchlists.findById(input.run.watchlistId)) === null) {
      throw new InvariantError(`Watchlist 不存在: ${input.run.watchlistId}`);
    }
    const candidates = new Map(input.candidates.map((candidate) => [candidate.stockId, candidate]));
    if (candidates.size !== input.candidates.length) {
      throw new InvariantError('Watchlist sync candidates.stockId 必须唯一');
    }

    const nextMembers = new Map(this.members);
    const nextSources = new Map(this.sources);
    const snapshots: MembershipSnapshot[] = [];
    const existing = [...nextSources.values()].filter((source) => {
      if (source.sourceKey !== input.run.sourceKey || source.status === 'ended') return false;
      return nextMembers.get(source.memberId)?.watchlistId === input.run.watchlistId;
    });
    const existingByStock = new Map(
      existing.flatMap((source) => {
        const member = nextMembers.get(source.memberId);
        return member === undefined ? [] : [[member.stockId, source] as const];
      }),
    );
    const now = input.run.finishedAt as Date;
    let entered = 0;
    let unchanged = 0;
    let exited = 0;

    if (input.run.status !== 'complete') {
      for (const source of existing) nextSources.set(source.id, { ...source, status: 'stale' });
    }

    for (const candidate of input.candidates) {
      let member = [...nextMembers.values()].find(
        (item) => item.watchlistId === input.run.watchlistId && item.stockId === candidate.stockId,
      );
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
          archivedAt: undefined,
        } as WatchlistMember;
      } else {
        member = { ...member, lastActivityAt: now };
      }
      assertWatchlistMemberInvariants(member);
      nextMembers.set(member.id, member);
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
              // 候选缺省时保留旧 score/rank/dataAsOf（与 drizzle 实现一致）。
              ...(candidate.score === undefined ? {} : { score: candidate.score }),
              ...(candidate.rank === undefined ? {} : { rank: candidate.rank }),
              ...(candidate.dataAsOf === undefined ? {} : { dataAsOf: candidate.dataAsOf }),
            };
      assertWatchlistMemberSourceInvariants(source);
      nextSources.set(source.id, source);
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
      for (const source of existing) {
        const member = nextMembers.get(source.memberId);
        if (member === undefined || candidates.has(member.stockId)) continue;
        nextSources.set(source.id, { ...source, status: 'ended', validUntil: now });
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
        const otherCurrent = [...nextSources.values()].some(
          (item) => item.memberId === member.id && item.status !== 'ended',
        );
        if (!otherCurrent && member.stage === 'discovered') {
          nextMembers.set(member.id, {
            ...member,
            stage: 'archived',
            lastActivityAt: now,
            archivedAt: now,
          });
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
    for (const snapshot of snapshots) MembershipSnapshotSchema.parse(snapshot);
    this.members.clear();
    for (const [id, member] of nextMembers) this.members.set(id, member);
    this.sources.clear();
    for (const [id, source] of nextSources) this.sources.set(id, source);
    this.runs.set(run.id, run);
    for (const snapshot of snapshots) {
      this.snapshots.set(`${snapshot.syncRunId}\0${snapshot.stockId}`, snapshot);
    }
    return run;
  }
}
