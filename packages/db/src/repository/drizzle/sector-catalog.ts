import {
  type SectorCatalogEntry,
  type SectorCatalogObservation,
  type SectorCatalogRepository,
  type SectorCatalogState,
  type SectorChangeEvent,
  type SectorKind,
  type SectorStockStatusObservation,
  SectorStockStatusObservationSchema,
  type SectorSyncApplyInput,
  type SectorSyncApplySummary,
  type StockSectorMembership,
  type StockSectorMembershipView,
  StockSectorObservationSchema,
} from '@luoome/core';
import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import {
  type Schema,
  sectorCatalogEntries,
  sectorChangeEvents,
  sectorMemberships,
  sectorSyncRuns,
} from '../../schema/index.js';

type SectorRow = typeof sectorCatalogEntries.$inferSelect;
type MembershipRow = typeof sectorMemberships.$inferSelect;
type ChangeRow = typeof sectorChangeEvents.$inferSelect;
type SyncRunRow = typeof sectorSyncRuns.$inferSelect;

const sectorKey = (kind: SectorKind, vendorCode: string): string => `${kind}\u0000${vendorCode}`;

const toEntry = (row: SectorRow): SectorCatalogEntry => ({
  id: row.id,
  kind: row.kind,
  source: row.source,
  vendorCode: row.vendorCode,
  name: row.name,
  state: row.state,
  firstSeenAt: row.firstSeenAt,
  lastSeenAt: row.lastSeenAt,
  retiredAt: row.retiredAt,
});

const toMembership = (row: MembershipRow): StockSectorMembership => ({
  sectorId: row.sectorId,
  stockId: row.stockId,
  source: row.source,
  state: row.state,
  memberStatus: row.memberStatus,
  firstSeenAt: row.firstSeenAt,
  lastSeenAt: row.lastSeenAt,
  missingSince: row.missingSince,
});

const toChange = (row: ChangeRow): SectorChangeEvent => ({
  seq: row.seq,
  sectorId: row.sectorId,
  stockId: row.stockId,
  kind: row.kind,
  occurredAt: row.occurredAt,
  syncId: row.syncId,
  previousValue: row.previousValue,
  nextValue: row.nextValue,
});

const summaryFromRun = (row: SyncRunRow): SectorSyncApplySummary => ({
  observedSectors: row.observedSectors,
  createdSectors: row.createdSectors,
  renamedSectors: row.renamedSectors,
  retiredSectors: row.retiredSectors,
  observedStocks: row.observedStocks,
  createdMemberships: row.createdMemberships,
  removedMemberships: row.removedMemberships,
  reactivatedMemberships: row.reactivatedMemberships,
});

export class DrizzleSectorCatalogRepository implements SectorCatalogRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async applySync(input: SectorSyncApplyInput): Promise<SectorSyncApplySummary> {
    const replay = this.db
      .select()
      .from(sectorSyncRuns)
      .where(eq(sectorSyncRuns.id, input.syncId))
      .get();
    if (replay !== undefined) return summaryFromRun(replay);

    const observations = input.observations.map((observation) =>
      StockSectorObservationSchema.parse(observation),
    );
    const stockStatuses: readonly SectorStockStatusObservation[] = input.stockStatuses.map(
      (status) => SectorStockStatusObservationSchema.parse(status),
    );

