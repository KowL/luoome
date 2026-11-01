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
  TradingPlanV2Schema,
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
    const parsed = TradingPlanV2Schema.parse(plan);
    assertTradingPlanInvariants(parsed);
    const versionId = tradingPlanVersionId(parsed);
    const existing = this.items.get(versionId);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(parsed)) {
      throw new Error(`trading plan version is immutable: ${versionId}`);
    }
    this.items.set(versionId, parsed);
  }

  /**
   * 保存一个计划版本，可选启用乐观锁（决策 3-A）。
   *
   * memory 没有数据库事务，用与 `saveIfBudgetAvailable` 相同的串行化锁
   * （`withWriteLock`）模拟「同一事务内读 → 比对 → 写」：
   * 读和写都在锁内完成，两个并发调用不会读到同一个旧基线。
   */
  async save(
    plan: TradingPlan,
    options: { readonly expectedRevision?: string } = {},
  ): ReturnType<TradingPlanRepository['save']> {
    const expectedRevision = options.expectedRevision;
    return this.withWriteLock(() => {
      const parsed = TradingPlanV2Schema.parse(plan);
      assertTradingPlanInvariants(parsed);
      const versionId = tradingPlanVersionId(parsed);
      const existing = this.items.get(versionId);
      if (existing !== undefined) {
        if (JSON.stringify(existing) !== JSON.stringify(parsed)) {
          // 同 versionId 不同内容：判据是「有没有声明编辑基线」（与 drizzle 实现一致）：
          // - 传了 `expectedRevision` ⇒ 编辑会话，版本号撞车是并发 → `revision-conflict`
          // - 没传 ⇒ 非编辑会话，只可能是改写历史 → `version-immutable`
          if (expectedRevision !== undefined)
            return {
              saved: false,
              reason: 'revision-conflict',
              actual: this.latestVersionIdLocked(parsed.id),
            } as const;
          return { saved: false, reason: 'version-immutable', actual: versionId } as const;
        }
        // 幂等重放同样受基线检查约束，否则重放会绕过锁。
        if (expectedRevision !== undefined) {
          const latest = this.latestVersionIdLocked(parsed.id);
          if (latest !== versionId)
            return { saved: false, reason: 'revision-conflict', actual: latest } as const;
        }
        return { saved: true } as const;
      }
      if (expectedRevision !== undefined) {
        const latest = this.latestVersionIdLocked(parsed.id);
        if (latest !== expectedRevision)
          return { saved: false, reason: 'revision-conflict', actual: latest } as const;
      }
      this.items.set(versionId, parsed);
      return { saved: true } as const;
    });
  }

  /** 该计划当前最新版本 id；无版本时返回空串（与 drizzle 侧 `latestRowInTransaction` 对齐）。 */
  private latestVersionIdLocked(planId: string): string {
    const latest = [...this.items.values()]
      .filter((plan) => plan.id === planId)
      .sort((a, b) => b.version - a.version || b.createdAt.getTime() - a.createdAt.getTime())
      .at(0);
    return latest === undefined ? '' : tradingPlanVersionId(latest);
  }

  /** 串行化写：memory 侧的「事务」。读与写都必须在同一个临界区内完成。 */
  private async withWriteLock<T>(run: () => T): Promise<T> {
    const previous = this.budgetLock;
    let release!: () => void;
    this.budgetLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return run();
    } finally {
      release();
    }
  }

  async saveIfBudgetAvailable(input: {
    readonly plan: TradingPlan;
    readonly facts: AccountFacts;
    readonly stocks: ReadonlyMap<string, Stock>;
    readonly limits: TradingPlanBudgetLimits;
    readonly asOf: Date;
    readonly expectedRevision?: string;
  }): ReturnType<TradingPlanRepository['saveIfBudgetAvailable']> {
    const previous = this.budgetLock;
    let release!: () => void;
    this.budgetLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const plan = TradingPlanV2Schema.parse(input.plan);
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
      // 乐观锁（决策 3-A）：比对与写入都在同一临界区内，与 `save` 一致。
      // 版本不可变检查必须排在基线检查**之前**：同 versionId 不同内容是更强的事实。
      const existing = this.items.get(tradingPlanVersionId(plan));
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(plan))
        return {
          saved: false,
          reason: 'version-immutable',
          actual: tradingPlanVersionId(plan),
        };
      if (input.expectedRevision !== undefined) {
        const latest = this.latestVersionIdLocked(plan.id);
        const target = tradingPlanVersionId(plan);
        if (latest !== input.expectedRevision && latest !== target)
          return { saved: false, reason: 'revision-conflict', actual: latest };
      }
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
