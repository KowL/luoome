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
      // 解析「当前生效版本」：从新到旧找每个计划第一个 active 版本。
      // - 更新的 superseded / revoked / expired 表示该计划已被明确退役 → 不再监控；
      // - 更新的 draft 只是「这次没能发布」（例如非交易日跑到、行情不合格），
      //   不能顶掉仍然有效、正在监控的生效版本，否则该标的会静默失去止损/目标价监控。
      const chosen = new Map<string, TradingPlan>();
      const retired = new Set<string>();
      for (const plan of filtered) {
        if (chosen.has(plan.id) || retired.has(plan.id)) continue;
        if (plan.status === 'active') {
          chosen.set(plan.id, plan);
          continue;
        }
        if (plan.status !== 'draft') retired.add(plan.id);
      }
      return [...chosen.values()]
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
