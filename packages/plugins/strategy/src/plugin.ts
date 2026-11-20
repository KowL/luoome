import type { PluginPackage } from '@luoome/toolkit';
import { strategyToolContributions } from './contributions.js';

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
      settings: { notes: ['关闭后手动运行与信号查询一并停用。'] },
      kind: 'business',
      label: '策略执行',
      baselineEnabled: false,
      requires: [],
    },
  },
  tools: strategyToolContributions,
  resources: (_operations: object) => [],
} as const satisfies PluginPackage;
