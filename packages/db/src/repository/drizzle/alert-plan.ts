import { type AlertPlan, type AlertPlanRepository, assertAlertPlanInvariants } from '@luoome/core';
import { and, asc, eq } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { alertPlans, type Schema } from '../../schema/index.js';

type AlertPlanRow = typeof alertPlans.$inferSelect;

const toAlertPlan = (row: AlertPlanRow): AlertPlan => ({
  id: row.id,
  name: row.name,
  ...(row.description === null ? {} : { description: row.description }),
  watchlistId: row.watchlistId,
  rules: row.rules,
  logic: row.logic,
  triggerMode: row.triggerMode,
  ...(row.priority === null ? {} : { priority: row.priority }),
  cooldownMinutes: row.cooldownMinutes,
  dailyNotificationLimit: row.dailyNotificationLimit,
  notifyOnRecovery: row.notifyOnRecovery,
  enabled: row.enabled,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export class DrizzleAlertPlanRepository implements AlertPlanRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(plan: AlertPlan): Promise<void> {
    assertAlertPlanInvariants(plan);
    const values = {
      id: plan.id,
      name: plan.name,
      description: plan.description ?? null,
      watchlistId: plan.watchlistId,
      rules: plan.rules,
      logic: plan.logic,
      triggerMode: plan.triggerMode,
      priority: plan.priority ?? null,
      cooldownMinutes: plan.cooldownMinutes,
      dailyNotificationLimit: plan.dailyNotificationLimit,
      notifyOnRecovery: plan.notifyOnRecovery,
      enabled: plan.enabled,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    };
    this.db
      .insert(alertPlans)
      .values(values)
      .onConflictDoUpdate({
        target: alertPlans.id,
        set: {
          name: values.name,
          description: values.description,
          watchlistId: values.watchlistId,
          rules: values.rules,
          logic: values.logic,
          triggerMode: values.triggerMode,
          priority: values.priority,
          cooldownMinutes: values.cooldownMinutes,
          dailyNotificationLimit: values.dailyNotificationLimit,
          notifyOnRecovery: values.notifyOnRecovery,
          enabled: values.enabled,
          updatedAt: values.updatedAt,
        },
      })
      .run();
  }

  async findById(id: string): Promise<AlertPlan | null> {
    const row = this.db.select().from(alertPlans).where(eq(alertPlans.id, id)).get();
    return row === undefined ? null : toAlertPlan(row);
  }

  async list(
    filter: { readonly enabledOnly?: boolean; readonly watchlistId?: string } = {},
  ): Promise<readonly AlertPlan[]> {
    const conditions = [
      ...(filter.enabledOnly ? [eq(alertPlans.enabled, true)] : []),
      ...(filter.watchlistId === undefined ? [] : [eq(alertPlans.watchlistId, filter.watchlistId)]),
    ];
    const rows =
      conditions.length === 0
        ? this.db.select().from(alertPlans).orderBy(asc(alertPlans.id)).all()
        : this.db
            .select()
            .from(alertPlans)
            .where(and(...conditions))
            .orderBy(asc(alertPlans.id))
            .all();
    return rows.map(toAlertPlan);
  }

  async remove(id: string): Promise<void> {
    this.db.delete(alertPlans).where(eq(alertPlans.id, id)).run();
  }
}
