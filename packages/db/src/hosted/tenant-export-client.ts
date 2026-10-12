import {
  AlertPlanSchema,
  InvariantError,
  PersonalWatchFeedbackSchema,
  ReportSchema,
  type TenantExportRepository,
  type TenantExportRequest,
  TenantExportRequestSchema,
  type TenantExportSnapshotRecord,
  TenantExportSnapshotRecordSchema,
  WatchlistMemberSchema,
  WatchlistMemberSourceSchema,
  WatchlistSchema,
} from '@luoome/core';
import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '../client.js';
import { toWatchTrigger } from '../repository/drizzle/watch-trigger.js';
import {
  alertPlans,
  reports,
  watchlistMemberSources,
  watchlistMembers,
  watchlists,
  watchTriggers,
} from '../schema/index.js';
import { buildTenantExportRecord } from './tenant-export-record.js';
import { tenantExportSnapshots } from './tenant-export-schema.js';
import { personalWatchFeedback } from './tenant-schema.js';

const withoutNull = (row: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));

export class DrizzleTenantExportRepository implements TenantExportRepository {
  constructor(private readonly db: DrizzleDb) {}

  async createSnapshot(
    input: TenantExportRequest,
  ): Promise<TenantExportSnapshotRecord & { readonly replayed: boolean }> {
    const request = TenantExportRequestSchema.parse(input);
    return this.db.transaction(
      (tx) => {
        const existing = tx
          .select()
          .from(tenantExportSnapshots)
          .where(eq(tenantExportSnapshots.operationId, request.operationId))
          .get();
        if (existing !== undefined) {
          if (
            existing.inputHash !== request.inputHash ||
            existing.generation !== request.generation
          )
            throw new InvariantError('export operation input identity conflict');
          return { ...TenantExportSnapshotRecordSchema.parse(existing), replayed: true };
        }
        const record = buildTenantExportRecord(request, {
          watchlists: tx
            .select()
            .from(watchlists)
            .all()
            .map((row) => WatchlistSchema.parse(withoutNull(row))),
          members: tx
            .select()
            .from(watchlistMembers)
            .all()
            .map((row) => WatchlistMemberSchema.parse(withoutNull(row))),
          sources: tx
            .select()
            .from(watchlistMemberSources)
            .all()
            .map((row) => WatchlistMemberSourceSchema.parse(withoutNull(row))),
          alertPlans: tx
            .select()
            .from(alertPlans)
            .all()
            .map((row) => AlertPlanSchema.parse(withoutNull(row))),
          triggers: tx.select().from(watchTriggers).all().map(toWatchTrigger),
          reports: tx
            .select()
            .from(reports)
            .all()
            .map((row) => ReportSchema.parse(withoutNull(row))),
          feedback: tx
            .select()
            .from(personalWatchFeedback)
            .all()
            .map((row) => PersonalWatchFeedbackSchema.parse(row.feedback)),
        });
        tx.insert(tenantExportSnapshots).values(record).run();
        return { ...record, replayed: false };
      },
      { behavior: 'immediate' },
    );
  }

  async findSnapshot(operationId: string): Promise<TenantExportSnapshotRecord | null> {
    const row = this.db
      .select()
      .from(tenantExportSnapshots)
      .where(eq(tenantExportSnapshots.operationId, operationId))
      .get();
    return row === undefined ? null : TenantExportSnapshotRecordSchema.parse(row);
  }
}
