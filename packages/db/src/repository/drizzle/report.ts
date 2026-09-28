import {
  assertReportDeliveryTransition,
  assertReportInvariants,
  type DeliveryStatus,
  InvariantError,
  type Report,
  type ReportRepository,
  ReportSchema,
  reportScopeKey,
} from '@luoome/core';
import { and, desc, eq, gte, lte, or, type SQL } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { reports, type Schema } from '../../schema/index.js';

type ReportRow = typeof reports.$inferSelect;

const toReport = (row: ReportRow): Report => {
  const report = ReportSchema.parse({
    id: row.id,
    version: row.version,
    ...(row.supersedesReportId === null ? {} : { supersedesReportId: row.supersedesReportId }),
    kind: row.kind,
    scope: row.scope,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    title: row.title,
    generatedAt: row.generatedAt,
    dataAsOf: row.dataAsOf,
    status: row.status,
    sections: row.sections,
    evidence: row.evidence,
    missingDimensions: row.missingDimensions,
    deliveryStatus: row.deliveryStatus,
    workflowRunId: row.workflowRunId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  assertReportInvariants(report);
  return report;
};

const toRow = (report: Report): typeof reports.$inferInsert => ({
  id: report.id,
  version: report.version ?? 1,
  supersedesReportId: report.supersedesReportId ?? null,
  kind: report.kind,
  scopeKey: reportScopeKey(report.scope),
  scope: report.scope,
  periodStart: report.periodStart,
  periodEnd: report.periodEnd,
  title: report.title,
  generatedAt: report.generatedAt,
  dataAsOf: report.dataAsOf,
  status: report.status,
  sections: report.sections,
  evidence: report.evidence,
  missingDimensions: report.missingDimensions,
  deliveryStatus: report.deliveryStatus,
  deliveryAttemptId: null,
  workflowRunId: report.workflowRunId,
  createdAt: report.createdAt,
  updatedAt: report.updatedAt,
});

export class DrizzleReportRepository implements ReportRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async upsertForPeriod(report: Report): Promise<Report> {
    const parsed = ReportSchema.parse(report);
    assertReportInvariants(parsed);
    const version = parsed.version ?? 1;
    const key = {
      kind: parsed.kind,
      scopeKey: reportScopeKey(parsed.scope),
      periodStart: parsed.periodStart,
      periodEnd: parsed.periodEnd,
    };
    if (version > 1) {
      const previous = await this.findByPeriodVersion({ ...key, version: version - 1 });
      if (previous?.id !== parsed.supersedesReportId)
        throw new InvariantError('report supplement predecessor mismatch');
    }
    const row = toRow(parsed);
    const conflictTarget = [
      reports.kind,
      reports.scopeKey,
      reports.periodStart,
      reports.periodEnd,
      reports.version,
    ];
    if (parsed.kind === 'closing') {
      this.db.insert(reports).values(row).onConflictDoNothing({ target: conflictTarget }).run();
      const saved = await this.findByPeriodVersion({ ...key, version });
      if (saved === null) throw new InvariantError('closing report insert did not produce a row');
      return saved;
    }
    this.db
      .insert(reports)
      .values(row)
      .onConflictDoUpdate({
        target: conflictTarget,
        set: {
          supersedesReportId: row.supersedesReportId,
          scope: row.scope,
          title: row.title,
          generatedAt: row.generatedAt,
          dataAsOf: row.dataAsOf,
          status: row.status,
          sections: row.sections,
          evidence: row.evidence,
          missingDimensions: row.missingDimensions,
          deliveryStatus: row.deliveryStatus,
          workflowRunId: row.workflowRunId,
          updatedAt: row.updatedAt,
        },
      })
      .run();
    const saved = await this.findByPeriodVersion({ ...key, version });
    if (saved === null) throw new Error('report upsert did not produce a readable row');
    return saved;
  }

  async findById(id: string): Promise<Report | null> {
    const row = this.db.select().from(reports).where(eq(reports.id, id)).get();
    return row === undefined ? null : toReport(row);
  }

  async findByPeriodVersion(input: {
    readonly kind: Report['kind'];
    readonly scopeKey: string;
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly version: number;
  }): Promise<Report | null> {
    const row = this.db
      .select()
      .from(reports)
      .where(
        and(
          eq(reports.kind, input.kind),
          eq(reports.scopeKey, input.scopeKey),
          eq(reports.periodStart, input.periodStart),
          eq(reports.periodEnd, input.periodEnd),
          eq(reports.version, input.version),
        ),
      )
      .get();
    return row === undefined ? null : toReport(row);
  }

  async findByPeriod(input: {
    readonly kind: Report['kind'];
    readonly scopeKey: string;
    readonly periodStart: string;
    readonly periodEnd: string;
  }): Promise<Report | null> {
    const row = this.db
      .select()
      .from(reports)
      .where(
        and(
          eq(reports.kind, input.kind),
          eq(reports.scopeKey, input.scopeKey),
          eq(reports.periodStart, input.periodStart),
          eq(reports.periodEnd, input.periodEnd),
        ),
      )
      .orderBy(desc(reports.version))
      .get();
    return row === undefined ? null : toReport(row);
  }

  async list(
    input: {
      readonly kind?: Report['kind'];
      readonly scopeKey?: string;
      readonly from?: string;
      readonly to?: string;
      readonly status?: Report['status'];
      readonly limit?: number;
    } = {},
  ): Promise<readonly Report[]> {
    const conditions: SQL[] = [];
    if (input.kind !== undefined) conditions.push(eq(reports.kind, input.kind));
    if (input.scopeKey !== undefined) conditions.push(eq(reports.scopeKey, input.scopeKey));
    if (input.from !== undefined) conditions.push(gte(reports.periodEnd, input.from));
    if (input.to !== undefined) conditions.push(lte(reports.periodEnd, input.to));
    if (input.status !== undefined) conditions.push(eq(reports.status, input.status));
    const where = conditions.length === 0 ? undefined : and(...conditions);
    return this.db
      .select()
      .from(reports)
      .where(where)
      .orderBy(desc(reports.periodEnd), desc(reports.version), desc(reports.generatedAt))
      .limit(input.limit ?? 30)
      .all()
      .map(toReport);
  }

  async setDeliveryStatus(id: string, status: DeliveryStatus): Promise<void> {
    const current = await this.findById(id);
    if (current === null) return;
    assertReportDeliveryTransition(current.deliveryStatus, status);
    this.db
      .update(reports)
      .set({ deliveryStatus: status, deliveryAttemptId: null })
      .where(eq(reports.id, id))
      .run();
  }

  async claimDelivery(input: {
    readonly id: string;
    readonly attemptId: string;
    readonly now: Date;
    readonly stalePendingBefore: Date;
    readonly failedRetryBefore: Date;
  }): Promise<boolean> {
    const claimed = this.db
      .update(reports)
      .set({
        deliveryStatus: 'pending',
        deliveryAttemptId: input.attemptId,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(reports.id, input.id),
          or(
            eq(reports.deliveryStatus, 'not-requested'),
            and(
              or(eq(reports.deliveryStatus, 'failed'), eq(reports.deliveryStatus, 'fallback-log')),
              lte(reports.updatedAt, input.failedRetryBefore),
            ),
            and(
              eq(reports.deliveryStatus, 'pending'),
              lte(reports.updatedAt, input.stalePendingBefore),
            ),
          ),
        ),
      )
      .returning({ id: reports.id })
      .get();
    return claimed !== undefined;
  }

  async finishDelivery(input: {
    readonly id: string;
    readonly attemptId: string;
    readonly status: 'sent' | 'fallback-log' | 'failed';
    readonly now: Date;
  }): Promise<boolean> {
    const finished = this.db
      .update(reports)
      .set({
        deliveryStatus: input.status,
        deliveryAttemptId: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(reports.id, input.id),
          eq(reports.deliveryStatus, 'pending'),
          eq(reports.deliveryAttemptId, input.attemptId),
        ),
      )
      .returning({ id: reports.id })
      .get();
    return finished !== undefined;
  }

  async remove(id: string): Promise<void> {
    const child = this.db
      .select({ id: reports.id })
      .from(reports)
      .where(eq(reports.supersedesReportId, id))
      .get();
    if (child !== undefined) throw new InvariantError('report has supplements');
    this.db.delete(reports).where(eq(reports.id, id)).run();
  }
}
