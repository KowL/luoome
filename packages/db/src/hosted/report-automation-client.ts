import {
  defaultWatchNotificationSettings,
  ReportDeliveryIntentSchema,
  type ReportExecutionLease,
  reportScopeKey,
  WatchNotificationSettingsSchema,
} from '@luoome/core';
import { and, desc, eq } from 'drizzle-orm';
import type { DrizzleDb } from '../client.js';
import { toReport, toRow } from '../repository/drizzle/report.js';
import { reports } from '../schema/index.js';
import { reportDeliveryIntents, reportExecution } from './report-automation-schema.js';
import { createReportAutomationRepository } from './report-automation-store.js';
import { watchNotificationSettings } from './watch-delivery-schema.js';

export const createDrizzleReportAutomationRepository = (db: DrizzleDb) =>
  createReportAutomationRepository({
    transaction: (run) => db.transaction(() => run(), { behavior: 'immediate' }),
    lease: () => {
      const row = db.select().from(reportExecution).where(eq(reportExecution.id, 'reports')).get();
      if (row === undefined) return null;
      const lease = row.lease;
      return { ...lease, until: new Date(lease.until), nextTickAt: new Date(lease.nextTickAt) };
    },
    putLease: (lease: ReportExecutionLease) => {
      db.insert(reportExecution)
        .values({ id: 'reports', lease })
        .onConflictDoUpdate({ target: reportExecution.id, set: { lease } })
        .run();
    },
    settings: () => {
      const row = db
        .select()
        .from(watchNotificationSettings)
        .where(eq(watchNotificationSettings.id, 'feishu'))
        .get();
      return row === undefined
        ? defaultWatchNotificationSettings()
        : WatchNotificationSettingsSchema.parse(row.settings);
    },
    report: (id) => {
      const row = db.select().from(reports).where(eq(reports.id, id)).get();
      return row === undefined ? null : toReport(row);
    },
    period: (report) => {
      const row = db
        .select()
        .from(reports)
        .where(
          and(
            eq(reports.kind, report.kind),
            eq(reports.scopeKey, reportScopeKey(report.scope)),
            eq(reports.periodStart, report.periodStart),
            eq(reports.periodEnd, report.periodEnd),
          ),
        )
        .orderBy(desc(reports.version))
        .get();
      return row === undefined ? null : toReport(row);
    },
    insert: (report) => {
      db.insert(reports).values(toRow(report)).run();
    },
    project: (report) => {
      db.update(reports)
        .set({ deliveryStatus: report.deliveryStatus, updatedAt: report.updatedAt })
        .where(eq(reports.id, report.id))
        .run();
    },
    intents: () =>
      db
        .select()
        .from(reportDeliveryIntents)
        .all()
        .map((row) => ReportDeliveryIntentSchema.parse(row.intent)),
    intent: (reportId) => {
      const row = db
        .select()
        .from(reportDeliveryIntents)
        .where(eq(reportDeliveryIntents.reportId, reportId))
        .get();
      return row === undefined ? null : ReportDeliveryIntentSchema.parse(row.intent);
    },
    put: (intent) => {
      db.insert(reportDeliveryIntents)
        .values({ reportId: intent.resultRef, intent })
        .onConflictDoUpdate({ target: reportDeliveryIntents.reportId, set: { intent } })
        .run();
    },
  });
