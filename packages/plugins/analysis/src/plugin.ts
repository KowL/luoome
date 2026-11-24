import type { PluginPackage } from '@luoome/toolkit';
import { analysisToolContributions } from './contributions.js';

export const analysisPlugin = {
  definitions: {
    'business.analysis': {
      settings: {
        notes: [
          '停用后拒绝新个股、持仓、市场及策略候选 Advice，并拒绝每日个股观察批次（generate_stock_briefs 返回 permission_denied）；历史建议与观察记录仍可读取。',
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
