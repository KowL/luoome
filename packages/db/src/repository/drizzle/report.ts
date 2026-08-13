import {
  assertReportDeliveryTransition,
  assertReportInvariants,
  type DeliveryStatus,
  type Report,
  type ReportRepository,
  ReportSchema,
  reportScopeKey,
} from '@luoome/core';
import { and, desc, eq, gte, lte, type SQL } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { reports, type Schema } from '../../schema/index.js';

type ReportRow = typeof reports.$inferSelect;

const toReport = (row: ReportRow): Report => {
  const report = ReportSchema.parse({
    id: row.id,
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
  workflowRunId: report.workflowRunId,
  createdAt: report.createdAt,
  updatedAt: report.updatedAt,
});

export class DrizzleReportRepository implements ReportRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async upsertForPeriod(report: Report): Promise<Report> {
    const parsed = ReportSchema.parse(report);
    assertReportInvariants(parsed);
    const row = toRow(parsed);
    this.db
      .insert(reports)
      .values(row)
      .onConflictDoUpdate({
        target: [reports.kind, reports.scopeKey, reports.periodStart, reports.periodEnd],
        set: {
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
    const saved = await this.findByPeriod({
      kind: parsed.kind,
      scopeKey: reportScopeKey(parsed.scope),
      periodStart: parsed.periodStart,
      periodEnd: parsed.periodEnd,
    });
    if (saved === null) throw new Error('report upsert did not produce a readable row');
    return saved;
  }

  async findById(id: string): Promise<Report | null> {
    const row = this.db.select().from(reports).where(eq(reports.id, id)).get();
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
      .orderBy(desc(reports.periodEnd), desc(reports.generatedAt))
      .limit(input.limit ?? 30)
      .all()
      .map(toReport);
  }

  async setDeliveryStatus(id: string, status: DeliveryStatus): Promise<void> {
    const current = await this.findById(id);
    if (current === null) return;
    assertReportDeliveryTransition(current.deliveryStatus, status);
    this.db.update(reports).set({ deliveryStatus: status }).where(eq(reports.id, id)).run();
  }

  async remove(id: string): Promise<void> {
    this.db.delete(reports).where(eq(reports.id, id)).run();
  }
}
