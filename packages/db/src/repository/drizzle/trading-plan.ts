import {
  type AccountFacts,
  accountFactsDigest,
  assertTradingPlanBudgetLimits,
  assertTradingPlanInvariants,
  assertTradingPlanReadable,
  evaluateTradingPlanBudget,
  type Stock,
  selectTradingPlans,
  type TradingPlan,
  type TradingPlanBudgetLimits,
  type TradingPlanQuery,
  type TradingPlanRepository,
  TradingPlanSchema,
  TradingPlanV2Schema,
  tradingPlanVersionId,
} from '@luoome/core';
import { and, asc, desc, eq, type SQL } from 'drizzle-orm';
import type { DrizzleDatabase } from '../../database.js';

import { accounts, holdings, type Schema, tradingPlans } from '../../schema/index.js';

type TradingPlanRow = typeof tradingPlans.$inferSelect;
type DrizzleTransaction = Parameters<Parameters<DrizzleDatabase<Schema>['transaction']>[0]>[0];

const toPlan = (row: TradingPlanRow): TradingPlan => assertTradingPlanReadable(row.plan);

/**
 * 事务内的「该计划当前最新版本」查询。
 *
 * **必须**接收事务句柄：用 `this.db` 或 `this.latestByPlanId` 会读到事务外的连接，
 * 让乐观锁退化成「先读后写」而失效（决策 3-A，见 `save` 的方法注释）。
 */
const latestRowInTransaction = (tx: DrizzleTransaction, planId: string): string => {
  const row = tx
    .select({ versionId: tradingPlans.versionId })
    .from(tradingPlans)
    .where(eq(tradingPlans.planId, planId))
    .orderBy(desc(tradingPlans.version), desc(tradingPlans.createdAt))
    .limit(1)
    .get();
  return row?.versionId ?? '';
};

const toRow = (plan: TradingPlan) => ({
  versionId: tradingPlanVersionId(plan),
  planId: plan.id,
  version: plan.version,
  accountId: plan.accountId,
  stockId: plan.stockId,
  status: plan.status,
  validFrom: plan.validFrom,
  validUntil: plan.validUntil,
  createdAt: plan.createdAt,
  plan,
});

export class DrizzleTradingPlanRepository implements TradingPlanRepository {
  constructor(private readonly db: DrizzleDatabase<Schema>) {}

  /**
   * 保存一个计划版本，可选启用乐观锁（决策 3-A）。
   *
   * ## 为什么必须是 `this.db.transaction((tx) => …)`
   *
   * 「读当前最新版 → 比对 → 写」三步如果在事务**外**做，两个并发调用会读到同一个旧基线、
   * 各自认为通过，然后都写入——这就是**假锁**：代码看起来有锁，实际没有。
   *
   * ## 为什么闭包里**不许**调用 `this.latestByPlanId(...)`
   *
   * `latestByPlanId` 绑在 `this.db` 上。在事务闭包里调用它，读的是**事务外**的连接——
   * 那正好就是「分两步读再写」的等价物，锁会失效，而且**看不出来**。
   * 所以下面用 `tx` 重写同一个查询（`where planId / order by version desc / limit 1`）。
   * `verifyOptimisticLockUsesTransaction`（见 `trading-plan.lock.guard.test.ts`）守住这条：
   * 谁把这里改成复用 `latestByPlanId`，那条测试会红。
   */
  async save(
    plan: TradingPlan,
    options: { readonly expectedRevision?: string } = {},
  ): ReturnType<TradingPlanRepository['save']> {
    const parsed = TradingPlanV2Schema.parse(plan);
    assertTradingPlanInvariants(parsed);
    const versionId = tradingPlanVersionId(parsed);
    const expectedRevision = options.expectedRevision;
    return this.db.transaction(
      (tx: DrizzleTransaction) => {
        const existing = tx
          .select()
          .from(tradingPlans)
          .where(eq(tradingPlans.versionId, versionId))
          .get();
        if (existing !== undefined) {
          const existingPlan = TradingPlanSchema.parse(existing.plan);
          if (JSON.stringify(existingPlan) !== JSON.stringify(parsed))
            return { saved: false, reason: 'version-immutable', actual: versionId } as const;
          // 同 versionId 同内容：幂等重放。基线检查同样适用（否则重放会绕过锁）。
          if (expectedRevision !== undefined) {
            const latest = latestRowInTransaction(tx, parsed.id);
            if (latest !== versionId)
              return {
                saved: false,
                reason: 'revision-conflict',
                actual: latest,
              } as const;
          }
          return { saved: true } as const;
        }
        if (expectedRevision !== undefined) {
          // ⚠️ 必须用 `tx`，不能用 `this.db` / `this.latestByPlanId`（见方法注释）。
          const latest = latestRowInTransaction(tx, parsed.id);
          if (latest !== expectedRevision)
            return { saved: false, reason: 'revision-conflict', actual: latest } as const;
        }
        tx.insert(tradingPlans).values(toRow(parsed)).run();
        return { saved: true } as const;
      },
      { behavior: 'immediate' },
    );
  }

