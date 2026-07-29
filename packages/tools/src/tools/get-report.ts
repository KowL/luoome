import {
  BUILTIN_HOLIDAYS,
  isHoliday,
  isWeekend,
  ReportKindSchema,
  ReportSchema,
  ReportScopeSchema,
  reportScopeKey,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

export const GetReportInput = z
  .object({
    id: z.string().min(1).optional(),
    kind: ReportKindSchema.optional(),
    scope: ReportScopeSchema.optional(),
    periodEnd: z.string().date().optional(),
  })
  .superRefine((input, context) => {
    const byId = input.id !== undefined;
    const byPeriod = input.kind !== undefined && input.periodEnd !== undefined;
    if (byId === byPeriod) {
      context.addIssue({
        code: 'custom',
        message: '必须且只能提供 id，或提供 kind + periodEnd',
      });
    }
  });
export const GetReportOutput = z.object({ report: ReportSchema });

const mondayOf = (date: string): Date => {
  const value = new Date(`${date}T04:00:00.000Z`);
  const daysSinceMonday = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - daysSinceMonday);
  return value;
};

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

const derivePeriodStart = (kind: z.infer<typeof ReportKindSchema>, periodEnd: string): string => {
  if (kind !== 'weekly') return periodEnd;
  const start = mondayOf(periodEnd);
  const end = new Date(`${periodEnd}T04:00:00.000Z`);
  while (start.getTime() <= end.getTime()) {
    if (!isWeekend(start) && !isHoliday(start, BUILTIN_HOLIDAYS)) return isoDate(start);
    start.setUTCDate(start.getUTCDate() + 1);
  }
  return periodEnd;
};

export const getReportTool = defineTool({
  name: 'get_report',
  description: '按 id 或 kind/scope/periodEnd 查询已保存报告；找不到时不隐式生成',
  sideEffect: 'read',
  input: GetReportInput,
  output: GetReportOutput,
  handler: async (input, ctx) => {
    if (input.id !== undefined) {
      const report = await ctx.repos.report.findById(input.id);
      return report === null ? errNotFound('Report', input.id) : { report };
    }
    if (input.kind === undefined || input.periodEnd === undefined) {
      return errInvalidInput('kind 与 periodEnd 必须同时提供');
    }
    const report = await ctx.repos.report.findByPeriod({
      kind: input.kind,
      scopeKey: reportScopeKey(input.scope ?? { kind: 'all-accounts' }),
      periodStart: derivePeriodStart(input.kind, input.periodEnd),
      periodEnd: input.periodEnd,
    });
    return report === null ? errNotFound('Report', input.periodEnd) : { report };
  },
});
