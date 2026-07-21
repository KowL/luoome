import { assertStockPoolInvariants, type StockPool, type StockPoolRepository } from '@luoome/core';

/** StockPool 的 in-memory 实现。Key 用 pool.id。 */
export class InMemoryStockPoolRepository implements StockPoolRepository {
  private readonly items = new Map<string, StockPool>();

  put(pool: StockPool): void {
    assertStockPoolInvariants(pool);
    this.items.set(pool.id, pool);
  }

  async save(pool: StockPool): Promise<void> {
    this.put(pool);
  }

  async findById(id: string): Promise<StockPool | null> {
    return this.items.get(id) ?? null;
  }

  async list(enabledOnly = false): Promise<readonly StockPool[]> {
    const all = [...this.items.values()].sort((a, b) => a.id.localeCompare(b.id));
    return enabledOnly ? all.filter((p) => p.enabled) : all;
  }

  async remove(id: string): Promise<void> {
    this.items.delete(id);
  }
}
