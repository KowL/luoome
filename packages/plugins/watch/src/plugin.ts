import type { PluginPackage } from '@luoome/toolkit';
import { watchToolContributions } from './contributions.js';
import { startIntradayPlanScheduler, type WatchResourceOperations } from './resources.js';

export const watchPlugin = {
  definitions: {
    'business.watch-monitoring': {
      settings: {
        notes: [
          '停用后停止新的规则求值、触发和盯盘通知；关注列表、预警计划、历史触发与反馈保留，其它报告通知独立运行。已发出的请求只能收尾，无法撤回。',
        ],
        requiredCapabilities: ['external'],
      },
      kind: 'business',
      label: '盯盘监控',
      baselineEnabled: false,
      requires: [],
    },
  },
  tools: watchToolContributions,
  resources: (operations: WatchResourceOperations) => [
    {
      id: 'business.watch-monitoring',
      start: (scope) =>
        startIntradayPlanScheduler(operations, scope.ctx, {
          startImmediately: false,
          dispatch: (operation) => scope.run(operation),
        }),
    },
  ],
} as const satisfies PluginPackage;
