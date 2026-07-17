import {
  assertHoldingInvariants,
  type Holding,
  type HoldingRepository,
  InvariantError,
} from '@luoome/core';

/** Holding 的 in-memory 实现。 */
export class InMemoryHoldingRepository implements HoldingRepository {
  private readonly items = new Map<string, Holding>();

  put(holding: Holding): void {
    assertHoldingInvariants(holding);
    // 「holdings 无重复」，与 Drizzle 实现保持一致的领域错误。
    const existing = this.findByAccountAndStockSync(holding.accountId, holding.stockId);
    if (existing !== null && existing.id !== holding.id) {
      throw new InvariantError(
        `duplicate holding for (accountId=${holding.accountId}, stockId=${holding.stockId})`,
      );
    }
    this.items.set(holding.id, holding);
  }

  async save(holding: Holding): Promise<void> {
    this.put(holding);
  }

  async findById(id: string): Promise<Holding | null> {
    return this.items.get(id) ?? null;
  }

  private findByAccountAndStockSync(accountId: string, stockId: string): Holding | null {
    const match = [...this.items.values()]
      .filter((h) => h.accountId === accountId && h.stockId === stockId)
      .sort((a, b) => a.id.localeCompare(b.id));
    return match[0] ?? null;
  }

  async findByAccountAndStock(accountId: string, stockId: string): Promise<Holding | null> {
    return this.findByAccountAndStockSync(accountId, stockId);
  }

  async listByAccount(accountId: string): Promise<Holding[]> {
    return [...this.items.values()]
      .filter((h) => h.accountId === accountId)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async remove(id: string): Promise<void> {
    this.items.delete(id);
  }
}
