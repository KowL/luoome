import type { FinancialIngestSnapshot, FinancialIngestSnapshotRepository } from '@luoome/core';

/** `financial_ingest_snapshots` 的 memory 实现（REQ-M4-05 层 3）。 */
export class InMemoryFinancialIngestSnapshotRepository
  implements FinancialIngestSnapshotRepository
{
  private readonly items: FinancialIngestSnapshot[] = [];

  async append(snapshot: FinancialIngestSnapshot): Promise<void> {
    // 幂等：同 (stock, metric, periodEnd, hash) 只留一条。
    const exists = this.items.some(
      (item) =>
        item.stockId === snapshot.stockId &&
        item.metricId === snapshot.metricId &&
        item.periodEnd.getTime() === snapshot.periodEnd.getTime() &&
        item.ingestHash === snapshot.ingestHash,
    );
    if (!exists) this.items.push(snapshot);
  }

  async latest(input: {
    readonly stockId: string;
    readonly metricId: string;
    readonly periodEnd: Date;
  }): Promise<FinancialIngestSnapshot | null> {
    const matches = this.items.filter(
      (item) =>
        item.stockId === input.stockId &&
        item.metricId === input.metricId &&
        item.periodEnd.getTime() === input.periodEnd.getTime(),
    );
    if (matches.length === 0) return null;
    return matches[matches.length - 1] ?? null;
  }
}
