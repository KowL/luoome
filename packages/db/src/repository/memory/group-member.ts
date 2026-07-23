import type { GroupMemberRepository, GroupMemberSnapshot } from '@luoome/core';

/**
 * 成员快照的 in-memory 实现。Key 用 snapshot.id。
 * 语义与 Drizzle 实现对齐：currentMembers = 最新 refreshId 那一批（按 stockId 升序）。
 */
export class InMemoryGroupMemberRepository implements GroupMemberRepository {
  private readonly items = new Map<string, GroupMemberSnapshot>();

  put(snapshot: GroupMemberSnapshot): void {
    this.items.set(snapshot.id, snapshot);
  }

  async saveBatch(snapshots: readonly GroupMemberSnapshot[]): Promise<void> {
    for (const s of snapshots) this.items.set(s.id, s);
  }

  async latestRefreshId(groupId: string): Promise<string | null> {
    let best: GroupMemberSnapshot | null = null;
    for (const s of this.items.values()) {
      if (s.groupId !== groupId) continue;
      if (
        best === null ||
        s.createdAt.getTime() > best.createdAt.getTime() ||
        (s.createdAt.getTime() === best.createdAt.getTime() && s.id > best.id)
      ) {
        best = s;
      }
    }
    return best?.refreshId ?? null;
  }

  async currentMembers(groupId: string): Promise<readonly GroupMemberSnapshot[]> {
    const refreshId = await this.latestRefreshId(groupId);
    if (refreshId === null) return [];
    return [...this.items.values()]
      .filter((s) => s.groupId === groupId && s.refreshId === refreshId)
      .sort((a, b) => a.stockId.localeCompare(b.stockId));
  }

  async listHistory(groupId: string, since?: Date): Promise<readonly GroupMemberSnapshot[]> {
    return [...this.items.values()]
      .filter(
        (s) =>
          s.groupId === groupId &&
          (since === undefined || s.createdAt.getTime() >= since.getTime()),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
  }
}
