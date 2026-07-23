import {
  assertWatchTriggerInvariants,
  type WatchRule,
  type WatchTrigger,
  type WatchTriggerRepository,
} from '@luoome/core';

/** WatchTrigger 的 in-memory 实现。Key 用 trigger.id；lastForKey 走 (poolId, stockId, ruleKind) 维度扫描。 */
export class InMemoryWatchTriggerRepository implements WatchTriggerRepository {
  private readonly items = new Map<string, WatchTrigger>();

  put(trigger: WatchTrigger): void {
    assertWatchTriggerInvariants(trigger);
    this.items.set(trigger.id, trigger);
  }

  async save(trigger: WatchTrigger): Promise<void> {
    this.put(trigger);
  }

  async findById(id: string): Promise<WatchTrigger | null> {
    return this.items.get(id) ?? null;
  }

  async listByPool(
    poolId: string,
    opts: { readonly since?: Date; readonly limit?: number } = {},
  ): Promise<readonly WatchTrigger[]> {
    const sinceMs = opts.since?.getTime() ?? Number.NEGATIVE_INFINITY;
    const limit = opts.limit ?? 200;
    return [...this.items.values()]
      .filter((t) => t.poolId === poolId && t.createdAt.getTime() >= sinceMs)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async lastForKey(
    key: {
      readonly poolId: string;
      readonly stockId: string;
      readonly ruleKind: WatchRule['kind'];
    },
    since: Date,
  ): Promise<WatchTrigger | null> {
    const sinceMs = since.getTime();
    const matches = [...this.items.values()]
      .filter(
        (t) =>
          t.poolId === key.poolId &&
          t.stockId === key.stockId &&
          t.ruleKind === key.ruleKind &&
          t.notified &&
          t.createdAt.getTime() >= sinceMs,
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return matches[0] ?? null;
  }

  async listRecent(
    opts: { readonly poolId?: string; readonly since?: Date; readonly limit?: number } = {},
  ): Promise<readonly WatchTrigger[]> {
    const sinceMs = opts.since?.getTime() ?? Number.NEGATIVE_INFINITY;
    const limit = opts.limit ?? 50;
    return [...this.items.values()]
      .filter((t) => {
        if (opts.poolId !== undefined && t.poolId !== opts.poolId) return false;
        if (t.createdAt.getTime() < sinceMs) return false;
        return true;
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async remove(id: string): Promise<void> {
    this.items.delete(id);
  }
}
