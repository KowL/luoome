import type { PluginPackage } from '@luoome/toolkit';

export const marketProvidersPlugin = {
  definitions: {
    'source.eastmoney': {
      settings: {
        notes: [
          '来源关联操作属于可能影响；已授权的其它候选源仍可降级供数，实际资料门禁在调用时校验。',
        ],
        requiredCapabilities: ['external'],
      },
      kind: 'provider',
      label: '东方财富',
      baselineEnabled: false,
      requires: [],
    },
    'source.tencent': {
      settings: {
        notes: [
          '来源关联操作属于可能影响；已授权的其它候选源仍可降级供数，实际资料门禁在调用时校验。',
        ],
        requiredCapabilities: ['external'],
      },
      kind: 'provider',
      label: '腾讯行情',
      baselineEnabled: false,
      requires: [],
    },
    'source.sina': {
      settings: {
        notes: [
          '来源关联操作属于可能影响；已授权的其它候选源仍可降级供数，实际资料门禁在调用时校验。',
        ],
        requiredCapabilities: ['external'],
      },
      kind: 'provider',
      label: '新浪财经',
      baselineEnabled: false,
      requires: [],
    },
    'source.tushare': {
      settings: {
        notes: [
          '来源关联操作属于可能影响；已授权的其它候选源仍可降级供数，实际资料门禁在调用时校验。',
        ],
        requiredCapabilities: ['external'],
        credentialEnv: 'TUSHARE_TOKEN',
      },
      kind: 'provider',
      label: 'Tushare',
      baselineEnabled: false,
      requires: [],
    },
    'source.fuyao': {
      settings: {
        notes: [
          '来源关联操作属于可能影响；已授权的其它候选源仍可降级供数，实际资料门禁在调用时校验。',
        ],
        requiredCapabilities: ['external'],
        credentialEnv: 'FUYAO_API_KEY',
      },
      kind: 'provider',
      label: 'Fuyao',
      baselineEnabled: false,
      requires: [],
    },
    'source.10jqka': {
      settings: {
        notes: [
          '来源关联操作属于可能影响；已授权的其它候选源仍可降级供数，实际资料门禁在调用时校验。',
        ],
        requiredCapabilities: ['external'],
      },
      kind: 'provider',
      label: '同花顺资讯',
      baselineEnabled: false,
      requires: [],
    },
  },
  tools: {},
  resources: (_operations: object) => [],
} as const satisfies PluginPackage;
