import {
  DEFAULT_NOTIFICATION_CHANNEL,
  type NotificationChannel,
  NotificationChannelSchema,
  NotificationSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

const NotificationLevelSchema = z.enum(['info', 'warn', 'error', 'success']);

const FeishuPayloadInputSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(5000),
  level: NotificationLevelSchema.default('info'),
  atMobiles: z.array(z.string().regex(/^1\d{10}$/, '手机号必须 11 位数字')).optional(),
});

const LogPayloadInputSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(5000),
  level: NotificationLevelSchema.default('info'),
});

export const SendNotificationInput = z.object({
  channel: NotificationChannelSchema.optional(),
  feishu: FeishuPayloadInputSchema.optional(),
  log: LogPayloadInputSchema.optional(),
  adviceId: z.string().min(1).optional(),
  tacticSignalId: z.string().min(1).optional(),
});

export const SendNotificationOutput = z.object({
  notification: NotificationSchema,
});

/**
 * 发送通知（v0.3 起，external）。
 *
 * 设计要点：
 * - channel 缺省 = DEFAULT_NOTIFICATION_CHANNEL（'log'）。
 * - channel='feishu' 必须配 feishu 字段；channel='log' 必须配 log 字段。
 * - feishu adapter 未配置（缺 LUOOME_FEISHU_WEBHOOK_URL）→ 自动降级为 log + suppressed。
 *
 * 注意：external 副作用，MCP 默认 opt-in。
 */
export const sendNotificationTool = defineTool({
  name: 'send_notification',
  description: '发送通知（feishu 卡片 / log）；feishu 未配置时自动降级为 log',
  sideEffect: 'external',
  input: SendNotificationInput,
  output: SendNotificationOutput,
  handler: async (input, ctx) => {
    const channel: NotificationChannel = input.channel ?? DEFAULT_NOTIFICATION_CHANNEL;
    const payload = channel === 'feishu' ? input.feishu : input.log;
    if (payload === undefined) {
      return {
        ok: false as const,
        error: {
          kind: 'invalid_input' as const,
          message: `channel='${channel}' 时必须配 ${channel} 字段`,
          issues: [],
        },
      };
    }
    const manager = ctx.notification;
    if (manager === undefined) {
      return {
        ok: false as const,
        error: {
          kind: 'internal' as const,
          cause:
            'send_notification: ToolContext.notification 未注入 NotificationManager（请检查装配）',
        },
      };
    }
    const r = await manager.send({
      channel,
      payload,
      ...(input.adviceId !== undefined ? { adviceId: input.adviceId } : {}),
      ...(input.tacticSignalId !== undefined ? { tacticSignalId: input.tacticSignalId } : {}),
    });
    return { notification: NotificationSchema.parse(r.notification) };
  },
});
