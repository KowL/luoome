import type { PluginPackage } from '@luoome/toolkit';
import { performanceTaskToolContributions } from './contributions.js';
import {
  type PerformanceResourceOperations,
  startPortfolioPerformanceScheduler,
} from './resources.js';

export const performanceTaskPlugin = {
  definitions: {
    'task.snapshot-account-performance': {
      settings: {
        notes: [
          '停用后卸载账户绩效估值定时器，停止自动批量估值和任务工具；旧任务在下一安全点停止，排空前不注册新一代。历史快照与审计保留；账户和报告的按需绩效查询及其快照缓存继续沿用共享能力，其它插件不受影响。启用不自动开启行情源或补齐凭证，重跑按原指纹复用快照。',
        ],
      },
      kind: 'task',
      label: '账户绩效估值任务',
      baselineEnabled: false,
      requires: [],
    },
  },
  tools: performanceTaskToolContributions,
  resources: (operations: PerformanceResourceOperations) => [
    {
      id: 'task.snapshot-account-performance',
      start: (scope) =>
        startPortfolioPerformanceScheduler(operations, scope.ctx, {
          startImmediately: false,
          dispatch: (operation) => scope.run(operation),
        }),
    },
  ],
} as const satisfies PluginPackage;
