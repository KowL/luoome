import {
  DeliveryStatusSchema,
  dateInShanghai,
  isHoliday,
  isWeekend,
  ReportStatusSchema,
  WorkflowRunStatusSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

export const GetClosingBatchAuditInput = z.object({
  date: z.string().date().optional(),
  accountId: z.string().min(1).optional(),
});

const BatchAuditSchema = z.object({
  id: z.string(),
  status: WorkflowRunStatusSchema,
  outcome: z.enum(['complete', 'partial', 'blocked']).nullable(),
  startedAt: z.coerce.date(),
  finishedAt: z.coerce.date().optional(),
  durationMs: z.number().int().nonnegative().nullable(),
  errorCount: z.number().int().nonnegative(),
  error: z.string().optional(),
});

const ReportAuditSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  status: ReportStatusSchema,
  generatedAt: z.coerce.date(),
  deliveryStatus: DeliveryStatusSchema,
  workflowRunId: z.string(),
  missingDimensions: z.array(z.string()),
});

export const GetClosingBatchAuditOutput = z.object({
  date: z.string().date(),
  asOf: z.coerce.date(),
  batchStartsAt: z.coerce.date(),
  cutoffAt: z.coerce.date(),
  tradingDay: z.boolean(),
  cutoffPassed: z.boolean(),
  accounts: z.array(
    z.object({
      accountId: z.string(),
      accountName: z.string().optional(),
      inCurrentInventory: z.boolean(),
      expectedAtCutoff: z.boolean(),
      batchRuns: z.array(BatchAuditSchema),
      mainReport: ReportAuditSchema.nullable(),
      supplements: z.array(ReportAuditSchema),
      mainPublishedAfterCutoffMs: z.number().int().nonnegative().nullable(),
    }),
  ),
  summary: z.object({
    knownExpectedAccounts: z.number().int().nonnegative(),
    withMainReport: z.number().int().nonnegative(),
    missingMainAfterCutoff: z.number().int().nonnegative(),
    mainPublishedAfterCutoff: z.number().int().nonnegative(),
    partialMainReports: z.number().int().nonnegative(),
    supplementVersions: z.number().int().nonnegative(),
    mainDeliveryStatusCounts: z.record(z.string(), z.number().int().nonnegative()),
    unattributedBatchRuns: z.number().int().nonnegative(),
    legacyAllAccountReports: z.number().int().nonnegative(),
  }),
});

const batchOutcome = (value: unknown): 'complete' | 'partial' | 'blocked' | null =>
  value === 'complete' || value === 'partial' || value === 'blocked' ? value : null;

