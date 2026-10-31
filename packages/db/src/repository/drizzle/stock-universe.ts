import {
  type ListingStatus,
  type MarketCoverage,
  type Stock,
  type StockUniverseApplySummary,
  type StockUniverseRepository,
  type StockUniverseSnapshotAttributeCoverage,
  type StockUniverseSnapshotMember,
  StockUniverseSnapshotSchema,
  type StockUniverseSyncRun,
  type StStatus,
  stockUniverseMemberAttributeCoverage,
  stockUniverseMemberIdentity,
} from '@luoome/core';
import { and, asc, desc, eq, lte, or } from 'drizzle-orm';
import type { DrizzleDatabase } from '../../database.js';

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
  constructor(private readonly db: DrizzleDatabase<Schema>) {}

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
          .values({
            syncId: input.syncId,
            stockId,
            listingStatus: entry.listingStatus,
            stStatus: entry.stStatus ?? 'unknown',
            industry: entry.industry ?? null,
            listDate: entry.listDate ?? null,
            delistDate: entry.delistDate ?? null,
          })
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

  async latestSyncRun(input?: {
    readonly source?: string;
    readonly coverage?: MarketCoverage;
  }): Promise<StockUniverseSyncRun | null> {
    const filters = [];
    if (input?.source !== undefined) filters.push(eq(stockUniverseSyncRuns.source, input.source));
    if (input?.coverage !== undefined)
      filters.push(eq(stockUniverseSyncRuns.coverage, input.coverage));
    const row = this.db
      .select()
      .from(stockUniverseSyncRuns)
      .where(filters.length === 0 ? undefined : and(...filters))
      .orderBy(desc(stockUniverseSyncRuns.startedAt), desc(stockUniverseSyncRuns.id))
      .limit(1)
      .get();
    return row === undefined ? null : toSyncRun(row);
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

  /**
   * PIT 成员身份。LEFT JOIN：股票已从当前 `stocks` 删除时成员行仍返回（否则是幸存者偏差），
   * code/exchange 从 `stockId` 解析，name 缺失时用 stockId 兜底（展示用）。
   * `industry` 取**快照列**，旧行为 join 当前值（属性前视）。
   */
  async listSnapshotMembers(syncId: string): Promise<readonly Stock[]> {
    return this.snapshotRows(syncId).map((row) => {
      const identity = stockUniverseMemberIdentity(row.stockId);
      return {
        id: row.stockId,
        code: (row.code ?? identity.code) as Stock['code'],
        exchange: (row.exchange ?? identity.exchange) as Stock['exchange'],
        name: row.name ?? row.stockId,
        ...(row.industry === null ? {} : { industry: row.industry }),
      };
    });
  }

  /** PIT 成员完整属性；旧 snapshot 行没有属性时 listingStatus='unknown'，其余缺省。 */
  async listSnapshotMemberFacts(syncId: string): Promise<readonly StockUniverseSnapshotMember[]> {
    return this.snapshotRows(syncId).map((row) => {
      const identity = stockUniverseMemberIdentity(row.stockId);
      return {
        stockId: row.stockId,
        code: row.code ?? identity.code,
        exchange: row.exchange ?? identity.exchange,
        ...(row.name === null ? {} : { name: row.name }),
        listingStatus: (row.listingStatus ?? 'unknown') as ListingStatus,
        stStatus: (row.stStatus ?? 'unknown') as StStatus,
        ...(row.industry === null ? {} : { industry: row.industry }),
        ...(row.listDate === null ? {} : { listDate: row.listDate }),
        ...(row.delistDate === null ? {} : { delistDate: row.delistDate }),
      };
    });
  }

  /**
   * 属性覆盖只读 `stock_universe_snapshot_members`（不 join `stocks`，不读当前属性），
   * 旧行为 NULL → 按「未提供」计，与 `stockUniverseMemberAttributeCoverage` 同一判定。
   */
  async describeSnapshotAttributes(
    syncId: string,
  ): Promise<StockUniverseSnapshotAttributeCoverage | null> {
    const run = this.db
      .select({
        source: stockUniverseSyncRuns.source,
        observedAt: stockUniverseSyncRuns.observedAt,
      })
      .from(stockUniverseSyncRuns)
      .where(eq(stockUniverseSyncRuns.id, syncId))
      .get();
    if (run === undefined) return null;
    const members = this.db
      .select({
        listingStatus: stockUniverseSnapshotMembers.listingStatus,
        stStatus: stockUniverseSnapshotMembers.stStatus,
        industry: stockUniverseSnapshotMembers.industry,
        listDate: stockUniverseSnapshotMembers.listDate,
        delistDate: stockUniverseSnapshotMembers.delistDate,
      })
      .from(stockUniverseSnapshotMembers)
      .where(eq(stockUniverseSnapshotMembers.syncId, syncId))
      .all();
    return {
      syncId,
      source: run.source,
      observedAt: run.observedAt,
      memberCount: members.length,
      provided: stockUniverseMemberAttributeCoverage(
        members.map((member) => ({
          listingStatus: (member.listingStatus ?? 'unknown') as ListingStatus,
          stStatus: (member.stStatus ?? 'unknown') as StStatus,
          ...(member.industry === null ? {} : { industry: member.industry }),
          ...(member.listDate === null ? {} : { listDate: member.listDate }),
          ...(member.delistDate === null ? {} : { delistDate: member.delistDate }),
        })),
      ),
    };
  }

  private snapshotRows(syncId: string) {
    return this.db
      .select({
        stockId: stockUniverseSnapshotMembers.stockId,
        listingStatus: stockUniverseSnapshotMembers.listingStatus,
        stStatus: stockUniverseSnapshotMembers.stStatus,
        industry: stockUniverseSnapshotMembers.industry,
        listDate: stockUniverseSnapshotMembers.listDate,
        delistDate: stockUniverseSnapshotMembers.delistDate,
        code: stocks.code,
        exchange: stocks.exchange,
        name: stocks.name,
      })
      .from(stockUniverseSnapshotMembers)
      .leftJoin(stocks, eq(stocks.id, stockUniverseSnapshotMembers.stockId))
      .where(eq(stockUniverseSnapshotMembers.syncId, syncId))
      .orderBy(asc(stockUniverseSnapshotMembers.stockId))
      .all();
  }
}
