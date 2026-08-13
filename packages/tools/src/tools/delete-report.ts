import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';

export const DeleteReportInput = z.object({
  reportId: z.string().min(1),
});

export const DeleteReportOutput = z.object({
  ok: z.literal(true),
});

export const deleteReportTool = defineTool({
  name: 'delete_report',
  description: '按 id 删除已保存的结构化报告（历史账簿记录）；删除后不可恢复',
  sideEffect: 'write',
  input: DeleteReportInput,
  output: DeleteReportOutput,
  handler: async (input, ctx) => {
    const existing = await ctx.repos.report.findById(input.reportId);
    if (existing === null) return errNotFound('Report', input.reportId);
    await ctx.repos.report.remove(input.reportId);
    return { ok: true as const };
  },
});
