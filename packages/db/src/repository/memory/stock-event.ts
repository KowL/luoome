import {
  assertStockEventInvariants,
  type EventImportance,
  type StockEvent,
  type StockEventKind,
  type StockEventRepository,
  type StockEventStatus,
} from '@luoome/core';

const IMPORTANCE_RANK: Record<EventImportance, number> = {
  normal: 0,
  important: 1,
  urgent: 2,
};

/** StockEvent in-memory 实现（ruo 迁移 §3.2）。upsertByExternal 按 (provider, externalId) 幂等。 */
export class InMemoryStockEventRepository implements StockEventRepository {
  private readonly items = new Map<string, StockEvent>();

  put(event: StockEvent): void {
    assertStockEventInvariants(event);
    this.items.set(event.id, event);
  }

  async save(event: StockEvent): Promise<void> {
    this.put(event);
  }

  async findById(id: string): Promise<StockEvent | null> {
    return this.items.get(id) ?? null;
  }

  async findByExternal(provider: string, externalId: string): Promise<StockEvent | null> {
    for (const e of this.items.values()) {
      if (e.provider === provider && e.externalId === externalId) return e;
    }
    return null;
  }

  async upsertByExternal(event: StockEvent): Promise<'inserted' | 'updated'> {
    assertStockEventInvariants(event);
    if (event.provider === undefined || event.externalId === undefined) {
      this.items.set(event.id, event);
      return 'inserted';
    }
    const existing = await this.findByExternal(event.provider, event.externalId);
    if (existing === null) {
      this.items.set(event.id, event);
      return 'inserted';
    }
    // 保留原 id / createdAt；更新可变字段
    this.items.set(existing.id, {
      ...existing,
      title: event.title,
      description: event.description,
      occursAt: event.occursAt,
      allDay: event.allDay,
      importance: event.importance,
      status: event.status,
      sourceUrl: event.sourceUrl,
      observedAt: event.observedAt,
      fetchedAt: event.fetchedAt,
      stale: event.stale,
      remindBeforeDays: event.remindBeforeDays,
      updatedAt: event.updatedAt,
    });
    return 'updated';
  }

  async list(
    opts: {
      readonly stockId?: string;
      readonly kinds?: readonly StockEventKind[];
      readonly status?: StockEventStatus;
      readonly from?: Date;
      readonly to?: Date;
      readonly importance?: EventImportance;
      readonly limit?: number;
    } = {},
  ): Promise<readonly StockEvent[]> {
    const fromMs = opts.from?.getTime() ?? Number.NEGATIVE_INFINITY;
    const toMs = opts.to?.getTime() ?? Number.POSITIVE_INFINITY;
    const kinds = opts.kinds ? new Set(opts.kinds) : null;
    const limit = opts.limit ?? 200;
    return [...this.items.values()]
      .filter((e) => opts.stockId === undefined || e.stockId === opts.stockId)
      .filter((e) => kinds === null || kinds.has(e.kind))
      .filter((e) => opts.status === undefined || e.status === opts.status)
      .filter((e) => opts.importance === undefined || e.importance === opts.importance)
      .filter((e) => e.occursAt.getTime() >= fromMs && e.occursAt.getTime() <= toMs)
      .sort((a, b) => a.occursAt.getTime() - b.occursAt.getTime())
      .slice(0, limit);
  }

  async listUpcoming(
    stockId: string,
    from: Date,
    to: Date,
    opts: {
      readonly kinds?: readonly StockEventKind[];
      readonly minImportance?: EventImportance;
    } = {},
  ): Promise<readonly StockEvent[]> {
    const fromMs = from.getTime();
    const toMs = to.getTime();
    const kinds = opts.kinds ? new Set(opts.kinds) : null;
    const minRank = opts.minImportance ? IMPORTANCE_RANK[opts.minImportance] : 0;
    return [...this.items.values()]
      .filter((e) => e.stockId === stockId && e.status === 'scheduled')
      .filter((e) => e.occursAt.getTime() >= fromMs && e.occursAt.getTime() <= toMs)
      .filter((e) => kinds === null || kinds.has(e.kind))
      .filter((e) => IMPORTANCE_RANK[e.importance] >= minRank)
      .sort((a, b) => a.occursAt.getTime() - b.occursAt.getTime());
  }

  async listStockIdsWithEvents(): Promise<readonly string[]> {
    return [...new Set([...this.items.values()].map((e) => e.stockId))];
  }

  async markStaleByProvider(provider: string): Promise<number> {
    let count = 0;
    for (const [id, e] of this.items) {
      if (e.provider === provider && !e.stale) {
        this.items.set(id, { ...e, stale: true });
        count += 1;
      }
    }
    return count;
  }

  async remove(id: string): Promise<void> {
    this.items.delete(id);
  }
}
