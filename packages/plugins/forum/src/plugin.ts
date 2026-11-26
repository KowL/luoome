import type { PluginPackage } from '@luoome/toolkit';

import { forumToolContributions } from './contributions.js';

export const forumPlugin = {
  definitions: {
    'business.forum': {
      settings: {
        notes: [
          '启用后每日盘前 08:45 / 盘后 17:30 批次会为候选股与市场采集公开股吧讨论摘要（只读公开页面与人气榜）。',
          '采集属于外部访问 + 本地写入；讨论摘要只作为观察证据，不能单独构成 buy/sell 建议，也不产生交易动作。',
        ],
        requiredCapabilities: ['write', 'external'],
      },
      kind: 'business',
      label: '股吧讨论',
      baselineEnabled: false,
      requires: [],
    },
  },
  tools: forumToolContributions,
  resources: (_operations: object) => [],
} as const satisfies PluginPackage;
