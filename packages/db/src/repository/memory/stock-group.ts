import {
  assertStockGroupInvariants,
  type StockGroup,
  type StockGroupRepository,
} from '@luoome/core';

/** StockGroup 的 in-memory 实现。Key 用 group.id。 */
export class InMemoryStockGroupRepository implements StockGroupRepository {
  private readonly items = new Map<string, StockGroup>();

  put(group: StockGroup): void {
    assertStockGroupInvariants(group);
    this.items.set(group.id, group);
  }

  async save(group: StockGroup): Promise<void> {
    this.put(group);
  }

  async findById(id: string): Promise<StockGroup | null> {
    return this.items.get(id) ?? null;
  }

  async list(enabledOnly = false): Promise<readonly StockGroup[]> {
    const all = [...this.items.values()].sort((a, b) => a.id.localeCompare(b.id));
    return enabledOnly ? all.filter((g) => g.enabled) : all;
  }

  async remove(id: string): Promise<void> {
    this.items.delete(id);
  }
}
