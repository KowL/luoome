import { type Quote, type QuoteRepository, QuoteSchema } from '@luoome/core';

/** Quote 的 in-memory 实现。Key 形如 `${stockId}|${tsMs}`，与 Drizzle 行为对齐（upsert）。 */
export class InMemoryQuoteRepository implements QuoteRepository {
  private readonly items = new Map<string, Quote>();

  put(quote: Quote): void {
    const parsed = QuoteSchema.parse(quote);
    this.items.set(this.keyOf(parsed.stockId, parsed.observedAt, parsed.source), parsed);
  }

  async save(quote: Quote): Promise<void> {
    this.put(quote);
  }

  private keyOf(stockId: string, observedAt: Date, source: string): string {
    return `${stockId}|${observedAt.getTime()}|${source}`;
  }

  async latestByStock(stockId: string, since?: Date): Promise<Quote | null> {
    const sinceMs = since?.getTime() ?? Number.NEGATIVE_INFINITY;
    let best: Quote | null = null;
    for (const q of this.items.values()) {
      if (q.stockId !== stockId) continue;
      const tsMs = q.observedAt.getTime();
      if (tsMs < sinceMs) continue;
      if (
        best === null ||
        tsMs > best.observedAt.getTime() ||
        (tsMs === best.observedAt.getTime() && q.fetchedAt > best.fetchedAt)
      ) {
        best = q;
      }
    }
    return best;
  }

  async latestByStocks(stockIds: readonly string[]): Promise<Map<string, Quote>> {
    const result = new Map<string, Quote>();
    const wanted = new Set(stockIds);
    for (const q of this.items.values()) {
      if (!wanted.has(q.stockId)) continue;
      const cur = result.get(q.stockId);
      if (
        cur === undefined ||
        q.observedAt > cur.observedAt ||
        (q.observedAt.getTime() === cur.observedAt.getTime() && q.fetchedAt > cur.fetchedAt)
      ) {
        result.set(q.stockId, q);
      }
    }
    return result;
  }

  async listInRange(stockId: string, from: Date, to: Date): Promise<Quote[]> {
    const fromMs = from.getTime();
    const toMs = to.getTime();
    return [...this.items.values()]
      .filter(
        (q) =>
          q.stockId === stockId &&
          q.observedAt.getTime() >= fromMs &&
          q.observedAt.getTime() <= toMs,
      )
      .sort(
        (a, b) =>
          a.observedAt.getTime() - b.observedAt.getTime() || a.source.localeCompare(b.source),
      );
  }

  async removeInRange(stockId: string, before: Date): Promise<number> {
    const cutoff = before.getTime();
    let removed = 0;
    for (const [k, q] of this.items) {
      if (q.stockId === stockId && q.observedAt.getTime() <= cutoff) {
        this.items.delete(k);
        removed += 1;
      }
    }
    return removed;
  }
}
