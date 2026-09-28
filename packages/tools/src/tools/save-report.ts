import { assertReportInvariants, ReportSchema, reportScopeKey } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

export const SaveReportInput = z.object({
  report: ReportSchema,
  deliveryAttemptId: z.string().min(1).optional(),
});

export const SaveReportOutput = z.object({
  report: ReportSchema,
  created: z.boolean(),
  deliveryClaimed: z.boolean().optional(),
});

export const saveReportTool = defineTool({
  name: 'save_report',
  description: '按 kind/scope/period/version 保存结构化市场报告；收盘报告版本不可覆盖',
  sideEffect: 'write',
  input: SaveReportInput,
  output: SaveReportOutput,
  handler: async (input, ctx) => {
    assertReportInvariants(input.report);
    const existing = await ctx.repos.report.findByPeriodVersion({
      kind: input.report.kind,
      scopeKey: reportScopeKey(input.report.scope),
      periodStart: input.report.periodStart,
      periodEnd: input.report.periodEnd,
      version: input.report.version ?? 1,
    });
    const report = await ctx.repos.report.upsertForPeriod(input.report);
    const created = existing === null && report.id === input.report.id;
    if (input.deliveryAttemptId === undefined) return { report, created };
    const now = ctx.clock();
    const deliveryClaimed = await ctx.repos.report.claimDelivery({
      id: report.id,
      attemptId: input.deliveryAttemptId,
      now,
      stalePendingBefore: new Date(now.getTime() - 5 * 60_000),
      failedRetryBefore: new Date(now.getTime() - 15 * 60_000),
    });
    const current = await ctx.repos.report.findById(report.id);
    return { report: current ?? report, created, deliveryClaimed };
  },
});
