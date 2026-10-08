import {
  type AccountFacts,
  accountFactsDigest,
  assertTradingPlanBudgetLimits,
  assertTradingPlanInvariants,
  evaluateTradingPlanBudget,
  type Stock,
  selectTradingPlans,
  type TradingPlan,
  type TradingPlanBudgetLimits,
  type TradingPlanQuery,
  type TradingPlanRepository,
  TradingPlanSchema,
  tradingPlanVersionId,
} from '@luoome/core';
import type { InMemoryAccountRepository } from './account.js';
import type { InMemoryHoldingRepository } from './holding.js';

export class InMemoryTradingPlanRepository implements TradingPlanRepository {
  private readonly items = new Map<string, TradingPlan>();
  private budgetLock: Promise<void> = Promise.resolve();

  constructor(
    private readonly account: InMemoryAccountRepository,
    private readonly holding: InMemoryHoldingRepository,
  ) {}

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
  }): ReturnType<TradingPlanRepository['saveIfBudgetAvailable']> {
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
      const account = this.account.peek(plan.accountId);
      // digest 口径与 deriveAccountFacts 一致：只含当前持仓（未平仓且数量大于 0）。
      const currentHoldings = this.holding
        .snapshotByAccount(plan.accountId)
        .filter((holding) => holding.closedAt === null && holding.quantity > 0);
      if (
        account === null ||
        accountFactsDigest({
          account,
          holdings: currentHoldings,
        }) !== input.facts.digest
      ) {
        return { saved: false, reason: 'account-facts-changed' };
      }
      const active = selectTradingPlans(
        [...this.items.values()].filter((item) => item.accountId === plan.accountId),
        { activeOnly: true, asOf: input.asOf, limit: this.items.size || 1 },
      ).filter((item) => item.accountFactsDigest === input.facts.digest && item.id !== plan.id);
      const budget = evaluateTradingPlanBudget({
        facts: input.facts,
        plans: [...active, plan],
        stocks: input.stocks,
        limits: input.limits,
      });
      const allocation = budget.allocations.find(
        (item) => item.planId === tradingPlanVersionId(plan),
      );
      if (allocation?.status !== 'included')
        return { saved: false, reason: 'budget-exceeded', budget };
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
    return selectTradingPlans(filtered, query);
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
