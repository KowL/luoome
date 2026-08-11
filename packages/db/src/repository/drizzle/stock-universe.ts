import {
  type MarketCoverage,
  type Stock,
  type StockUniverseApplySummary,
  type StockUniverseRepository,
  StockUniverseSnapshotSchema,
  type StockUniverseSyncRun,
} from '@luoome/core';
import { and, asc, desc, eq, lte, or } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import {
  type Schema,
  stocks,
  stockUniverseMemberships,
  stockUniverseSnapshotMembers,
  stockUniverseSyncRuns,
} from '../../schema/index.js';

type SyncRunRow = typeof stockUniverseSyncRuns.$inferSelect;

const toSyncRun = (row: SyncRunRow): StockUniverseSyncRun => ({
  id: row.id,
  source: row.source,
  coverage: row.coverage,
  status: row.status,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
  observedAt: row.observedAt,
  reportedTotal: row.reportedTotal,
  observedCount: row.observedCount,
  createdStocks: row.createdStocks,
  updatedStocks: row.updatedStocks,
  reactivated: row.reactivated,
  markedMissing: row.markedMissing,
  ...(row.errorKind === null ? {} : { errorKind: row.errorKind }),
  ...(row.errorMessage === null ? {} : { errorMessage: row.errorMessage }),
});

const summaryFromRun = (run: SyncRunRow): StockUniverseApplySummary => ({
  observedCount: run.observedCount,
  createdStocks: run.createdStocks,
  updatedStocks: run.updatedStocks,
  reactivated: run.reactivated,
  markedMissing: run.markedMissing,
});

