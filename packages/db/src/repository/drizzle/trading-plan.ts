import {
  assertTradingPlanInvariants,
  type TradingPlan,
  type TradingPlanQuery,
  type TradingPlanRepository,
  TradingPlanSchema,
  tradingPlanVersionId,
} from '@luoome/core';
import { and, asc, desc, eq, type SQL } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { type Schema, tradingPlans } from '../../schema/index.js';

type TradingPlanRow = typeof tradingPlans.$inferSelect;

const toPlan = (row: TradingPlanRow): TradingPlan => {
  const plan = TradingPlanSchema.parse(row.plan);
  assertTradingPlanInvariants(plan);
  return plan;
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
    this.db
      .insert(tradingPlans)
      .values({
        versionId,
        planId: parsed.id,
        version: parsed.version,
        accountId: parsed.accountId,
        stockId: parsed.stockId,
        status: parsed.status,
        validFrom: parsed.validFrom,
        validUntil: parsed.validUntil,
        createdAt: parsed.createdAt,
        plan: parsed,
      })
      .run();
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
      const latest = new Map<string, TradingPlan>();
      for (const plan of plans) {
        if (!latest.has(plan.id)) latest.set(plan.id, plan);
      }
      return [...latest.values()]
        .filter((plan) => plan.status === 'active')
        .filter((plan) => query.status === undefined || plan.status === query.status)
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
