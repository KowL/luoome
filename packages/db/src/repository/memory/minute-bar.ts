import {
  dateInShanghai,
  type MinuteBar,
  type MinuteBarInterval,
  type MinuteBarRepository,
  MinuteBarSchema,
} from '@luoome/core';

export class InMemoryMinuteBarRepository implements MinuteBarRepository {
  private readonly items = new Map<string, MinuteBar>();

  put(bar: MinuteBar): void {
    const parsed = MinuteBarSchema.parse(bar);
    this.items.set(this.keyOf(parsed), parsed);
  }

  async saveMany(bars: readonly MinuteBar[]): Promise<void> {
    for (const bar of bars) this.put(bar);
  }

  async findInRange(
    stockId: string,
    interval: MinuteBarInterval,
    from: Date,
    to: Date,
  ): Promise<MinuteBar[]> {
    return [...this.items.values()]
      .filter(
        (bar) =>
          bar.stockId === stockId &&
          bar.interval === interval &&
          bar.endedAt >= from &&
          bar.endedAt <= to,
      )
      .sort((left, right) => left.endedAt.getTime() - right.endedAt.getTime());
  }

  async latestSession(stockId: string, interval: MinuteBarInterval): Promise<MinuteBar[]> {
    const latest = [...this.items.values()]
      .filter((bar) => bar.stockId === stockId && bar.interval === interval)
      .sort((left, right) => right.endedAt.getTime() - left.endedAt.getTime())[0];
    if (latest === undefined) return [];
    const date = dateInShanghai(latest.endedAt);
    return [...this.items.values()]
      .filter(
        (bar) =>
          bar.stockId === stockId &&
          bar.interval === interval &&
          dateInShanghai(bar.endedAt) === date,
      )
      .sort((left, right) => left.endedAt.getTime() - right.endedAt.getTime());
  }

  async removeBefore(before: Date): Promise<number> {
    let removed = 0;
    for (const [key, bar] of this.items) {
      if (bar.endedAt < before) {
        this.items.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  private keyOf(bar: MinuteBar): string {
    return `${bar.stockId}|${bar.interval}|${bar.endedAt.getTime()}`;
  }
}
