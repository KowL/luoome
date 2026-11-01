import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';

export const DeleteReportInput = z.object({
  reportId: z.string().min(1),
});

/** 报告删除摘要（决策 3-B）：只给身份与体积，**不塞报告正文**。 */
export const ReportDeletionSummarySchema = z
  .object({
    reportId: z.string().min(1),
    kind: z.string().min(1),
    periodEnd: z.string().min(1),
    /**
     * 被删报告的**序列化字符数**（`JSON.stringify(report).length`，UTF-16 code units）。
     *
     * 刻意**不叫 `bytes`**：`JSON.stringify(...).length` 数的是字符，不是字节。
     * 一个字段叫 `bytes` 却存字符数，就是「名字说一件事、内容是另一件事」——
     * 中文字符在 UTF-8 下占 3 字节，两者可以差 3 倍。
     * 它只是一个**体积量级**指标（证明"删掉的是一份大报告"），不是精确字节数，
     * 所以名字必须说清这一点。
     */
    serializedChars: z.number().int().nonnegative(),
  })
  .strict();

export const DeleteReportOutput = z.object({
  ok: z.literal(true),
  /** 删除摘要：必填。 */
  summary: ReportDeletionSummarySchema,
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
    // 体积在删除前量；`JSON.stringify` 只用于计数，序列化结果不进回执。
    const serializedChars = JSON.stringify(existing).length;
    await ctx.repos.report.remove(input.reportId);
    return {
      ok: true as const,
      summary: {
        reportId: existing.id,
        kind: existing.kind,
        periodEnd: existing.periodEnd,
        serializedChars,
      },
    };
  },
});
