import { createHash } from 'node:crypto';
import {
  assertReportDeliveryTransition,
  assertReportInvariants,
  type DeliveryStatus,
  InvariantError,
  type Report,
  type ReportRepository,
  ReportSchema,
  reportScopeKey,
  TradeSchema,
} from '@luoome/core';
import { and, desc, eq, gte, isNull, lte, or, type SQL, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { reports, type Schema, trades } from '../../schema/index.js';

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
    ...(row.notificationPolicy === null ? {} : { notificationPolicy: row.notificationPolicy }),
    ...(row.decisionReviewSnapshot === null
      ? {}
      : { decisionReviewSnapshot: row.decisionReviewSnapshot }),
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
  notificationPolicy: report.notificationPolicy ?? null,
  decisionReviewSnapshot: report.decisionReviewSnapshot ?? null,
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
    if (parsed.kind === 'closing' || parsed.kind === 'weekly') {
      this.db.insert(reports).values(row).onConflictDoNothing({ target: conflictTarget }).run();
      const saved = await this.findByPeriodVersion({ ...key, version });
      if (saved === null) throw new InvariantError('versioned report insert did not produce a row');
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
          notificationPolicy: row.notificationPolicy,
          decisionReviewSnapshot: row.decisionReviewSnapshot,
          workflowRunId: row.workflowRunId,
          updatedAt: row.updatedAt,
        },
      })
      .run();
    const saved = await this.findByPeriodVersion({ ...key, version });
    if (saved === null) throw new Error('report upsert did not produce a readable row');
    return saved;
  }

  async findRefreshReceipt(input: Parameters<ReportRepository['findRefreshReceipt']>[0]) {
    const receipt = this.db.all<{ requestHash: string; reportId: string }>(sql`
      SELECT request_hash AS requestHash, report_id AS reportId FROM report_refresh_receipts
      WHERE account_id = ${input.accountId} AND request_id = ${input.requestId}
    `)[0];
    if (receipt === undefined) return null;
    const report = await this.findById(receipt.reportId);
    if (report === null) throw new InvariantError('report refresh receipt target missing');
    return { requestHash: receipt.requestHash, report };
  }

  async reuseDecisionReviewReport(
    input: Parameters<ReportRepository['reuseDecisionReviewReport']>[0],
  ) {
    return this.db.transaction(
      (tx) => {
        const receipt = tx.all<{ requestHash: string; reportId: string }>(sql`
        SELECT request_hash AS requestHash, report_id AS reportId FROM report_refresh_receipts
        WHERE account_id = ${input.accountId} AND request_id = ${input.requestId}
      `)[0];
        if (receipt !== undefined) {
          if (receipt.requestHash !== input.requestHash)
            throw new InvariantError('report refresh request identity conflict');
          const row = tx.select().from(reports).where(eq(reports.id, receipt.reportId)).get();
          if (row === undefined) throw new InvariantError('report refresh receipt target missing');
          return toReport(row);
        }
        const row = tx.select().from(reports).where(eq(reports.id, input.reportId)).get();
        if (
          row === undefined ||
          row.scope.kind !== 'account' ||
          row.scope.accountId !== input.accountId
        )
          throw new InvariantError('report refresh scope changed');
        const latest = tx
          .select()
          .from(reports)
          .where(
            and(
              eq(reports.kind, row.kind),
              eq(reports.scopeKey, row.scopeKey),
              eq(reports.periodStart, row.periodStart),
              eq(reports.periodEnd, row.periodEnd),
            ),
          )
          .orderBy(desc(reports.version))
          .limit(1)
          .get();
        if (latest?.id !== row.id) throw new InvariantError('report latest version changed');
        const watermark =
          tx.all<{ sequence: number | null }>(sql`
        SELECT max(r.sequence) AS sequence FROM decision_review_revisions r
        JOIN decision_reviews d ON d.id = r.review_id WHERE d.account_id = ${input.accountId}
      `)[0]?.sequence ?? 0;
        if (watermark !== input.throughSequence)
          throw new InvariantError('decision review facts changed before report commit');
        tx.run(sql`INSERT INTO report_refresh_receipts (account_id, request_id, request_hash, report_id)
        VALUES (${input.accountId}, ${input.requestId}, ${input.requestHash}, ${row.id})`);
        return toReport(row);
      },
      { behavior: 'immediate' },
    );
  }

  async appendDecisionReviewSupplement(
    input: Parameters<ReportRepository['appendDecisionReviewSupplement']>[0],
  ) {
    return this.db.transaction(
      (tx) => {
        const snapshot = input.report.decisionReviewSnapshot;
        if (
          snapshot === undefined ||
          input.report.notificationPolicy !== 'never' ||
          input.report.scope.kind !== 'account' ||
          input.report.scope.accountId !== snapshot.accountId
        )
          throw new InvariantError(
            'decision review supplement requires account snapshot and never policy',
          );
        const receipt = tx.all<{ requestHash: string; reportId: string }>(sql`
        SELECT request_hash AS requestHash, report_id AS reportId FROM report_refresh_receipts
        WHERE account_id = ${snapshot.accountId} AND request_id = ${input.requestId}
      `)[0];
        if (receipt !== undefined) {
          if (receipt.requestHash !== input.requestHash)
            throw new InvariantError('report refresh request identity conflict');
          const row = tx.select().from(reports).where(eq(reports.id, receipt.reportId)).get();
          if (row === undefined) throw new InvariantError('report refresh receipt target missing');
          return { report: toReport(row), created: false, replayed: true };
        }
        const latest = tx
          .select()
          .from(reports)
          .where(
            and(
              eq(reports.kind, input.report.kind),
              eq(reports.scopeKey, reportScopeKey(input.report.scope)),
              eq(reports.periodStart, input.report.periodStart),
              eq(reports.periodEnd, input.report.periodEnd),
            ),
          )
          .orderBy(desc(reports.version))
          .limit(1)
          .get();
        if (
          latest?.id !== input.expectedLatestReportId ||
          input.report.supersedesReportId !== latest.id ||
          input.report.version !== latest.version + 1
        )
          throw new InvariantError('report latest version changed');
        const watermark =
          tx.all<{ sequence: number | null }>(sql`
        SELECT max(r.sequence) AS sequence FROM decision_review_revisions r
        JOIN decision_reviews d ON d.id = r.review_id WHERE d.account_id = ${snapshot.accountId}
      `)[0]?.sequence ?? 0;
        if (watermark !== snapshot.throughSequence)
          throw new InvariantError('decision review facts changed before report commit');
        for (const [id, hash] of Object.entries(snapshot.tradeFactHashes)) {
          const row = tx.select().from(trades).where(eq(trades.id, id)).get();
          const current =
            row === undefined
              ? 'missing'
              : createHash('sha256')
                  .update(
                    JSON.stringify(
                      TradeSchema.parse({
                        ...row,
                        adviceId: row.adviceId ?? undefined,
                        researchHypothesisVersionId: row.researchHypothesisVersionId ?? undefined,
                        strategyVersionId: row.strategyVersionId ?? undefined,
                      }),
                    ),
                  )
                  .digest('hex');
          if (current !== hash)
            throw new InvariantError('decision review trade facts changed before report commit');
        }
        const parsed = ReportSchema.parse(input.report);
        assertReportInvariants(parsed);
        tx.insert(reports).values(toRow(parsed)).run();
        tx.run(sql`INSERT INTO report_refresh_receipts (account_id, request_id, request_hash, report_id)
        VALUES (${snapshot.accountId}, ${input.requestId}, ${input.requestHash}, ${parsed.id})`);
        return { report: parsed, created: true, replayed: false };
      },
      { behavior: 'immediate' },
    );
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
      readonly latestOnly?: boolean;
      readonly limit?: number;
    } = {},
  ): Promise<readonly Report[]> {
    const conditions: SQL[] = [];
    if (input.kind !== undefined) conditions.push(eq(reports.kind, input.kind));
    if (input.scopeKey !== undefined) conditions.push(eq(reports.scopeKey, input.scopeKey));
    if (input.from !== undefined) conditions.push(gte(reports.periodEnd, input.from));
    if (input.to !== undefined) conditions.push(lte(reports.periodEnd, input.to));
    if (input.status !== undefined) conditions.push(eq(reports.status, input.status));
    if (input.latestOnly)
      conditions.push(sql`NOT EXISTS (
        SELECT 1 FROM reports newer
        WHERE newer.kind = ${reports.kind} AND newer.scope_key = ${reports.scopeKey}
          AND newer.period_start = ${reports.periodStart} AND newer.period_end = ${reports.periodEnd}
          AND newer.version > ${reports.version}
      )`);
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
    if (current.notificationPolicy === 'never' && status !== 'not-requested')
      throw new InvariantError('never report cannot enter delivery');
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
          or(eq(reports.notificationPolicy, 'eligible'), isNull(reports.notificationPolicy)),
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
          or(eq(reports.notificationPolicy, 'eligible'), isNull(reports.notificationPolicy)),
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
