import {
  assertWatchTriggerInvariants,
  ATTEMPTED_DELIVERY_STATUSES,
  type DeliveryStatus,
  type TriggerFeedback,
  type WatchTrigger,
  type WatchTriggerRepository,
} from '@luoome/core';

const ATTEMPTED: ReadonlySet<DeliveryStatus> = new Set(ATTEMPTED_DELIVERY_STATUSES);

/**
 * WatchTrigger in-memory 实现。
 * lastForKey 走 (poolId, stockId, ruleId) 维度 + deliveryStatus ∈ ATTEMPTED 过滤（与 drizzle 同语义）。
 */
export class InMemoryWatchTriggerRepository implements WatchTriggerRepository {
  private readonly items = new Map<string, WatchTrigger>();

  put(trigger: WatchTrigger): void {
    assertWatchTriggerInvariants(trigger);
    this.items.set(trigger.id, trigger);
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
    return [...this.items.values()].filter((t) => {
      if (t.createdAt.getTime() < sinceMs) return false;
      if (poolId !== undefined && poolId !== null && t.poolId !== poolId) return false;
      return ATTEMPTED.has(t.deliveryStatus);
    }).length;
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
