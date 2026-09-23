import {
  ATTEMPTED_DELIVERY_STATUSES,
  assertWatchTriggerInvariants,
  type DeliveryStatus,
  WatchRuleStateSchema,
  type WatchTrigger,
  type WatchTriggerRepository,
  type WatchTriggerSummary,
} from '@luoome/core';
import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNull,
  lte,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { type Schema, watchExecutionLease, watchTriggers } from '../../schema/index.js';
import { DrizzleWatchRuleStateRepository } from './watch-rule-state.js';

// drizzle inArray 对 narrow text 列 + 联合字符串入参的泛型不匹配；改用 or(eq,...) 等价（语义不变）。
const inAttempted = (): SQL => {
  const conditions = (ATTEMPTED_DELIVERY_STATUSES as readonly string[]).map((v) =>
    eq(watchTriggers.deliveryStatus, v),
  );
  return combineConditions(conditions);
};
const inDeliveryStatuses = (values: readonly DeliveryStatus[]): SQL => {
  if (values.length === 0) return eq(watchTriggers.deliveryStatus, '__none__');
  const conditions = values.map((v) => eq(watchTriggers.deliveryStatus, v));
  return combineConditions(conditions);
};

const combineConditions = (conditions: readonly SQL[]): SQL => {
  const [first, ...rest] = conditions;
  if (first === undefined) throw new Error('SQL filter requires at least one condition');
  if (rest.length === 0) return first;
  const combined = or(first, ...rest);
  if (combined === undefined) throw new Error('failed to combine SQL filter conditions');
  return combined;
};

type TriggerRow = typeof watchTriggers.$inferSelect;

const toWatchTrigger = (row: TriggerRow): WatchTrigger => ({
  id: row.id,
  ...(row.alertPlanId === null ? {} : { alertPlanId: row.alertPlanId }),
  poolId: row.poolId,
  stockId: row.stockId,
  ruleKind: row.ruleKind,
  ruleId: row.ruleId,
  ...(row.eventId !== null ? { eventId: row.eventId } : {}),
  direction: row.direction,
  triggerType: row.triggerType as WatchTrigger['triggerType'],
  reason: row.reason,
  evidence: [...row.evidence],
  ...(row.quoteClose !== null && row.quoteTs !== null
    ? { quote: { close: row.quoteClose, ts: row.quoteTs } }
    : {}),
  priority: row.priority as WatchTrigger['priority'],
  deliveryStatus: row.deliveryStatus as DeliveryStatus,
  ...(row.notificationId !== null ? { notificationId: row.notificationId } : {}),
  ...(row.deliveryAttempts === null ? {} : { deliveryAttempts: row.deliveryAttempts }),
  ...(row.lastDeliveryAttemptAt === null
    ? {}
    : { lastDeliveryAttemptAt: row.lastDeliveryAttemptAt }),
  evalSnapshot: row.evalSnapshot as Record<string, unknown>,
  ...(row.feedback !== null ? { feedback: row.feedback as WatchTrigger['feedback'] & string } : {}),
  ...(row.feedbackAt !== null ? { feedbackAt: row.feedbackAt } : {}),
  notified: row.notified,
  createdAt: row.createdAt,
});

const ATTEMPTED: readonly DeliveryStatus[] = [...ATTEMPTED_DELIVERY_STATUSES];

/**
 * 策略预警 Drizzle 实现（docs/ddd/strategy-watchlist-unification-detailed-design.md §9.3）：
 * - lastForKey 改用 ruleId 维度 + deliveryStatus ∈ ATTEMPTED 过滤
 * - 新增 countAttemptedSince / setDeliveryStatus / setFeedback
 * - save 写新字段（含 deliveryStatus / priority / evalSnapshot 等）
 */
