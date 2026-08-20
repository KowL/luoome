import {
  type DailyBar,
  type DailyBarRepository,
  type DailyBarRevision,
  DailyBarRevisionSchema,
  DailyBarSchema,
} from '@luoome/core';

/** DailyBar 的 in-memory 实现。Key 形如 `${stockId}|${dateMs}`，upsert 语义对齐 Drizzle。 */
export class InMemoryDailyBarRepository implements DailyBarRepository {
  private readonly items = new Map<string, DailyBar>();
  private readonly revisions = new Map<string, DailyBarRevision>();

  put(bar: DailyBar): void {
    const parsed = DailyBarSchema.parse(bar);
    this.items.set(this.keyOf(parsed.stockId, parsed.date), parsed);
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

  async saveRevisions(revisions: readonly DailyBarRevision[]): Promise<void> {
    const parsedRevisions = revisions
      .map((revision) => DailyBarRevisionSchema.parse(revision))
      .sort(
        (left, right) =>
          left.recordedAt.getTime() - right.recordedAt.getTime() ||
          left.stockId.localeCompare(right.stockId) ||
          left.date.getTime() - right.date.getTime() ||
          left.contentHash.localeCompare(right.contentHash),
      );
    const latestByStockDate = new Map<string, DailyBarRevision>();
    for (const revision of this.revisions.values()) {
      const key = this.keyOf(revision.stockId, revision.date);
      const latest = latestByStockDate.get(key);
      if (
        latest === undefined ||
        revision.recordedAt.getTime() > latest.recordedAt.getTime() ||
        (revision.recordedAt.getTime() === latest.recordedAt.getTime() &&
          revision.contentHash.localeCompare(latest.contentHash) > 0)
      ) {
        latestByStockDate.set(key, revision);
      }
    }
    for (const parsed of parsedRevisions) {
      const stockDateKey = this.keyOf(parsed.stockId, parsed.date);
      const latest = latestByStockDate.get(stockDateKey);
      if (
        latest !== undefined &&
        latest.recordedAt.getTime() <= parsed.recordedAt.getTime() &&
        latest.contentHash === parsed.contentHash
      ) {
        continue;
      }
      const key = `${parsed.stockId}|${parsed.date.getTime()}|${parsed.recordedAt.getTime()}|${parsed.contentHash}`;
      if (!this.revisions.has(key)) {
        this.revisions.set(key, parsed);
        if (
          latest === undefined ||
          parsed.recordedAt.getTime() > latest.recordedAt.getTime() ||
          (parsed.recordedAt.getTime() === latest.recordedAt.getTime() &&
            parsed.contentHash.localeCompare(latest.contentHash) > 0)
        ) {
          latestByStockDate.set(stockDateKey, parsed);
        }
      }
    }
  }

  async listRevisions(input: {
    readonly stockId: string;
    readonly from?: Date;
    readonly to?: Date;
    readonly recordedAt?: Date;
  }): Promise<readonly DailyBarRevision[]> {
    return [...this.revisions.values()]
      .filter(
        (revision) =>
          revision.stockId === input.stockId &&
          (input.from === undefined || revision.date >= input.from) &&
          (input.to === undefined || revision.date <= input.to) &&
          (input.recordedAt === undefined || revision.recordedAt <= input.recordedAt),
      )
      .sort(
        (left, right) =>
          left.date.getTime() - right.date.getTime() ||
          left.recordedAt.getTime() - right.recordedAt.getTime() ||
          left.contentHash.localeCompare(right.contentHash),
      );
  }

  async listRevisionsForStocks(input: {
    readonly stockIds: readonly string[];
    readonly from?: Date;
    readonly to?: Date;
    readonly recordedAt?: Date;
  }): Promise<readonly DailyBarRevision[]> {
    const stockIds = new Set(input.stockIds);
    return [...this.revisions.values()]
      .filter(
        (revision) =>
          stockIds.has(revision.stockId) &&
          (input.from === undefined || revision.date >= input.from) &&
          (input.to === undefined || revision.date <= input.to) &&
          (input.recordedAt === undefined || revision.recordedAt <= input.recordedAt),
      )
      .sort(
        (left, right) =>
          left.stockId.localeCompare(right.stockId) ||
          left.date.getTime() - right.date.getTime() ||
          left.recordedAt.getTime() - right.recordedAt.getTime() ||
          left.contentHash.localeCompare(right.contentHash),
      );
  }
}
