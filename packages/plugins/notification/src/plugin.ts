import type { PluginPackage } from '@luoome/toolkit';
import { notificationToolContributions } from './contributions.js';

export const notificationPlugin = {
  definitions: {
    'business.notification': {
      settings: {
        notes: [
          '停用后停止所有新投递，包括报告、盯盘、log 降级和飞书连接测试；历史回执保留，报告生成、策略日循环及盯盘触发记录继续。通道复用宿主实例，无独立定时器或自动补发队列，重新启用不重放成功通知；已发出的请求仅记录实际回执，无法撤回。',
        ],
      },
      kind: 'business',
      label: '通知投递',
      baselineEnabled: false,
      requires: [],
    },
  },
  tools: notificationToolContributions,
  resources: (_operations: object) => [],
} as const satisfies PluginPackage;