export class DrizzleWatchTriggerRepository implements WatchTriggerRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async commitEvaluation(
    input: Parameters<WatchTriggerRepository['commitEvaluation']>[0],
  ): Promise<boolean> {
    for (const trigger of input.triggers) assertWatchTriggerInvariants(trigger);
    for (const state of input.states) WatchRuleStateSchema.parse(state);
    return this.db.transaction((tx) => {
      const lease = tx
        .select()
        .from(watchExecutionLease)
        .where(
          and(eq(watchExecutionLease.owner, input.owner), gt(watchExecutionLease.until, input.now)),
        )
        .get();
      if (!lease) return false;
      const triggers = new DrizzleWatchTriggerRepository(tx);
      const states = new DrizzleWatchRuleStateRepository(tx);
      for (const trigger of input.triggers) triggers.put(trigger);
      for (const state of input.states) states.put(state);
      return true;
    });
  }

  async acquireExecution(owner: string, now: Date, until: Date): Promise<boolean> {
    return (
      this.db
        .insert(watchExecutionLease)
        .values({ id: 'watch', owner, until })
        .onConflictDoUpdate({
          target: watchExecutionLease.id,
          set: { owner, until },
          setWhere: lte(watchExecutionLease.until, now),
        })
        .returning()
        .all().length === 1
    );
  }

  async renewExecution(owner: string, now: Date, until: Date): Promise<boolean> {
    return (
      this.db
        .update(watchExecutionLease)
        .set({ until })
        .where(
          and(
            eq(watchExecutionLease.id, 'watch'),
            eq(watchExecutionLease.owner, owner),
            gt(watchExecutionLease.until, now),
          ),
        )
        .returning()
        .all().length === 1
    );
  }

  async releaseExecution(owner: string): Promise<void> {
    this.db.delete(watchExecutionLease).where(eq(watchExecutionLease.owner, owner)).run();
  }

  async beginDelivery(ids: readonly string[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    this.db
      .update(watchTriggers)
      .set({
        deliveryStatus: 'pending',
        deliveryAttempts: sql`coalesce(${watchTriggers.deliveryAttempts}, case when ${inAttempted()} then 1 else 0 end) + 1`,
        lastDeliveryAttemptAt: at,
      })
      .where(inArray(watchTriggers.id, [...ids]))
      .run();
  }

  async save(trigger: WatchTrigger): Promise<void> {
    this.put(trigger);
  }

  private put(trigger: WatchTrigger): void {
    assertWatchTriggerInvariants(trigger);
    this.db
      .insert(watchTriggers)
      .values({
        id: trigger.id,
        alertPlanId: trigger.alertPlanId ?? trigger.poolId,
        poolId: trigger.poolId,
        stockId: trigger.stockId,
        ruleKind: trigger.ruleKind,
        ruleId: trigger.ruleId,
        eventId: trigger.eventId ?? null,
        direction: trigger.direction,
        triggerType: trigger.triggerType,
        reason: trigger.reason,
        evidence: [...trigger.evidence],
        quoteClose: trigger.quote?.close ?? null,
        quoteTs: trigger.quote?.ts ?? null,
        priority: trigger.priority,
        deliveryStatus: trigger.deliveryStatus,
        notificationId: trigger.notificationId ?? null,
        deliveryAttempts: trigger.deliveryAttempts ?? null,
        lastDeliveryAttemptAt: trigger.lastDeliveryAttemptAt ?? null,
        evalSnapshot: trigger.evalSnapshot,
        feedback: trigger.feedback ?? null,
        feedbackAt: trigger.feedbackAt ?? null,
        notified: trigger.notified,
        createdAt: trigger.createdAt,
      })
      .onConflictDoUpdate({
        target: watchTriggers.id,
        set: {
          reason: trigger.reason,
          evidence: [...trigger.evidence],
          quoteClose: trigger.quote?.close ?? null,
          quoteTs: trigger.quote?.ts ?? null,
          priority: trigger.priority,
          deliveryStatus: trigger.deliveryStatus,
          notificationId: trigger.notificationId ?? null,
          deliveryAttempts: trigger.deliveryAttempts ?? null,
          lastDeliveryAttemptAt: trigger.lastDeliveryAttemptAt ?? null,
          evalSnapshot: trigger.evalSnapshot,
          notified: trigger.notified,
        },
      })
      .run();
  }

  async findById(id: string): Promise<WatchTrigger | null> {
    const row = this.db.select().from(watchTriggers).where(eq(watchTriggers.id, id)).get();
    return row === undefined ? null : toWatchTrigger(row);
  }

  async listByPool(
    poolId: string,
    opts: { readonly since?: Date; readonly limit?: number } = {},
  ): Promise<readonly WatchTrigger[]> {
    const conditions: SQL[] = [eq(watchTriggers.poolId, poolId)];
    if (opts.since !== undefined) conditions.push(gte(watchTriggers.createdAt, opts.since));
    const where = and(...conditions);
    const limit = opts.limit ?? 200;
    return this.db
      .select()
      .from(watchTriggers)
      .where(where)
      .orderBy(desc(watchTriggers.createdAt))
      .limit(limit)
      .all()
      .map(toWatchTrigger);
  }

  async lastForKey(
    key: { readonly poolId: string; readonly stockId: string; readonly ruleId: string },
    since: Date,
  ): Promise<WatchTrigger | null> {
    const row = this.db
      .select()
      .from(watchTriggers)
      .where(
        and(
          eq(watchTriggers.poolId, key.poolId),
          eq(watchTriggers.stockId, key.stockId),
          eq(watchTriggers.ruleId, key.ruleId),
          inAttempted(),
          gte(watchTriggers.createdAt, since),
        ),
      )
      .orderBy(desc(watchTriggers.createdAt))
      .get();
    return row === undefined ? null : toWatchTrigger(row);
  }

  async query(input: Parameters<WatchTriggerRepository['query']>[0]) {
    const conditions: SQL[] = [];
    if (input.alertPlanId !== undefined)
      conditions.push(
        sql`coalesce(${watchTriggers.alertPlanId}, ${watchTriggers.poolId}) = ${input.alertPlanId}`,
      );
    for (const key of [
      'poolId',
      'stockId',
      'ruleKind',
      'ruleId',
      'notified',
      'priority',
      'triggerType',
    ] as const) {
      const value = input[key];
      if (value !== undefined) conditions.push(eq(watchTriggers[key], value));
    }
    if (input.feedback !== undefined)
      conditions.push(
        input.feedback === 'unreviewed'
          ? isNull(watchTriggers.feedback)
          : eq(watchTriggers.feedback, input.feedback),
      );
    if (input.deliveryStatus !== undefined)
      conditions.push(inDeliveryStatuses(input.deliveryStatus));
    if (input.since !== undefined) conditions.push(gte(watchTriggers.createdAt, input.since));
    if (input.until !== undefined) conditions.push(lte(watchTriggers.createdAt, input.until));
    const where = and(...conditions);
    return this.db.transaction((tx) => {
      const total =
        tx.select({ value: count() }).from(watchTriggers).where(where).get()?.value ?? 0;
      const triggers = tx
        .select()
        .from(watchTriggers)
        .where(where)
        .orderBy(
          ...(input.orderBy === 'priority'
            ? [
                sql`case ${watchTriggers.priority} when 'urgent' then 0 when 'important' then 1 else 2 end`,
              ]
            : []),
          desc(watchTriggers.createdAt),
          desc(watchTriggers.id),
        )
        .limit(input.limit)
        .offset(input.offset)
        .all()
        .map(toWatchTrigger);
      let summary: WatchTriggerSummary | undefined;
      if (input.includeSummary) {
        const distribution = (
          column:
            | typeof watchTriggers.priority
            | typeof watchTriggers.deliveryStatus
            | typeof watchTriggers.feedback,
        ) =>
          Object.fromEntries(
            tx
              .select({ key: column, value: count() })
              .from(watchTriggers)
              .where(where)
              .groupBy(column)
              .all()
              .flatMap((row) => (row.key === null ? [] : [[row.key, row.value]])),
          );
        const ranked = tx
          .select({
            ...getTableColumns(watchTriggers),
            rowRank:
              sql<number>`row_number() over (partition by ${watchTriggers.stockId} order by ${watchTriggers.createdAt} desc, ${watchTriggers.id} desc)`.as(
                'row_rank',
              ),
            stockCount: sql<number>`count(*) over (partition by ${watchTriggers.stockId})`.as(
              'stock_count',
            ),
            priorityRank:
              sql<number>`min(case ${watchTriggers.priority} when 'urgent' then 0 when 'important' then 1 else 2 end) over (partition by ${watchTriggers.stockId})`.as(
                'priority_rank',
              ),
          })
          .from(watchTriggers)
          .where(where)
          .as('ranked');
        const stocks = tx
          .select()
          .from(ranked)
          .where(eq(ranked.rowRank, 1))
          .orderBy(ranked.stockId)
          .all();
        summary = {
          priorityCounts: distribution(watchTriggers.priority),
          deliveryStatusCounts: distribution(watchTriggers.deliveryStatus),
          feedbackCounts: distribution(watchTriggers.feedback),
          stocks: stocks.map((row) => ({
            stockId: row.stockId,
            count: row.stockCount,
            maxPriority:
              row.priorityRank === 0 ? 'urgent' : row.priorityRank === 1 ? 'important' : 'normal',
            latest: toWatchTrigger(row),
          })),
        };
      }
      return { total, triggers, ...(summary === undefined ? {} : { summary }) };
    });
  }

  async listRecent(
    opts: {
      readonly poolId?: string;
      readonly since?: Date;
      readonly limit?: number;
      readonly deliveryStatus?: readonly DeliveryStatus[];
      readonly ruleId?: string;
      readonly eventId?: string;
    } = {},
  ): Promise<readonly WatchTrigger[]> {
    const conditions: SQL[] = [];
    if (opts.poolId !== undefined) conditions.push(eq(watchTriggers.poolId, opts.poolId));
    if (opts.since !== undefined) conditions.push(gte(watchTriggers.createdAt, opts.since));
    if (opts.deliveryStatus !== undefined && opts.deliveryStatus.length > 0) {
      conditions.push(inDeliveryStatuses(opts.deliveryStatus));
    }
    if (opts.ruleId !== undefined) conditions.push(eq(watchTriggers.ruleId, opts.ruleId));
    if (opts.eventId !== undefined) conditions.push(eq(watchTriggers.eventId, opts.eventId));
    const where = conditions.length === 0 ? undefined : and(...conditions);
    const limit = opts.limit ?? 50;
    return this.db
      .select()
      .from(watchTriggers)
      .where(where)
      .orderBy(desc(watchTriggers.createdAt))
      .limit(limit)
      .all()
      .map(toWatchTrigger);
  }

  async remove(id: string): Promise<void> {
    this.db.delete(watchTriggers).where(eq(watchTriggers.id, id)).run();
  }

  async countAttemptedSince(since: Date, poolId?: string | null): Promise<number> {
    const conditions: SQL[] = [gte(watchTriggers.createdAt, since)];
    if (poolId !== undefined && poolId !== null) {
      conditions.push(eq(watchTriggers.poolId, poolId));
    }
    const rows = this.db
      .select({
        attempts: sql<number>`coalesce(${watchTriggers.deliveryAttempts}, case when ${inAttempted()} then 1 else 0 end)`,
      })
      .from(watchTriggers)
      .where(and(...conditions))
      .all();
    return rows.reduce((sum, row) => sum + row.attempts, 0);
  }

  async setDeliveryStatus(
    ids: readonly string[],
    status: DeliveryStatus,
    notificationId?: string,
  ): Promise<void> {
    if (ids.length === 0) return;
    const isAttempted = (ATTEMPTED as readonly DeliveryStatus[]).includes(status);
    this.db
      .update(watchTriggers)
      .set({
        deliveryStatus: status,
        notificationId: notificationId ?? null,
        notified: isAttempted,
      })
      .where(inArray(watchTriggers.id, ids as string[]))
      .run();
  }

  async setFeedback(
    id: string,
    feedback: 'handled' | 'useful' | 'useless' | 'ignored',
    at: Date,
  ): Promise<void> {
    this.db
      .update(watchTriggers)
      .set({ feedback, feedbackAt: at })
      .where(eq(watchTriggers.id, id))
      .run();
  }
}
