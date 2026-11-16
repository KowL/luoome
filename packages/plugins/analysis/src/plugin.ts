import type { PluginPackage } from '@luoome/toolkit';
import { analysisToolContributions } from './contributions.js';

export const analysisPlugin = {
  definitions: {
    'business.analysis': {
      settings: {
        notes: [
          '停用后拒绝新个股、持仓、市场及策略候选 Advice；历史建议仍可读取，既有策略运行与事实不受此开关影响。',
        ],
        modelBlocker: '分析模型尚未配置',
      },
      kind: 'business',
      label: '个股分析',
      baselineEnabled: false,
      requires: [],
    },
  },
  tools: analysisToolContributions,
  resources: (_operations: object) => [],
} as const satisfies PluginPackage;
