import { assertStockInvariants, type Stock, type StockRepository } from '@luoome/core';

/** Stock 的 in-memory 实现。 */
export class InMemoryStockRepository implements StockRepository {
  private readonly items = new Map<string, Stock>();

  put(stock: Stock): void {
    assertStockInvariants(stock);
    this.items.set(stock.id, stock);
  }

  async save(stock: Stock): Promise<void> {
    this.put(stock);
  }

  async findById(id: string): Promise<Stock | null> {
    return this.items.get(id) ?? null;
  }

  async findByCode(code: string): Promise<Stock | null> {
    const match = [...this.items.values()]
      .filter((s) => s.code === code)
      .sort((a, b) => a.id.localeCompare(b.id));
    return match[0] ?? null;
  }

  /** 按代码 / 名称模糊搜索；大小写不敏感，与 SQLite LIKE 的 ASCII 语义对齐。 */
  async search(query: string): Promise<Stock[]> {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return [];
    return [...this.items.values()]
      .filter((s) => s.code.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async remove(id: string): Promise<void> {
    this.items.delete(id);
  }
}
