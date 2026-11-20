import { z } from 'zod';

import { defineWorkflow } from './define-workflow.js';
import { WeeklyReportInput, weeklyReportOperation } from './weekly-report.js';

/**
 * 报告入口：只剩周度建议成绩单一条管线。
 *
 * `kind` 保留为可选字段只为兼容既有调用脚本的 `--kind weekly`；其它取值不再接受，
 * 开盘/收盘/每日复盘三条报告链已随 P1 收敛删除。
 */
export const ReportWorkflowInput = WeeklyReportInput.extend({
  kind: z.literal('weekly').default('weekly'),
});

export type ReportWorkflowInputT = z.infer<typeof ReportWorkflowInput>;

export const reportWorkflow = defineWorkflow<ReportWorkflowInputT, unknown>({
  requiredPlugins: ['business.report'],
  name: 'report',
  description: '生成每周建议成绩单（kind=weekly）',
  input: ReportWorkflowInput,
  steps: [
    (prev, ctx) => {
      const { kind: _kind, ...rest } = prev as ReportWorkflowInputT;
      return weeklyReportOperation.run(rest, ctx);
    },
  ],
});
