import { z } from 'zod';

import { ClosingReportInput, closingReportOperation } from './closing-report.js';
import { DailyReviewInput, dailyReviewOperation } from './daily-review.js';
import { defineWorkflow } from './define-workflow.js';
import { OpeningReportInput, openingReportOperation } from './opening-report.js';
import { WeeklyReportInput, weeklyReportOperation } from './weekly-report.js';

/**
 * 报告入口：开盘 / 收盘 / 周报 / 每日复盘共用一条 workflow 入口。
 *
 * 四个管线仍是独立的 operation，审计名（`opening-report` / `closing-report` /
 * `weekly-report` / `daily-review`）由各自内部写入，合并不改写历史 WorkflowRun。
 */
export const ReportWorkflowInput = z.discriminatedUnion('kind', [
  OpeningReportInput.extend({ kind: z.literal('opening') }),
  ClosingReportInput.extend({ kind: z.literal('closing') }),
  WeeklyReportInput.extend({ kind: z.literal('weekly') }),
  DailyReviewInput.extend({ kind: z.literal('daily-review') }),
]);

export type ReportWorkflowInputT = z.infer<typeof ReportWorkflowInput>;

export const reportWorkflow = defineWorkflow<ReportWorkflowInputT, unknown>({
  name: 'report',
  description: '生成开盘/收盘/周报/每日复盘报告（kind=opening|closing|weekly|daily-review）',
  input: ReportWorkflowInput,
  steps: [
    (prev, ctx) => {
      const { kind, ...rest } = prev as ReportWorkflowInputT;
      switch (kind) {
        case 'opening':
          return openingReportOperation.run(rest, ctx);
        case 'closing':
          return closingReportOperation.run(rest, ctx);
        case 'weekly':
          return weeklyReportOperation.run(rest, ctx);
        case 'daily-review':
          return dailyReviewOperation.run(rest, ctx);
      }
    },
  ],
});
