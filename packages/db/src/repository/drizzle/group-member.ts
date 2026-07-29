import type { GroupMemberRepository, GroupMemberSnapshot } from '@luoome/core';
import { and, asc, desc, eq, gte } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { groupMemberSnapshots, type Schema } from '../../schema/index.js';

type GroupMemberRow = typeof groupMemberSnapshots.$inferSelect;

const toSnapshot = (row: GroupMemberRow): GroupMemberSnapshot => ({
  id: row.id,
  groupId: row.groupId,
  stockId: row.stockId,
  refreshId: row.refreshId,
  reason: row.reason,
  ...(row.score === null ? {} : { score: row.score }),
  evidence: [...row.evidence],
  ...(row.dataAsOf === null ? {} : { dataAsOf: row.dataAsOf }),
  ...(row.tacticId === null || row.signalTs === null
    ? {}
    : { tacticSignalRef: { tacticId: row.tacticId, ts: row.signalTs } }),
  createdAt: row.createdAt,
});

/**
 * 成员快照的 Drizzle 实现（docs/ddd/stock-group-design.md §1）。
 * 快照只增不改：saveBatch 同 id 冲突忽略；currentMembers = 最新 refreshId 那一批。
 */
export class DrizzleGroupMemberRepository implements GroupMemberRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async saveBatch(snapshots: readonly GroupMemberSnapshot[]): Promise<void> {
    if (snapshots.length === 0) return;
    this.db
      .insert(groupMemberSnapshots)
      .values(
        snapshots.map((s) => ({
          id: s.id,
          groupId: s.groupId,
          stockId: s.stockId,
          refreshId: s.refreshId,
          reason: s.reason,
          ...(s.score === undefined ? {} : { score: s.score }),
          evidence: s.evidence,
          ...(s.dataAsOf === undefined ? {} : { dataAsOf: s.dataAsOf }),
          ...(s.tacticSignalRef === undefined
            ? {}
            : { tacticId: s.tacticSignalRef.tacticId, signalTs: s.tacticSignalRef.ts }),
          createdAt: s.createdAt,
        })),
      )
      .onConflictDoNothing()
      .run();
  }

  async latestRefreshId(groupId: string): Promise<string | null> {
    const row = this.db
      .select({ refreshId: groupMemberSnapshots.refreshId })
      .from(groupMemberSnapshots)
      .where(eq(groupMemberSnapshots.groupId, groupId))
      .orderBy(desc(groupMemberSnapshots.createdAt), desc(groupMemberSnapshots.id))
      .limit(1)
      .get();
    return row?.refreshId ?? null;
  }

  async currentMembers(groupId: string): Promise<readonly GroupMemberSnapshot[]> {
    const refreshId = await this.latestRefreshId(groupId);
    if (refreshId === null) return [];
    return this.db
      .select()
      .from(groupMemberSnapshots)
      .where(
        and(
          eq(groupMemberSnapshots.groupId, groupId),
          eq(groupMemberSnapshots.refreshId, refreshId),
        ),
      )
      .orderBy(asc(groupMemberSnapshots.stockId))
      .all()
      .map(toSnapshot);
  }

  async listHistory(groupId: string, since?: Date): Promise<readonly GroupMemberSnapshot[]> {
    const where =
      since !== undefined
        ? and(eq(groupMemberSnapshots.groupId, groupId), gte(groupMemberSnapshots.createdAt, since))
        : eq(groupMemberSnapshots.groupId, groupId);
    return this.db
      .select()
      .from(groupMemberSnapshots)
      .where(where)
      .orderBy(desc(groupMemberSnapshots.createdAt), desc(groupMemberSnapshots.id))
      .all()
      .map(toSnapshot);
  }
}
