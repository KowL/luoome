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
import { and, asc, desc, eq, type SQL } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { type Schema, tradingPlans } from '../../schema/index.js';

type TradingPlanRow = typeof tradingPlans.$inferSelect;
type DrizzleTransaction = Parameters<Parameters<BunSQLiteDatabase<Schema>['transaction']>[0]>[0];

const toPlan = (row: TradingPlanRow): TradingPlan => {
  const plan = TradingPlanSchema.parse(row.plan);
  assertTradingPlanInvariants(plan);
  return plan;
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

const latestByPlan = (plans: readonly TradingPlan[]): TradingPlan[] => {
  const latest = new Map<string, TradingPlan>();
  for (const plan of plans) {
    const current = latest.get(plan.id);
    if (
      current === undefined ||
      plan.version > current.version ||
      (plan.version === current.version && plan.createdAt > current.createdAt)
    ) {
      latest.set(plan.id, plan);
    }
  }
  return [...latest.values()];
};

export class DrizzleTradingPlanRepository implements TradingPlanRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(plan: TradingPlan): Promise<void> {
    const parsed = TradingPlanSchema.parse(plan);
    assertTradingPlanInvariants(parsed);
    const versionId = tradingPlanVersionId(parsed);
    const existing = this.db
      .select()
      .from(tradingPlans)
      .where(eq(tradingPlans.versionId, versionId))
      .get();
    if (existing !== undefined) {
      const existingPlan = TradingPlanSchema.parse(existing.plan);
      if (JSON.stringify(existingPlan) !== JSON.stringify(parsed)) {
        throw new Error(`trading plan version is immutable: ${versionId}`);
      }
      return;
    }
    this.db.insert(tradingPlans).values(toRow(parsed)).run();
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
    const plan = TradingPlanSchema.parse(input.plan);
    assertTradingPlanInvariants(plan);
    assertTradingPlanBudgetLimits(input.limits);
    return this.db.transaction(
      (tx: DrizzleTransaction) => {
        const rows = tx
          .select()
          .from(tradingPlans)
          .where(eq(tradingPlans.accountId, plan.accountId))
          .all();
        const currentPlans = latestByPlan(rows.map(toPlan)).filter(
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
        if (allocation?.status !== 'included') return { saved: false, budget };
        const existing = rows.find((row) => row.versionId === tradingPlanVersionId(plan));
        if (existing !== undefined) {
          const existingPlan = toPlan(existing);
          if (JSON.stringify(existingPlan) !== JSON.stringify(plan)) {
            throw new Error(`trading plan version is immutable: ${tradingPlanVersionId(plan)}`);
          }
          return { saved: true, budget };
        }
        tx.insert(tradingPlans).values(toRow(plan)).run();
        return { saved: true, budget };
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
    if (query.status !== undefined && query.activeOnly !== true) {
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
    if (query.activeOnly === true) {
      // 解析「当前生效版本」：从新到旧找每个计划第一个 active 版本。
      // - 更新的 superseded / revoked / expired 表示该计划已被明确退役 → 不再监控；
      // - 更新的 draft 只是「这次没能发布」（例如非交易日跑到、行情不合格），
      //   不能顶掉仍然有效、正在监控的生效版本，否则该标的会静默失去止损/目标价监控。
      const chosen = new Map<string, TradingPlan>();
      const retired = new Set<string>();
      for (const plan of plans) {
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
    return plans.slice(0, query.limit ?? 100);
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
