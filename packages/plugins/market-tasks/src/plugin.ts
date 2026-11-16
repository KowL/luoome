import type { PluginPackage } from '@luoome/toolkit';
import { marketTasksToolContributions } from './contributions.js';
import { startMarketBatchScheduler } from './resources.js';

export const marketTasksPlugin = {
  definitions: {
    'task.daily-bars-sync': {
      kind: 'task',
      label: '日线同步',
      baselineEnabled: false,
      requires: [],
    },
    'task.sync-stock-universe': {
      kind: 'task',
      label: '股票目录同步',
      baselineEnabled: false,
      requires: [],
    },
    'task.collect-market-snapshot': {
      kind: 'task',
      label: '盘中快照采集',
      baselineEnabled: false,
      requires: [],
    },
    'task.sync-quotes': {
      kind: 'task',
      label: '持仓报价同步',
      baselineEnabled: false,
      requires: [],
    },
    'task.sync-market-dump': {
      kind: 'task',
      label: '市场数据导入',
      baselineEnabled: false,
      requires: [],
    },
    'task.sync-sector-catalog': {
      kind: 'task',
      label: '板块目录同步',
      baselineEnabled: false,
      requires: [],
    },
    'task.sync-limit-up-board-history': {
      kind: 'task',
      label: '连板历史归档',
      baselineEnabled: false,
      requires: [],
    },
    'task.minute-bars-sync': {
      kind: 'task',
      label: '分钟行情采集',
      baselineEnabled: false,
      requires: [],
    },
  },
  tools: marketTasksToolContributions,
  resources: (_operations: object) => [
    {
      id: 'task.collect-market-snapshot',
      start: (scope) =>
        startMarketBatchScheduler(scope.ctx, {
          startImmediately: false,
          enabled: true,
          dispatch: (operation) => scope.run(operation),
        }),
    },
  ],
} as const satisfies PluginPackage;