export class DrizzleStockUniverseRepository implements StockUniverseRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async applySnapshot(input: {
    readonly syncId: string;
    readonly snapshot: Parameters<StockUniverseRepository['applySnapshot']>[0]['snapshot'];
    readonly appliedAt: Date;
  }): Promise<StockUniverseApplySummary> {
    const snapshot = StockUniverseSnapshotSchema.parse(input.snapshot);
    const replay = this.db
      .select()
      .from(stockUniverseSyncRuns)
      .where(eq(stockUniverseSyncRuns.id, input.syncId))
      .get();
    if (replay !== undefined) return summaryFromRun(replay);

    return this.db.transaction((tx) => {
      let createdStocks = 0;
      let updatedStocks = 0;
      let reactivated = 0;
      const currentMemberships = tx
        .select()
        .from(stockUniverseMemberships)
        .where(
          and(
            eq(stockUniverseMemberships.source, snapshot.source),
            eq(stockUniverseMemberships.coverage, snapshot.coverage),
          ),
        )
        .all();
      const currentByStock = new Map(
        currentMemberships.map((membership) => [membership.stockId, membership]),
      );
      const observedIds = new Set<string>();

      for (const entry of snapshot.entries) {
        const existing = tx
          .select()
          .from(stocks)
          .where(
            or(
              eq(stocks.id, entry.stockId),
              and(eq(stocks.code, entry.code), eq(stocks.exchange, entry.exchange)),
            ),
          )
          .get();
        const stockId = existing?.id ?? entry.stockId;
        if (existing === undefined) {
          tx.insert(stocks)
            .values({
              id: stockId,
              code: entry.code,
              exchange: entry.exchange,
              name: entry.name,
              industry: entry.industry ?? null,
              nameSource: 'universe',
              nameUpdatedAt: input.appliedAt,
              updatedAt: input.appliedAt,
            })
            .run();
          createdStocks += 1;
        } else if (
          (existing.nameSource === 'stub' || existing.nameSource === 'universe') &&
          (existing.name !== entry.name ||
            (existing.industry === null && entry.industry !== undefined))
        ) {
          tx.update(stocks)
            .set({
              name: entry.name,
              ...(existing.industry === null && entry.industry !== undefined
                ? { industry: entry.industry }
                : {}),
              nameSource: 'universe',
              nameUpdatedAt: input.appliedAt,
              updatedAt: input.appliedAt,
            })
            .where(eq(stocks.id, stockId))
            .run();
          updatedStocks += 1;
        }

        observedIds.add(stockId);
        if (currentByStock.get(stockId)?.state === 'missing') {
          reactivated += 1;
        }
        tx.insert(stockUniverseMemberships)
          .values({
            source: snapshot.source,
            coverage: snapshot.coverage,
            stockId,
            observedName: entry.name,
            listingStatus: entry.listingStatus,
            state: 'active',
            firstSeenAt: snapshot.observedAt,
            lastSeenAt: snapshot.observedAt,
            missingSince: null,
            lastSyncId: input.syncId,
            metadata: null,
          })
          .onConflictDoUpdate({
            target: [
              stockUniverseMemberships.source,
              stockUniverseMemberships.coverage,
              stockUniverseMemberships.stockId,
            ],
            set: {
              observedName: entry.name,
              listingStatus: entry.listingStatus,
              state: 'active',
              lastSeenAt: snapshot.observedAt,
              missingSince: null,
              lastSyncId: input.syncId,
            },
          })
          .run();
        tx.insert(stockUniverseSnapshotMembers)
          .values({ syncId: input.syncId, stockId })
          .onConflictDoNothing()
          .run();
      }

      let markedMissing = 0;
      for (const membership of currentMemberships) {
        if (membership.state !== 'active' || observedIds.has(membership.stockId)) continue;
        tx.update(stockUniverseMemberships)
          .set({
            state: 'missing',
            missingSince: snapshot.observedAt,
            lastSyncId: input.syncId,
          })
          .where(
            and(
              eq(stockUniverseMemberships.source, membership.source),
              eq(stockUniverseMemberships.coverage, membership.coverage),
              eq(stockUniverseMemberships.stockId, membership.stockId),
            ),
          )
          .run();
        markedMissing += 1;
      }

      const summary: StockUniverseApplySummary = {
        observedCount: snapshot.entries.length,
        createdStocks,
        updatedStocks,
        reactivated,
        markedMissing,
      };
      tx.insert(stockUniverseSyncRuns)
        .values({
          id: input.syncId,
          source: snapshot.source,
          coverage: snapshot.coverage,
          status: 'succeeded',
          startedAt: input.appliedAt,
          finishedAt: input.appliedAt,
          observedAt: snapshot.observedAt,
          reportedTotal: snapshot.reportedTotal ?? null,
          ...summary,
        })
        .run();
      return summary;
    });
  }

  async latestSuccessfulSync(input?: {
    readonly source?: string;
    readonly coverage?: MarketCoverage;
  }): Promise<StockUniverseSyncRun | null> {
    const filters = [eq(stockUniverseSyncRuns.status, 'succeeded')];
    if (input?.source !== undefined) {
      filters.push(eq(stockUniverseSyncRuns.source, input.source));
    }
    if (input?.coverage !== undefined) {
      filters.push(eq(stockUniverseSyncRuns.coverage, input.coverage));
    }
    const row = this.db
      .select()
      .from(stockUniverseSyncRuns)
      .where(and(...filters))
      .orderBy(desc(stockUniverseSyncRuns.finishedAt), desc(stockUniverseSyncRuns.id))
      .limit(1)
      .get();
    return row === undefined ? null : toSyncRun(row);
  }

  async listCurrent(input: {
    readonly coverage: MarketCoverage;
    readonly status?: 'active' | 'missing' | 'all';
  }): Promise<readonly Stock[]> {
    const filters = [eq(stockUniverseMemberships.coverage, input.coverage)];
    const status = input.status ?? 'active';
    const rows = this.db
      .select({ stock: stocks, state: stockUniverseMemberships.state })
      .from(stockUniverseMemberships)
      .innerJoin(stocks, eq(stocks.id, stockUniverseMemberships.stockId))
      .where(and(...filters))
      .orderBy(asc(stocks.id))
      .all();

    const byId = new Map<string, { stock: Stock; states: Set<'active' | 'missing'> }>();
    for (const { stock: row, state } of rows) {
      const current = byId.get(row.id);
      const states = current?.states ?? new Set<'active' | 'missing'>();
      states.add(state);
      byId.set(row.id, {
        stock:
          current?.stock ??
          ({
            id: row.id,
            code: row.code,
            exchange: row.exchange,
            name: row.name,
            ...(row.industry === null ? {} : { industry: row.industry }),
          } satisfies Stock),
        states,
      });
    }
    return [...byId.values()]
      .filter(({ states }) => {
        if (status === 'all') return true;
        if (status === 'active') return states.has('active');
        return !states.has('active') && states.has('missing');
      })
      .map(({ stock }) => stock);
  }

  async latestSnapshotAtOrBefore(input: {
    readonly coverage: MarketCoverage;
    readonly asOf: Date;
  }): Promise<StockUniverseSyncRun | null> {
    const row = this.db
      .select()
      .from(stockUniverseSyncRuns)
      .where(
        and(
          eq(stockUniverseSyncRuns.coverage, input.coverage),
          eq(stockUniverseSyncRuns.status, 'succeeded'),
          lte(stockUniverseSyncRuns.observedAt, input.asOf),
        ),
      )
      .orderBy(desc(stockUniverseSyncRuns.observedAt), desc(stockUniverseSyncRuns.id))
      .limit(1)
      .get();
    return row === undefined ? null : toSyncRun(row);
  }

  async listSnapshotMembers(syncId: string): Promise<readonly Stock[]> {
    return this.db
      .select({ stock: stocks })
      .from(stockUniverseSnapshotMembers)
      .innerJoin(stocks, eq(stocks.id, stockUniverseSnapshotMembers.stockId))
      .where(eq(stockUniverseSnapshotMembers.syncId, syncId))
      .orderBy(asc(stocks.id))
      .all()
      .map(({ stock: row }) => ({
        id: row.id,
        code: row.code,
        exchange: row.exchange,
        name: row.name,
        ...(row.industry === null ? {} : { industry: row.industry }),
      }));
  }
}
