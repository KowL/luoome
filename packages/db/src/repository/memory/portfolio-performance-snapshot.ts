import {
  type PortfolioPerformanceSnapshot,
  type PortfolioPerformanceSnapshotRepository,
  PortfolioPerformanceSnapshotSchema,
} from '@luoome/core';

export class InMemoryPortfolioPerformanceSnapshotRepository
  implements PortfolioPerformanceSnapshotRepository
{
  private readonly rows = new Map<string, PortfolioPerformanceSnapshot>();

  async save(snapshot: PortfolioPerformanceSnapshot): Promise<void> {
    const parsed = PortfolioPerformanceSnapshotSchema.parse(snapshot);
    this.rows.set(parsed.id, parsed);
  }

  async findById(id: string): Promise<PortfolioPerformanceSnapshot | null> {
    return this.rows.get(id) ?? null;
  }

  async findByFingerprint(input: {
    readonly accountId: string;
    readonly from: Date;
    readonly to: Date;
    readonly inputFingerprint: string;
  }): Promise<PortfolioPerformanceSnapshot | null> {
    return (
      [...this.rows.values()].find(
        (row) =>
          row.accountId === input.accountId &&
          row.from.getTime() === input.from.getTime() &&
          row.to.getTime() === input.to.getTime() &&
          row.inputFingerprint === input.inputFingerprint,
      ) ?? null
    );
  }

  async listByAccount(
    accountId: string,
    limit = 50,
  ): Promise<readonly PortfolioPerformanceSnapshot[]> {
    return [...this.rows.values()]
      .filter((row) => row.accountId === accountId)
      .sort(
        (left, right) =>
          right.calculatedAt.getTime() - left.calculatedAt.getTime() ||
          right.id.localeCompare(left.id),
      )
      .slice(0, Math.max(0, limit));
  }

  async listByAccountAndRange(
    accountId: string,
    from: Date,
    to: Date,
    limit = 200,
  ): Promise<readonly PortfolioPerformanceSnapshot[]> {
    if (from > to) return [];
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.accountId === accountId &&
          row.from.getTime() <= to.getTime() &&
          row.to.getTime() >= from.getTime(),
      )
      .sort(
        (left, right) =>
          right.calculatedAt.getTime() - left.calculatedAt.getTime() ||
          right.id.localeCompare(left.id),
      )
      .slice(0, Math.max(0, limit));
  }

  async remove(id: string): Promise<void> {
    this.rows.delete(id);
  }
}
