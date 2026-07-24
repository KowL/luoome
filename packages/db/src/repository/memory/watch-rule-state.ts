import type { WatchRuleState, WatchRuleStateRepository } from '@luoome/core';

/** WatchRuleState in-memory 实现。Key = (poolId, stockId, ruleId) 组合。 */
export class InMemoryWatchRuleStateRepository implements WatchRuleStateRepository {
  private readonly items = new Map<string, WatchRuleState>();

  private static key(s: WatchRuleState): string {
    return `${s.poolId}|${s.stockId}|${s.ruleId}`;
  }

  async listByPool(poolId: string): Promise<readonly WatchRuleState[]> {
    return [...this.items.values()].filter((s) => s.poolId === poolId);
  }

  async upsert(state: WatchRuleState): Promise<void> {
    this.items.set(InMemoryWatchRuleStateRepository.key(state), state);
  }

  async upsertMany(states: readonly WatchRuleState[]): Promise<void> {
    for (const s of states) {
      this.items.set(InMemoryWatchRuleStateRepository.key(s), s);
    }
  }

  async removeByPool(poolId: string): Promise<void> {
    for (const [k, v] of this.items) {
      if (v.poolId === poolId) this.items.delete(k);
    }
  }
}
