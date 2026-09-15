import {
  type AccountFacts,
  assertTradingPlanBudgetLimits,
  assertTradingPlanInvariants,
  evaluateTradingPlanBudget,
  type Stock,
  type TradingPlan,
  type TradingPlanBudgetLimits,
  type TradingPlanQuery,
  type TradingPlanRepository,
  TradingPlanSchema,
  tradingPlanVersionId,
} from '@luoome/core';

export class InMemoryTradingPlanRepository implements TradingPlanRepository {
  private readonly items = new Map<string, TradingPlan>();
  private budgetLock: Promise<void> = Promise.resolve();

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

  async saveIfBudgetAvailable(input: {
    readonly plan: TradingPlan;
    readonly facts: AccountFacts;
    readonly stocks: ReadonlyMap<string, Stock>;
    readonly limits: TradingPlanBudgetLimits;
    readonly asOf: Date;
  }): Promise<{
    readonly saved: boolean;
    readonly budget: ReturnType<typeof evaluateTradingPlanBudget>;
  }> {
    const previous = this.budgetLock;
    let release!: () => void;
    this.budgetLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const plan = TradingPlanSchema.parse(input.plan);
      assertTradingPlanInvariants(plan);
      assertTradingPlanBudgetLimits(input.limits);
      const latest = new Map<string, TradingPlan>();
      for (const item of this.items.values()) {
        if (item.accountId !== plan.accountId) continue;
        const current = latest.get(item.id);
        if (
          current === undefined ||
          item.version > current.version ||
          (item.version === current.version && item.createdAt > current.createdAt)
        ) {
          latest.set(item.id, item);
        }
      }
      const active = [...latest.values()].filter(
        (item) =>
          item.status === 'active' &&
          item.validFrom.getTime() <= input.asOf.getTime() &&
          item.validUntil.getTime() > input.asOf.getTime() &&
          item.accountFactsDigest === input.facts.digest &&
          item.id !== plan.id,
      );
      const budget = evaluateTradingPlanBudget({
        facts: input.facts,
        plans: [...active, plan],
        stocks: input.stocks,
        limits: input.limits,
      });
      const allocation = budget.allocations.find(
        (item) => item.planId === tradingPlanVersionId(plan),
      );
      if (allocation?.status !== 'included') return { saved: false, budget };
      this.put(plan);
      return { saved: true, budget };
    } finally {
      release();
    }
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
        .filter(
          (plan) =>
            query.asOf === undefined ||
            (plan.validFrom.getTime() <= query.asOf.getTime() &&
              plan.validUntil.getTime() > query.asOf.getTime()),
        )
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
