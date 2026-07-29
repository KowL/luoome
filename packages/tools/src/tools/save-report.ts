import { assertReportInvariants, ReportSchema, reportScopeKey } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

export const SaveReportInput = z.object({
  report: ReportSchema,
});

export const SaveReportOutput = z.object({
  report: ReportSchema,
  created: z.boolean(),
});

export const saveReportTool = defineTool({
  name: 'save_report',
  description: '按 kind/scope/period 逻辑键幂等保存结构化市场报告',
  sideEffect: 'write',
  input: SaveReportInput,
  output: SaveReportOutput,
  handler: async (input, ctx) => {
    assertReportInvariants(input.report);
    const existing = await ctx.repos.report.findByPeriod({
      kind: input.report.kind,
      scopeKey: reportScopeKey(input.report.scope),
      periodStart: input.report.periodStart,
      periodEnd: input.report.periodEnd,
    });
    const report = await ctx.repos.report.upsertForPeriod(input.report);
    return { report, created: existing === null };
  },
});
