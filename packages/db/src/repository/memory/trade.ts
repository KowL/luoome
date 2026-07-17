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

  /** 按执行时间升序（id 决胜），与 Drizzle 实现保持一致。 */
  async listByAccount(accountId: string): Promise<Trade[]> {
    return [...this.items.values()]
      .filter((t) => t.accountId === accountId)
      .sort((a, b) => a.executedAt.getTime() - b.executedAt.getTime() || a.id.localeCompare(b.id));
  }

  async remove(id: string): Promise<void> {
    this.items.delete(id);
  }
}
