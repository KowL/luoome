import {
  DeliveryStatusSchema,
  ReportKindSchema,
  ReportScopeSchema,
  ReportStatusSchema,
  reportScopeKey,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

export const ListReportsInput = z.object({
  kind: ReportKindSchema.optional(),
  scope: ReportScopeSchema.optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  status: ReportStatusSchema.optional(),
  limit: z.number().int().positive().max(200).default(30),
});

export const ReportSummarySchema = z.object({
  id: z.string(),
  kind: ReportKindSchema,
  scope: ReportScopeSchema,
  periodStart: z.string().date(),
  periodEnd: z.string().date(),
  title: z.string(),
  generatedAt: z.coerce.date(),
  dataAsOf: z.coerce.date(),
  status: ReportStatusSchema,
  deliveryStatus: DeliveryStatusSchema,
});

export const ListReportsOutput = z.object({
  reports: z.array(ReportSummarySchema),
});

export const listReportsTool = defineTool({
  name: 'list_reports',
  description: '查询报告历史摘要，不返回 sections/evidence 大字段',
  sideEffect: 'read',
  input: ListReportsInput,
  output: ListReportsOutput,
  handler: async (input, ctx) => {
    const reports = await ctx.repos.report.list({
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.scope !== undefined ? { scopeKey: reportScopeKey(input.scope) } : {}),
      ...(input.from !== undefined ? { from: input.from } : {}),
      ...(input.to !== undefined ? { to: input.to } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      limit: input.limit,
    });
    return {
      reports: reports.map((report) => ({
        id: report.id,
        kind: report.kind,
        scope: report.scope,
        periodStart: report.periodStart,
        periodEnd: report.periodEnd,
        title: report.title,
        generatedAt: report.generatedAt,
        dataAsOf: report.dataAsOf,
        status: report.status,
        deliveryStatus: report.deliveryStatus,
      })),
    };
  },
});
