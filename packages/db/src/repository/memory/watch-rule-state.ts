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
    // alertPlanId 缺省时回填 poolId（与 drizzle 写入语义一致）。
    const stored =
      state.alertPlanId === undefined ? { ...state, alertPlanId: state.poolId } : state;
    this.items.set(InMemoryWatchRuleStateRepository.key(stored), stored);
  }

  async upsertMany(states: readonly WatchRuleState[]): Promise<void> {
    for (const s of states) {
      await this.upsert(s);
    }
  }

  async removeByPool(poolId: string): Promise<void> {
    for (const [k, v] of this.items) {
      if (v.poolId === poolId) this.items.delete(k);
    }
  }
}