  async saveIfBudgetAvailable(input: {
    readonly plan: TradingPlan;
    readonly facts: AccountFacts;
    readonly stocks: ReadonlyMap<string, Stock>;
    readonly limits: TradingPlanBudgetLimits;
    readonly asOf: Date;
    readonly expectedRevision?: string;
  }): ReturnType<TradingPlanRepository['saveIfBudgetAvailable']> {
    const plan = TradingPlanV2Schema.parse(input.plan);
    assertTradingPlanInvariants(plan);
    assertTradingPlanBudgetLimits(input.limits);
    return this.db.transaction(
      (tx: DrizzleTransaction) => {
        const account = tx.select().from(accounts).where(eq(accounts.id, plan.accountId)).get();
        // digest 口径必须与 deriveAccountFacts 一致：只含当前持仓（未平仓且数量大于 0），
        // 否则已平仓的历史行会让指纹永远不匹配，激活保存被永久拒绝。
        const currentHoldings = tx
          .select()
          .from(holdings)
          .where(eq(holdings.accountId, plan.accountId))
          .all()
          .filter((holding) => holding.closedAt === null && holding.quantity > 0);
        if (
          account === undefined ||
          accountFactsDigest({ account, holdings: currentHoldings }) !== input.facts.digest
        ) {
          return { saved: false, reason: 'account-facts-changed' } as const;
        }
        const rows = tx
          .select()
          .from(tradingPlans)
          .where(eq(tradingPlans.accountId, plan.accountId))
          .all();
        const currentPlans = selectTradingPlans(rows.map(toPlan), {
          activeOnly: true,
          asOf: input.asOf,
          limit: rows.length || 1,
        }).filter(
          (item) =>
            item.status === 'active' &&
            item.validFrom.getTime() <= input.asOf.getTime() &&
            item.validUntil.getTime() > input.asOf.getTime() &&
            item.accountFactsDigest === input.facts.digest &&
            item.id !== plan.id,
        );
        const budget = evaluateTradingPlanBudget({
          facts: input.facts,
          plans: [...currentPlans, plan],
          stocks: input.stocks,
          limits: input.limits,
        });
        const allocation = budget.allocations.find(
          (item) => item.planId === tradingPlanVersionId(plan),
        );
        if (allocation?.status !== 'included')
          return { saved: false, reason: 'budget-exceeded', budget } as const;
        const existing = rows.find((row) => row.versionId === tradingPlanVersionId(plan));
        if (existing !== undefined) {
          const existingPlan = toPlan(existing);
          // 版本不可变：同 versionId 不同内容。原先是抛错，现在改为返回值——
          // 调用方**必须**处理，静默当成功是行为松动（决策 3-A）。
          if (JSON.stringify(existingPlan) !== JSON.stringify(plan))
            return {
              saved: false,
              reason: 'version-immutable',
              actual: tradingPlanVersionId(plan),
            } as const;
        }
        // 乐观锁（决策 3-A）：比对与写入在同一事务内。**必须用 `tx`**，
        // 用 `this.db` / `this.latestByPlanId` 会读到事务外连接，锁会失效。
        if (input.expectedRevision !== undefined) {
          const latest = latestRowInTransaction(tx, plan.id);
          // 幂等重放（同 versionId 已存在且内容相同）不算冲突。
          if (latest !== input.expectedRevision && latest !== tradingPlanVersionId(plan))
            return { saved: false, reason: 'revision-conflict', actual: latest } as const;
        }
        if (existing === undefined) tx.insert(tradingPlans).values(toRow(plan)).run();
        return { saved: true, budget } as const;
      },
      { behavior: 'immediate' },
    );
  }

  async findByVersionId(versionId: string): Promise<TradingPlan | null> {
    const row = this.db
      .select()
      .from(tradingPlans)
      .where(eq(tradingPlans.versionId, versionId))
      .get();
    return row === undefined ? null : toPlan(row);
  }

  async list(query: TradingPlanQuery = {}): Promise<readonly TradingPlan[]> {
    const conditions: SQL[] = [];
    if (query.accountId !== undefined) conditions.push(eq(tradingPlans.accountId, query.accountId));
    if (query.stockId !== undefined) conditions.push(eq(tradingPlans.stockId, query.stockId));
    if (query.status !== undefined && query.activeOnly !== true && query.currentOnly !== true) {
      conditions.push(eq(tradingPlans.status, query.status));
    }
    const where = conditions.length === 0 ? undefined : and(...conditions);
    const plans = this.db
      .select()
      .from(tradingPlans)
      .where(where)
      .orderBy(
        desc(tradingPlans.createdAt),
        desc(tradingPlans.version),
        asc(tradingPlans.versionId),
      )
      .all()
      .map(toPlan);
    return selectTradingPlans(plans, query);
  }

  async latestByPlanId(planId: string): Promise<TradingPlan | null> {
    const row = this.db
      .select()
      .from(tradingPlans)
      .where(eq(tradingPlans.planId, planId))
      .orderBy(desc(tradingPlans.version), desc(tradingPlans.createdAt))
      .limit(1)
      .get();
    return row === undefined ? null : toPlan(row);
  }

  async remove(versionId: string): Promise<void> {
    this.db.delete(tradingPlans).where(eq(tradingPlans.versionId, versionId)).run();
  }
}
