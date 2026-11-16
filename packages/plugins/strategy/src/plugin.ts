import type { PluginPackage } from '@luoome/toolkit';
import { strategyToolContributions } from './contributions.js';
import { type StrategyResourceOperations, startStrategyScheduler } from './resources.js';

export const strategyPlugin = {
  definitions: {
    'strategy.ai-insight': {
      settings: {
        notes: ['关闭解释模型后，组合入口保留确定性事实。'],
        requiredCapabilities: ['external'],
        modelBlocker: '解释模型尚未配置',
      },
      kind: 'business',
      label: '策略 AI 洞察',
      baselineEnabled: true,
      requires: [],
    },
    'business.strategy-execution': {
      settings: { notes: ['自动策略定时器随依赖停用；报告截止与补投保持独立。'] },
      kind: 'business',
      label: '策略执行',
      baselineEnabled: false,
      requires: [],
    },
    'task.strategy-schedules': {
      settings: { requiredCapabilities: ['write', 'external'] },
      kind: 'task',
      label: '自动策略调度',
      baselineEnabled: false,
      requires: ['business.strategy-execution'],
    },
  },
  tools: strategyToolContributions,
  resources: (operations: StrategyResourceOperations) => [
    {
      id: 'task.strategy-schedules',
      start: (scope) =>
        startStrategyScheduler(operations, scope.ctx, {
          startImmediately: false,
          dispatch: (operation) => scope.run(operation),
        }),
    },
  ],
} as const satisfies PluginPackage;
