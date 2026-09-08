import {
  assertTradingPlanInvariants,
  type TradingPlan,
  type TradingPlanQuery,
  type TradingPlanRepository,
  TradingPlanSchema,
  tradingPlanVersionId,
} from '@luoome/core';

export class InMemoryTradingPlanRepository implements TradingPlanRepository {
  private readonly items = new Map<string, TradingPlan>();

  put(plan: TradingPlan): void {
    const parsed = TradingPlanSchema.parse(plan);
    assertTradingPlanInvariants(parsed);
    const versionId = tradingPlanVersionId(parsed);
    const existing = this.items.get(versionId);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(parsed)) {
      throw new Error(`trading plan version is immutable: ${versionId}`);
    }
    this.items.set(versionId, parsed);
  }

  async save(plan: TradingPlan): Promise<void> {
    this.put(plan);
  }

  async findByVersionId(versionId: string): Promise<TradingPlan | null> {
    return this.items.get(versionId) ?? null;
  }

  async list(query: TradingPlanQuery = {}): Promise<readonly TradingPlan[]> {
    const filtered = [...this.items.values()]
      .filter((plan) => query.accountId === undefined || plan.accountId === query.accountId)
      .filter((plan) => query.stockId === undefined || plan.stockId === query.stockId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.version - a.version);
    if (query.activeOnly === true) {
      const latest = new Map<string, TradingPlan>();
      for (const plan of filtered) {
        if (!latest.has(plan.id)) latest.set(plan.id, plan);
      }
      return [...latest.values()]
        .filter((plan) => plan.status === 'active')
        .filter((plan) => query.status === undefined || plan.status === query.status)
        .slice(0, query.limit ?? 100);
    }
    return filtered
      .filter((plan) => query.status === undefined || plan.status === query.status)
      .slice(0, query.limit ?? 100);
  }

  async latestByPlanId(planId: string): Promise<TradingPlan | null> {
    return (
      [...this.items.values()]
        .filter((plan) => plan.id === planId)
        .sort((a, b) => b.version - a.version || b.createdAt.getTime() - a.createdAt.getTime())
        .at(0) ?? null
    );
  }

  async remove(versionId: string): Promise<void> {
    this.items.delete(versionId);
  }
}