    return this.db.transaction((tx) => {
      const appliedAt = input.appliedAt;
      const statusByStock = new Map(stockStatuses.map(({ stockId, status }) => [stockId, status]));
      const previousRows = tx
        .select()
        .from(sectorCatalogEntries)
        .where(eq(sectorCatalogEntries.source, input.source))
        .all();
      const previousByKey = new Map(
        previousRows.map((row) => [sectorKey(row.kind, row.vendorCode), row]),
      );
      const sectorNameById = new Map(previousRows.map((row) => [row.id, row.name]));

      // 目录观测优先；目录请求失败的分类用成分反查里出现的条目兜底建目，避免成分悬空。
      const sectorsToObserve = new Map<string, SectorCatalogObservation>();
      for (const sector of input.catalog) {
        sectorsToObserve.set(sectorKey(sector.kind, sector.vendorCode), sector);
      }
      for (const observation of observations) {
        for (const sector of observation.sectors) {
          const key = sectorKey(sector.kind, sector.vendorCode);
          if (!sectorsToObserve.has(key)) sectorsToObserve.set(key, sector);
        }
      }

      const insertChange = (change: Omit<SectorChangeEvent, 'seq'>): void => {
        tx.insert(sectorChangeEvents)
          .values({
            sectorId: change.sectorId,
            stockId: change.stockId,
            kind: change.kind,
            occurredAt: change.occurredAt,
            syncId: change.syncId,
            previousValue: change.previousValue,
            nextValue: change.nextValue,
          })
          .run();
      };

      let createdSectors = 0;
      let renamedSectors = 0;
      const sectorIdByKey = new Map<string, string>();
      for (const [key, sector] of sectorsToObserve) {
        const existing = previousByKey.get(key);
        if (existing === undefined) {
          const id = crypto.randomUUID();
          tx.insert(sectorCatalogEntries)
            .values({
              id,
              kind: sector.kind,
              source: input.source,
              vendorCode: sector.vendorCode,
              name: sector.name,
              state: 'active',
              firstSeenAt: appliedAt,
              lastSeenAt: appliedAt,
              retiredAt: null,
            })
            .run();
          sectorIdByKey.set(key, id);
          sectorNameById.set(id, sector.name);
          createdSectors += 1;
          insertChange({
            sectorId: id,
            stockId: null,
            kind: 'sector-created',
            occurredAt: appliedAt,
            syncId: input.syncId,
            previousValue: null,
            nextValue: sector.name,
          });
          continue;
        }

        sectorIdByKey.set(key, existing.id);
        const renamed = existing.name !== sector.name;
        const reactivated = existing.state === 'retired';
        tx.update(sectorCatalogEntries)
          .set({
            name: sector.name,
            state: 'active',
            lastSeenAt: appliedAt,
            retiredAt: null,
          })
          .where(eq(sectorCatalogEntries.id, existing.id))
          .run();
        sectorNameById.set(existing.id, sector.name);
        if (renamed) {
          renamedSectors += 1;
          insertChange({
            sectorId: existing.id,
            stockId: null,
            kind: 'sector-renamed',
            occurredAt: appliedAt,
            syncId: input.syncId,
            previousValue: existing.name,
            nextValue: sector.name,
          });
        }
        if (reactivated) {
          insertChange({
            sectorId: existing.id,
            stockId: null,
            kind: 'sector-reactivated',
            occurredAt: appliedAt,
            syncId: input.syncId,
            previousValue: existing.name,
            nextValue: sector.name,
          });
        }
      }

      // 只有目录请求成功的分类才允许下线；同类未出现的旧条目转 retired，历史保留。
      let retiredSectors = 0;
      for (const row of previousRows) {
        if (row.state !== 'active') continue;
        if (!input.catalogKinds.includes(row.kind)) continue;
        const key = sectorKey(row.kind, row.vendorCode);
        if (sectorIdByKey.has(key)) continue;
        tx.update(sectorCatalogEntries)
          .set({ state: 'retired', retiredAt: appliedAt })
          .where(eq(sectorCatalogEntries.id, row.id))
          .run();
        retiredSectors += 1;
        insertChange({
          sectorId: row.id,
          stockId: null,
          kind: 'sector-retired',
          occurredAt: appliedAt,
          syncId: input.syncId,
          previousValue: row.name,
          nextValue: null,
        });
      }

      const existingMemberships = tx
        .select()
        .from(sectorMemberships)
        .where(eq(sectorMemberships.source, input.source))
        .all();
      const membershipByKey = new Map(
        existingMemberships.map((row) => [`${row.sectorId}\u0000${row.stockId}`, row]),
      );
      const membershipsByStock = new Map<string, MembershipRow[]>();
      for (const row of existingMemberships) {
        const list = membershipsByStock.get(row.stockId) ?? [];
        list.push(row);
        membershipsByStock.set(row.stockId, list);
      }

      let createdMemberships = 0;
      let removedMemberships = 0;
      let reactivatedMemberships = 0;
      for (const observation of observations) {
        const memberStatus = statusByStock.get(observation.stockId) ?? 'unknown';
        const observed = new Set<string>();
        for (const sector of observation.sectors) {
          const sectorId = sectorIdByKey.get(sectorKey(sector.kind, sector.vendorCode));
          if (sectorId === undefined) continue;
          observed.add(sectorId);
          const existing = membershipByKey.get(`${sectorId}\u0000${observation.stockId}`);
          if (existing === undefined) {
            tx.insert(sectorMemberships)
              .values({
                sectorId,
                stockId: observation.stockId,
                source: input.source,
                state: 'active',
                memberStatus,
                firstSeenAt: appliedAt,
                lastSeenAt: appliedAt,
                missingSince: null,
                lastSyncId: input.syncId,
              })
              .run();
            createdMemberships += 1;
            insertChange({
              sectorId,
              stockId: observation.stockId,
              kind: 'member-entered',
              occurredAt: appliedAt,
              syncId: input.syncId,
              previousValue: null,
              nextValue: sector.name,
            });
            continue;
          }
          if (existing.state === 'missing') {
            tx.update(sectorMemberships)
              .set({
                state: 'active',
                memberStatus,
                lastSeenAt: appliedAt,
                missingSince: null,
                lastSyncId: input.syncId,
              })
              .where(
                and(
                  eq(sectorMemberships.sectorId, sectorId),
                  eq(sectorMemberships.stockId, observation.stockId),
                ),
              )
              .run();
            reactivatedMemberships += 1;
            insertChange({
              sectorId,
              stockId: observation.stockId,
              kind: 'member-rejoined',
              occurredAt: appliedAt,
              syncId: input.syncId,
              previousValue: null,
              nextValue: sector.name,
            });
            continue;
          }
          tx.update(sectorMemberships)
            .set({ memberStatus, lastSeenAt: appliedAt, lastSyncId: input.syncId })
            .where(
              and(
                eq(sectorMemberships.sectorId, sectorId),
                eq(sectorMemberships.stockId, observation.stockId),
              ),
            )
            .run();
        }

        // 只有本次真正观测到的股票才可能“退出”；未返回的股票保持原状。
        for (const membership of membershipsByStock.get(observation.stockId) ?? []) {
          if (membership.state !== 'active' || observed.has(membership.sectorId)) continue;
          tx.update(sectorMemberships)
            .set({ state: 'missing', missingSince: appliedAt, lastSyncId: input.syncId })
            .where(
              and(
                eq(sectorMemberships.sectorId, membership.sectorId),
                eq(sectorMemberships.stockId, observation.stockId),
              ),
            )
            .run();
          removedMemberships += 1;
          insertChange({
            sectorId: membership.sectorId,
            stockId: observation.stockId,
            kind: 'member-left',
            occurredAt: appliedAt,
            syncId: input.syncId,
            previousValue: sectorNameById.get(membership.sectorId) ?? null,
            nextValue: null,
          });
        }
      }

      // 停牌 / 退市 / 未观测的股票只更新状态，不删除成分关系。
      for (const { stockId, status } of stockStatuses) {
        tx.update(sectorMemberships)
          .set({ memberStatus: status })
          .where(
            and(eq(sectorMemberships.source, input.source), eq(sectorMemberships.stockId, stockId)),
          )
          .run();
      }

      const summary: SectorSyncApplySummary = {
        observedSectors: sectorsToObserve.size,
        createdSectors,
        renamedSectors,
        retiredSectors,
        observedStocks: observations.length,
        createdMemberships,
        removedMemberships,
        reactivatedMemberships,
      };
      tx.insert(sectorSyncRuns)
        .values({
          id: input.syncId,
          source: input.source,
          status: input.status,
          appliedAt,
          ...summary,
          failures: [...input.failures],
        })
        .run();
      return summary;
    });
  }

  async listByStock(input: {
    readonly stockIds: readonly string[];
    readonly kinds?: readonly SectorKind[];
    readonly includeMissing?: boolean;
  }): Promise<readonly StockSectorMembershipView[]> {
    if (input.stockIds.length === 0) return [];
    const filters: SQL[] = [inArray(sectorMemberships.stockId, [...input.stockIds])];
    if (input.includeMissing !== true) filters.push(eq(sectorMemberships.state, 'active'));
    if (input.kinds !== undefined && input.kinds.length > 0) {
      filters.push(inArray(sectorCatalogEntries.kind, [...input.kinds]));
    }
    return this.db
      .select({ membership: sectorMemberships, sector: sectorCatalogEntries })
      .from(sectorMemberships)
      .innerJoin(sectorCatalogEntries, eq(sectorCatalogEntries.id, sectorMemberships.sectorId))
      .where(and(...filters))
      .orderBy(
        asc(sectorMemberships.stockId),
        asc(sectorCatalogEntries.kind),
        asc(sectorCatalogEntries.vendorCode),
      )
      .all()
      .map(({ membership, sector }) => ({
        ...toMembership(membership),
        kind: sector.kind,
        vendorCode: sector.vendorCode,
        name: sector.name,
        sectorState: sector.state,
      }));
  }

  async listBySector(input: {
    readonly sectorId: string;
    readonly includeMissing?: boolean;
  }): Promise<readonly StockSectorMembership[]> {
    const filters: SQL[] = [eq(sectorMemberships.sectorId, input.sectorId)];
    if (input.includeMissing !== true) filters.push(eq(sectorMemberships.state, 'active'));
    return this.db
      .select()
      .from(sectorMemberships)
      .where(and(...filters))
      .orderBy(asc(sectorMemberships.stockId))
      .all()
      .map(toMembership);
  }

  async listBySectors(input: {
    readonly sectorIds: readonly string[];
    readonly includeMissing?: boolean;
  }): Promise<readonly StockSectorMembership[]> {
    if (input.sectorIds.length === 0) return [];
    const filters: SQL[] = [inArray(sectorMemberships.sectorId, [...input.sectorIds])];
    if (input.includeMissing !== true) filters.push(eq(sectorMemberships.state, 'active'));
    return this.db
      .select()
      .from(sectorMemberships)
      .where(and(...filters))
      .orderBy(asc(sectorMemberships.sectorId), asc(sectorMemberships.stockId))
      .all()
      .map(toMembership);
  }

  async listSectors(input?: {
    readonly kinds?: readonly SectorKind[];
    readonly state?: SectorCatalogState | 'all';
  }): Promise<readonly SectorCatalogEntry[]> {
    const filters: SQL[] = [];
    if (input?.kinds !== undefined && input.kinds.length > 0) {
      filters.push(inArray(sectorCatalogEntries.kind, [...input.kinds]));
    }
    const state = input?.state ?? 'active';
    if (state !== 'all') filters.push(eq(sectorCatalogEntries.state, state));
    return this.db
      .select()
      .from(sectorCatalogEntries)
      .where(filters.length === 0 ? undefined : and(...filters))
      .orderBy(asc(sectorCatalogEntries.kind), asc(sectorCatalogEntries.vendorCode))
      .all()
      .map(toEntry);
  }

  async listChanges(input?: {
    readonly sectorId?: string;
    readonly stockId?: string;
  }): Promise<readonly SectorChangeEvent[]> {
    const filters: SQL[] = [];
    if (input?.sectorId !== undefined) {
      filters.push(eq(sectorChangeEvents.sectorId, input.sectorId));
    }
    if (input?.stockId !== undefined) {
      filters.push(eq(sectorChangeEvents.stockId, input.stockId));
    }
    return this.db
      .select()
      .from(sectorChangeEvents)
      .where(filters.length === 0 ? undefined : and(...filters))
      .orderBy(asc(sectorChangeEvents.seq))
      .all()
      .map(toChange);
  }
}