export const getClosingBatchAuditTool = defineTool({
  name: 'get_closing_batch_audit',
  description:
    '按交易日核对各账户计划批次、收盘主报告、补充版本和通知状态；显示 16:30/18:00 时间证据与缺口',
  sideEffect: 'read',
  input: GetClosingBatchAuditInput,
  output: GetClosingBatchAuditOutput,
  handler: async (input, ctx) => {
    const asOf = ctx.clock();
    const date = input.date ?? dateInShanghai(asOf);
    const batchStartsAt = new Date(`${date}T16:30:00+08:00`);
    const cutoffAt = new Date(`${date}T18:00:00+08:00`);
    const tradingDay = !isWeekend(batchStartsAt) && !isHoliday(batchStartsAt);
    const cutoffPassed = asOf >= cutoffAt;
    const [inventory, allBatches, allReports] = await Promise.all([
      ctx.repos.account.list(),
      ctx.repos.workflowRun.listAccountPlanBatches(date),
      ctx.repos.report.list({
        kind: 'closing',
        from: date,
        to: date,
        limit: Number.MAX_SAFE_INTEGER,
      }),
    ]);
    const scoped = (accountId: string): boolean =>
      input.accountId === undefined || input.accountId === accountId;
    const accounts = new Map(
      inventory.filter((account) => scoped(account.id)).map((a) => [a.id, a]),
    );
    const reportGroups = new Map<string, typeof allReports>();
    let legacyAllAccountReports = 0;
    for (const report of allReports) {
      if (report.scope.kind === 'all-accounts') {
        if (input.accountId === undefined) legacyAllAccountReports += 1;
        continue;
      }
      if (!scoped(report.scope.accountId)) continue;
      const group = reportGroups.get(report.scope.accountId) ?? [];
      reportGroups.set(report.scope.accountId, [...group, report]);
    }
    const batchGroups = new Map<string, typeof allBatches>();
    let unattributedBatchRuns = 0;
    for (const run of allBatches) {
      const accountId = run.inputSummary?.accountId;
      if (typeof accountId !== 'string' || accountId.length === 0) {
        if (input.accountId === undefined) unattributedBatchRuns += 1;
        continue;
      }
      if (!scoped(accountId)) continue;
      const group = batchGroups.get(accountId) ?? [];
      batchGroups.set(accountId, [...group, run]);
    }
    const accountIds = new Set([
      ...accounts.keys(),
      ...reportGroups.keys(),
      ...batchGroups.keys(),
      ...(input.accountId === undefined ? [] : [input.accountId]),
    ]);
    const mainDeliveryStatusCounts: Record<string, number> = Object.fromEntries(
      DeliveryStatusSchema.options.map((status) => [status, 0]),
    );
    const rows = [...accountIds].sort().map((accountId) => {
      const account = accounts.get(accountId);
      const reports = [...(reportGroups.get(accountId) ?? [])].sort(
        (a, b) => (a.version ?? 1) - (b.version ?? 1),
      );
      const batches = batchGroups.get(accountId) ?? [];
      const reportSummary = (report: (typeof allReports)[number]) => ({
        id: report.id,
        version: report.version ?? 1,
        status: report.status,
        generatedAt: report.generatedAt,
        deliveryStatus: report.deliveryStatus,
        workflowRunId: report.workflowRunId,
        missingDimensions: [
          ...new Set([
            ...report.missingDimensions.map((gap) => gap.dimension),
            ...report.sections.flatMap((section) =>
              section.missingDimensions.map((gap) => gap.dimension),
            ),
          ]),
        ].sort(),
      });
      const main = reports.find((report) => (report.version ?? 1) === 1);
      if (main !== undefined)
        mainDeliveryStatusCounts[main.deliveryStatus] =
          (mainDeliveryStatusCounts[main.deliveryStatus] ?? 0) + 1;
      const expectedAtCutoff =
        (tradingDay && account !== undefined && account.createdAt <= cutoffAt) ||
        batches.length > 0 ||
        reports.length > 0;
      return {
        accountId,
        ...(account === undefined ? {} : { accountName: account.name }),
        inCurrentInventory: account !== undefined,
        expectedAtCutoff,
        batchRuns: batches.map((run) => ({
          id: run.id,
          status: run.status,
          outcome: batchOutcome(run.outputSummary?.status),
          startedAt: run.startedAt,
          ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
          durationMs:
            run.finishedAt === undefined
              ? null
              : run.finishedAt.getTime() - run.startedAt.getTime(),
          errorCount: Array.isArray(run.outputSummary?.errors)
            ? run.outputSummary.errors.length
            : 0,
          ...(run.error === undefined ? {} : { error: run.error }),
        })),
        mainReport: main === undefined ? null : reportSummary(main),
        supplements: reports.filter((report) => (report.version ?? 1) > 1).map(reportSummary),
        mainPublishedAfterCutoffMs:
          main === undefined ? null : Math.max(0, main.generatedAt.getTime() - cutoffAt.getTime()),
      };
    });
    return {
      date,
      asOf,
      batchStartsAt,
      cutoffAt,
      tradingDay,
      cutoffPassed,
      accounts: rows,
      summary: {
        knownExpectedAccounts: rows.filter((row) => row.expectedAtCutoff).length,
        withMainReport: rows.filter((row) => row.mainReport !== null).length,
        missingMainAfterCutoff: cutoffPassed
          ? rows.filter((row) => row.expectedAtCutoff && row.mainReport === null).length
          : 0,
        mainPublishedAfterCutoff: rows.filter(
          (row) => row.mainPublishedAfterCutoffMs !== null && row.mainPublishedAfterCutoffMs > 0,
        ).length,
        partialMainReports: rows.filter((row) => row.mainReport?.status === 'partial').length,
        supplementVersions: rows.reduce((sum, row) => sum + row.supplements.length, 0),
        mainDeliveryStatusCounts,
        unattributedBatchRuns,
        legacyAllAccountReports,
      },
    };
  },
});
