import {
  ATTEMPTED_DELIVERY_STATUSES,
  assertWatchTriggerInvariants,
  type DeliveryStatus,
  type TriggerFeedback,
  WatchRuleStateSchema,
  type WatchTrigger,
  type WatchTriggerRepository,
  type WatchTriggerSummary,
} from '@luoome/core';
import type { InMemoryWatchRuleStateRepository } from './watch-rule-state.js';

const ATTEMPTED: ReadonlySet<DeliveryStatus> = new Set(ATTEMPTED_DELIVERY_STATUSES);

/**
 * WatchTrigger in-memory 实现。
 * lastForKey 走 (poolId, stockId, ruleId) 维度 + deliveryStatus ∈ ATTEMPTED 过滤（与 drizzle 同语义）。
 */
export class InMemoryWatchTriggerRepository implements WatchTriggerRepository {
  private readonly items = new Map<string, WatchTrigger>();
  private execution: { owner: string; until: Date } | undefined;
  constructor(private readonly states: InMemoryWatchRuleStateRepository) {}

  async commitEvaluation(
    input: Parameters<WatchTriggerRepository['commitEvaluation']>[0],
  ): Promise<boolean> {
    if (this.execution?.owner !== input.owner || this.execution.until <= input.now) return false;
    for (const trigger of input.triggers) assertWatchTriggerInvariants(trigger);
    for (const state of input.states) WatchRuleStateSchema.parse(state);
    for (const trigger of input.triggers) this.put(trigger);
    for (const state of input.states) this.states.put(state);
    return true;
  }

  async acquireExecution(owner: string, now: Date, until: Date): Promise<boolean> {
    if (this.execution !== undefined && this.execution.until > now) return false;
    this.execution = { owner, until };
    return true;
  }

  async renewExecution(owner: string, now: Date, until: Date): Promise<boolean> {
    if (this.execution?.owner !== owner || this.execution.until <= now) return false;
    this.execution = { owner, until };
    return true;
  }

  async releaseExecution(owner: string): Promise<void> {
    if (this.execution?.owner === owner) this.execution = undefined;
  }

  async beginDelivery(ids: readonly string[], at: Date): Promise<void> {
    for (const id of ids) {
      const trigger = this.items.get(id);
      if (!trigger) continue;
      this.items.set(id, {
        ...trigger,
        deliveryStatus: 'pending',
        deliveryAttempts:
          (trigger.deliveryAttempts ?? (ATTEMPTED.has(trigger.deliveryStatus) ? 1 : 0)) + 1,
        lastDeliveryAttemptAt: at,
      });
    }
  }

  put(trigger: WatchTrigger): void {
    assertWatchTriggerInvariants(trigger);
    // alertPlanId 缺省时回填 poolId（与 drizzle save 的写入语义一致）。
    this.items.set(
      trigger.id,
      trigger.alertPlanId === undefined ? { ...trigger, alertPlanId: trigger.poolId } : trigger,
    );
  }

  async save(trigger: WatchTrigger): Promise<void> {
    this.put(trigger);
  }

  async findById(id: string): Promise<WatchTrigger | null> {
    return this.items.get(id) ?? null;
  }

