import {
  type ReportDeliveryIntent,
  type ReportExecutionLease,
  reportScopeKey,
  type WatchNotificationSettings,
} from '@luoome/core';
import type { InMemoryReportRepository } from '../repository/memory/report.js';
import { createReportAutomationRepository } from './report-automation-store.js';

export const createMemoryReportAutomationRepository = (
  report: InMemoryReportRepository,
  settings: () => WatchNotificationSettings,
) => {
  let lease: ReportExecutionLease | null = null;
  let intents = new Map<string, ReportDeliveryIntent>();
  return createReportAutomationRepository({
    transaction: (run) => {
      const before = structuredClone({ lease, intents, reports: report.snapshotForExport() });
      try {
        return run();
      } catch (error) {
        lease = before.lease;
        intents = before.intents;
        for (const value of before.reports) report.put(value);
        throw error;
      }
    },
    lease: () => structuredClone(lease),
    putLease: (value) => {
      lease = structuredClone(value);
    },
    settings,
    report: (id) => report.snapshotForExport().find((item) => item.id === id) ?? null,
    period: (value) =>
      report
        .snapshotForExport()
        .filter(
          (item) =>
            item.kind === value.kind &&
            reportScopeKey(item.scope) === reportScopeKey(value.scope) &&
            item.periodStart === value.periodStart &&
            item.periodEnd === value.periodEnd,
        )
        .sort((a, b) => (b.version ?? 1) - (a.version ?? 1))[0] ?? null,
    insert: (value) => {
      report.put(value);
    },
    project: (value) => {
      report.put(value);
    },
    intents: () => structuredClone([...intents.values()]),
    intent: (id) => structuredClone(intents.get(id) ?? null),
    put: (intent) => {
      intents.set(intent.resultRef, structuredClone(intent));
    },
  });
};
