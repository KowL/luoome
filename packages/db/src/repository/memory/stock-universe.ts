import {
  type MarketCoverage,
  type Stock,
  type StockRepository,
  type StockUniverseApplySummary,
  type StockUniverseRepository,
  StockUniverseSnapshotSchema,
  type StockUniverseSyncRun,
} from '@luoome/core';

interface Membership {
  readonly source: string;
  readonly coverage: MarketCoverage;
  readonly stockId: string;
  readonly state: 'active' | 'missing';
  readonly lastSyncId: string;
}

export class InMemoryStockUniverseRepository implements StockUniverseRepository {
  private readonly memberships = new Map<string, Membership>();
  private readonly runs = new Map<string, StockUniverseSyncRun>();
  private readonly snapshotMembers = new Map<string, readonly string[]>();
  private readonly universeManagedStockIds = new Set<string>();

  constructor(private readonly stocks: StockRepository) {}

  async applySnapshot(input: {
    readonly syncId: string;
    readonly snapshot: Parameters<StockUniverseRepository['applySnapshot']>[0]['snapshot'];
    readonly appliedAt: Date;
  }): Promise<StockUniverseApplySummary> {
    const snapshot = StockUniverseSnapshotSchema.parse(input.snapshot);
    const replay = this.runs.get(input.syncId);
    if (replay !== undefined) {
      return {
        observedCount: replay.observedCount,
        createdStocks: replay.createdStocks,
        updatedStocks: replay.updatedStocks,
        reactivated: replay.reactivated,
        markedMissing: replay.markedMissing,
      };
    }
    let createdStocks = 0;
    let updatedStocks = 0;
    let reactivated = 0;
    const observedIds = new Set<string>();

    for (const entry of snapshot.entries) {
      const byId = await this.stocks.findById(entry.stockId);
      const existing =
        byId ??
        (await this.stocks.search(entry.code)).find(
          (stock) => stock.code === entry.code && stock.exchange === entry.exchange,
        ) ??
        null;
      const stockId = existing?.id ?? entry.stockId;
      if (existing === null) {
        const stock: Stock = {
          id: stockId,
          code: entry.code,
          exchange: entry.exchange,
          name: entry.name,
          ...(entry.industry === undefined ? {} : { industry: entry.industry }),
        };
        await this.stocks.save(stock);
        this.universeManagedStockIds.add(stockId);
        createdStocks += 1;
      } else if (
        (existing.name === existing.code || this.universeManagedStockIds.has(stockId)) &&
        (existing.name !== entry.name ||
          (existing.industry === undefined && entry.industry !== undefined))
      ) {
        await this.stocks.save({
          ...existing,
          name: entry.name,
          ...(existing.industry === undefined && entry.industry !== undefined
            ? { industry: entry.industry }
            : {}),
        });
        this.universeManagedStockIds.add(stockId);
        updatedStocks += 1;
      }
      observedIds.add(stockId);
      const membershipKey = this.key(snapshot.source, snapshot.coverage, stockId);
      if (this.memberships.get(membershipKey)?.state === 'missing') {
        reactivated += 1;
      }
      this.memberships.set(membershipKey, {
        source: snapshot.source,
        coverage: snapshot.coverage,
        stockId,
        state: 'active',
        lastSyncId: input.syncId,
      });
    }

    let markedMissing = 0;
    for (const [key, membership] of this.memberships) {
      if (
        membership.source === snapshot.source &&
        membership.coverage === snapshot.coverage &&
        membership.state === 'active' &&
        !observedIds.has(membership.stockId)
      ) {
        this.memberships.set(key, {
          ...membership,
          state: 'missing',
          lastSyncId: input.syncId,
        });
        markedMissing += 1;
      }
    }

    const summary: StockUniverseApplySummary = {
      observedCount: snapshot.entries.length,
      createdStocks,
      updatedStocks,
      reactivated,
      markedMissing,
    };
    this.runs.set(input.syncId, {
      id: input.syncId,
      source: snapshot.source,
      coverage: snapshot.coverage,
      status: 'succeeded',
      startedAt: input.appliedAt,
      finishedAt: input.appliedAt,
      observedAt: snapshot.observedAt,
      reportedTotal: snapshot.reportedTotal ?? null,
      ...summary,
    });
    this.snapshotMembers.set(input.syncId, [...observedIds].sort());
    return summary;
  }

  async latestSuccessfulSync(input?: {
    readonly source?: string;
    readonly coverage?: MarketCoverage;
  }): Promise<StockUniverseSyncRun | null> {
    return (
      [...this.runs.values()]
        .filter(
          (run) =>
            run.status === 'succeeded' &&
            (input?.source === undefined || run.source === input.source) &&
            (input?.coverage === undefined || run.coverage === input.coverage),
        )
        .sort(
          (a, b) =>
            (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0) ||
            b.id.localeCompare(a.id),
        )[0] ?? null
    );
  }

  async listCurrent(input: {
    readonly coverage: MarketCoverage;
    readonly status?: 'active' | 'missing' | 'all';
  }): Promise<readonly Stock[]> {
    const status = input.status ?? 'active';
    const statesByStock = new Map<string, Set<Membership['state']>>();
    for (const membership of this.memberships.values()) {
      if (membership.coverage !== input.coverage) continue;
      const states = statesByStock.get(membership.stockId) ?? new Set<Membership['state']>();
      states.add(membership.state);
      statesByStock.set(membership.stockId, states);
    }
    const ids = [...statesByStock]
      .filter(([, states]) => {
        if (status === 'all') return true;
        if (status === 'active') return states.has('active');
        return !states.has('active') && states.has('missing');
      })
      .map(([stockId]) => stockId);
    const stocks = await Promise.all([...ids].map((id) => this.stocks.findById(id)));
    return stocks
      .filter((stock): stock is Stock => stock !== null)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async latestSnapshotAtOrBefore(input: {
    readonly coverage: MarketCoverage;
    readonly asOf: Date;
  }): Promise<StockUniverseSyncRun | null> {
    return (
      [...this.runs.values()]
        .filter(
          (run) =>
            run.status === 'succeeded' &&
            run.coverage === input.coverage &&
            run.observedAt !== null &&
            run.observedAt.getTime() <= input.asOf.getTime(),
        )
        .sort(
          (left, right) =>
            (right.observedAt?.getTime() ?? 0) - (left.observedAt?.getTime() ?? 0) ||
            right.id.localeCompare(left.id),
        )[0] ?? null
    );
  }

  async listSnapshotMembers(syncId: string): Promise<readonly Stock[]> {
    const ids = this.snapshotMembers.get(syncId) ?? [];
    const stocks = await Promise.all(ids.map((id) => this.stocks.findById(id)));
    return stocks
      .filter((stock): stock is Stock => stock !== null)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  private key(source: string, coverage: MarketCoverage, stockId: string): string {
    return `${source}\u0000${coverage}\u0000${stockId}`;
  }
}