  async listByPool(
    poolId: string,
    opts: { readonly since?: Date; readonly limit?: number } = {},
  ): Promise<readonly WatchTrigger[]> {
    const sinceMs = opts.since?.getTime() ?? Number.NEGATIVE_INFINITY;
    const limit = opts.limit ?? 200;
    return [...this.items.values()]
      .filter((t) => t.poolId === poolId && t.createdAt.getTime() >= sinceMs)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async lastForKey(
    key: { readonly poolId: string; readonly stockId: string; readonly ruleId: string },
    since: Date,
  ): Promise<WatchTrigger | null> {
    const sinceMs = since.getTime();
    const matches = [...this.items.values()]
      .filter(
        (t) =>
          t.poolId === key.poolId &&
          t.stockId === key.stockId &&
          t.ruleId === key.ruleId &&
          ATTEMPTED.has(t.deliveryStatus) &&
          t.createdAt.getTime() >= sinceMs,
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return matches[0] ?? null;
  }

  async query(input: Parameters<WatchTriggerRepository['query']>[0]) {
    const filtered = [...this.items.values()].filter(
      (t) =>
        (input.alertPlanId === undefined || (t.alertPlanId ?? t.poolId) === input.alertPlanId) &&
        (input.poolId === undefined || t.poolId === input.poolId) &&
        (input.stockId === undefined || t.stockId === input.stockId) &&
        (input.ruleKind === undefined || t.ruleKind === input.ruleKind) &&
        (input.ruleId === undefined || t.ruleId === input.ruleId) &&
        (input.notified === undefined || t.notified === input.notified) &&
        (input.priority === undefined || t.priority === input.priority) &&
        (input.feedback === undefined ||
          (input.feedback === 'unreviewed'
            ? t.feedback === undefined
            : t.feedback === input.feedback)) &&
        (input.deliveryStatus === undefined || input.deliveryStatus.includes(t.deliveryStatus)) &&
        (input.triggerType === undefined || t.triggerType === input.triggerType) &&
        (input.since === undefined || t.createdAt >= input.since) &&
        (input.until === undefined || t.createdAt <= input.until),
    );
    filtered.sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
    let summary: WatchTriggerSummary | undefined;
    if (input.includeSummary) {
      const priorityCounts: Record<string, number> = {};
      const deliveryStatusCounts: Record<string, number> = {};
      const feedbackCounts: Record<string, number> = {};
      const stocks = new Map<
        string,
        {
          stockId: string;
          count: number;
          maxPriority: WatchTrigger['priority'];
          latest: WatchTrigger;
        }
      >();
      const rank = { urgent: 0, important: 1, normal: 2 };
      for (const trigger of filtered) {
        priorityCounts[trigger.priority] = (priorityCounts[trigger.priority] ?? 0) + 1;
        deliveryStatusCounts[trigger.deliveryStatus] =
          (deliveryStatusCounts[trigger.deliveryStatus] ?? 0) + 1;
        if (trigger.feedback !== undefined)
          feedbackCounts[trigger.feedback] = (feedbackCounts[trigger.feedback] ?? 0) + 1;
        const stock = stocks.get(trigger.stockId) ?? {
          stockId: trigger.stockId,
          count: 0,
          maxPriority: trigger.priority,
          latest: trigger,
        };
        stock.count += 1;
        if (rank[trigger.priority] < rank[stock.maxPriority]) stock.maxPriority = trigger.priority;
        stocks.set(trigger.stockId, stock);
      }
      summary = {
        priorityCounts,
        deliveryStatusCounts,
        feedbackCounts,
        stocks: [...stocks.values()].sort((a, b) =>
          a.stockId < b.stockId ? -1 : a.stockId > b.stockId ? 1 : 0,
        ),
      };
    }
    if (input.orderBy === 'priority') {
      const rank = { urgent: 0, important: 1, normal: 2 };
      filtered.sort((a, b) => rank[a.priority] - rank[b.priority]);
    }
    return {
      total: filtered.length,
      triggers: filtered.slice(input.offset, input.offset + input.limit),
      ...(summary === undefined ? {} : { summary }),
    };
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
    const sinceMs = opts.since?.getTime() ?? Number.NEGATIVE_INFINITY;
    const limit = opts.limit ?? 50;
    const statusFilter = opts.deliveryStatus ? new Set(opts.deliveryStatus) : null;
    return [...this.items.values()]
      .filter((t) => {
        if (opts.poolId !== undefined && t.poolId !== opts.poolId) return false;
        if (t.createdAt.getTime() < sinceMs) return false;
        if (statusFilter !== null && !statusFilter.has(t.deliveryStatus)) return false;
        if (opts.ruleId !== undefined && t.ruleId !== opts.ruleId) return false;
        if (opts.eventId !== undefined && t.eventId !== opts.eventId) return false;
        return true;
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async countAttemptedSince(since: Date, poolId?: string | null): Promise<number> {
    const sinceMs = since.getTime();
    return [...this.items.values()]
      .filter((t) => {
        if (t.createdAt.getTime() < sinceMs) return false;
        if (poolId !== undefined && poolId !== null && t.poolId !== poolId) return false;
        return true;
      })
      .reduce(
        (sum, t) => sum + (t.deliveryAttempts ?? (ATTEMPTED.has(t.deliveryStatus) ? 1 : 0)),
        0,
      );
  }

  async setDeliveryStatus(
    ids: readonly string[],
    status: DeliveryStatus,
    notificationId?: string,
  ): Promise<void> {
    for (const id of ids) {
      const t = this.items.get(id);
      if (t === undefined) continue;
      this.items.set(id, {
        ...t,
        deliveryStatus: status,
        ...(notificationId !== undefined ? { notificationId } : {}),
        notified: ATTEMPTED.has(status),
      });
    }
  }

  async setFeedback(id: string, feedback: TriggerFeedback, at: Date): Promise<void> {
    const t = this.items.get(id);
    if (t === undefined) return;
    this.items.set(id, { ...t, feedback, feedbackAt: at });
  }

  async remove(id: string): Promise<void> {
    this.items.delete(id);
  }
}
