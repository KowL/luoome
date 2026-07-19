import type { DailyBar, DailyBarRepository } from '@luoome/core';

/** DailyBar 的 in-memory 实现。Key 形如 `${stockId}|${dateMs}`，upsert 语义对齐 Drizzle。 */
export class InMemoryDailyBarRepository implements DailyBarRepository {
  private readonly items = new Map<string, DailyBar>();

  put(bar: DailyBar): void {
    this.items.set(this.keyOf(bar.stockId, bar.date), bar);
  }

  async saveMany(bars: readonly DailyBar[]): Promise<void> {
    for (const b of bars) this.put(b);
  }

  private keyOf(stockId: string, date: Date): string {
    return `${stockId}|${date.getTime()}`;
  }

  async findInRange(stockId: string, from: Date, to: Date): Promise<DailyBar[]> {
    const fromMs = from.getTime();
    const toMs = to.getTime();
    return [...this.items.values()]
      .filter(
        (b) => b.stockId === stockId && b.date.getTime() >= fromMs && b.date.getTime() <= toMs,
      )
      .sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  async latestBefore(stockId: string, to: Date, count: number): Promise<DailyBar[]> {
    if (count <= 0) return [];
    return [...this.items.values()]
      .filter((b) => b.stockId === stockId && b.date.getTime() <= to.getTime())
      .sort((a, b) => b.date.getTime() - a.date.getTime())
      .slice(0, count)
      .reverse();
  }

  async removeInRange(stockId: string, before: Date): Promise<number> {
    const cutoff = before.getTime();
    let removed = 0;
    for (const [k, b] of this.items) {
      if (b.stockId === stockId && b.date.getTime() <= cutoff) {
        this.items.delete(k);
        removed += 1;
      }
    }
    return removed;
  }
}
