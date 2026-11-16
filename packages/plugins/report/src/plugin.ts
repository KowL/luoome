import type { PluginPackage } from '@luoome/toolkit';
import { reportToolContributions } from './contributions.js';
import { type ReportResourceOperations, startClosingReportScheduler } from './resources.js';

export const reportPlugin = {
  definitions: {
    'business.report': {
      settings: {
        notes: [
          '停用后停止新报告、截止补报和报告通知；历史报告仍可查询和渲染，策略日循环、盯盘与盘后数据采集独立运行。已发出的通知只记录实际回执，无法撤回。报告通知仍需宿主 external 授权。',
        ],
      },
      kind: 'business',
      label: '报告生成与投递',
      baselineEnabled: false,
      requires: [],
    },
  },
  tools: reportToolContributions,
  resources: (operations: ReportResourceOperations) => [
    {
      id: 'business.report',
      start: (scope) =>
        startClosingReportScheduler(operations, scope.ctx, {
          startImmediately: false,
          dispatch: (operation) => scope.run(operation),
        }),
    },
  ],
} as const satisfies PluginPackage;
