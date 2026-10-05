import { assertTradeInvariants, type Trade, type TradeRepository } from '@luoome/core';

/** Trade 的 in-memory 实现。 */
export class InMemoryTradeRepository implements TradeRepository {
  private readonly items = new Map<string, Trade>();

  put(trade: Trade): void {
    assertTradeInvariants(trade);
    this.items.set(trade.id, trade);
  }

  async save(trade: Trade): Promise<void> {
    this.put(trade);
  }

  async findById(id: string): Promise<Trade | null> {
    return this.items.get(id) ?? null;
  }

  async listByAccount(
    accountId: string,
    filter: Parameters<TradeRepository['listByAccount']>[1] = {},
  ): Promise<Trade[]> {
    const rows = [...this.items.values()]
      .filter(
        (t) =>
          t.accountId === accountId &&
          (filter.stockId === undefined || t.stockId === filter.stockId) &&
          (filter.executedAtFrom === undefined || t.executedAt >= filter.executedAtFrom),
      )
      .sort((a, b) => a.executedAt.getTime() - b.executedAt.getTime() || a.id.localeCompare(b.id));
    if (filter.order === 'desc') rows.reverse();
    return filter.limit === undefined ? rows : rows.slice(0, filter.limit);
  }

  async remove(id: string): Promise<void> {
    this.items.delete(id);
  }
}
