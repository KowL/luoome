import { randomUUID } from 'node:crypto';
import { FeishuWebhookAdapter } from '@luoome/adapters';
import {
  FeishuWebhookUrlSchema,
  HostedQuietHoursSchema,
  hostedQuietUntil,
  type NotificationManagerLike,
  type ToolContext,
  type ToolResult,
  WatchDeliveryIntentSchema,
  WorkflowRunSchema,
} from '@luoome/core';
import { z } from 'zod';
import { defineTool, errAdapterError, errInvalidInput } from '../define-tool.js';
import { sendHostedFeishu } from './notification-delivery.js';

const view = (
  settings: Awaited<ReturnType<ToolContext['repos']['watchDelivery']['settings']>>,
) => ({
  configured: settings.webhookUrl !== null,
  endpoint: 'open.feishu.cn' as const,
  enabled: settings.enabled,
  revision: settings.revision,
  quietHours: settings.quietHours,
});
const SettingsView = z.object({
  configured: z.boolean(),
  endpoint: z.literal('open.feishu.cn'),
  enabled: z.boolean(),
  revision: z.number().int(),
  quietHours: HostedQuietHoursSchema,
});
const workerDenied = (): ToolResult<never> => ({
  ok: false,
  error: { kind: 'permission_denied', required: 'hosted:worker' },
});

export const getHostedWatchSettingsTool = defineTool({
  name: 'get_hosted_watch_settings',
  description: '读取当前租户的飞书绑定状态，不回显 Webhook',
  sideEffect: 'read',
  input: z.object({}).strict(),
  output: SettingsView,
  handler: async (_input, ctx) => view(await ctx.repos.watchDelivery.settings()),
});
export const saveHostedWatchSettingsTool = defineTool({
  name: 'save_hosted_watch_settings',
  description: '保存当前租户飞书偏好并撤销旧绑定待发提醒',
  sideEffect: 'write',
  input: z
    .object({
      expectedRevision: z.number().int().nonnegative(),
      webhookUrl: FeishuWebhookUrlSchema.optional(),
      clearWebhook: z.boolean().default(false),
      enabled: z.boolean().optional(),
      quietHours: HostedQuietHoursSchema.optional(),
    })
    .strict(),
  output: SettingsView,
  handler: async (input, ctx) => {
    const previous = await ctx.repos.watchDelivery.settings();
    const webhookUrl = input.clearWebhook ? null : (input.webhookUrl ?? previous.webhookUrl);
    const enabled = input.clearWebhook
      ? false
      : (input.enabled ?? (input.webhookUrl === undefined ? previous.enabled : true));
    return view(
      await ctx.repos.watchDelivery.saveSettings({
        expectedRevision: input.expectedRevision,
        webhookUrl,
        enabled,
        quietHours: input.quietHours ?? previous.quietHours,
        now: ctx.clock(),
      }),
    );
  },
});
export const testHostedWatchSettingsTool = defineTool({
  name: 'test_hosted_watch_settings',
  description: '向当前租户自己的飞书 Webhook 发送连接测试',
  sideEffect: 'external',
  requiredCapabilities: ['write', 'external'],
  input: z.object({}).strict(),
  output: z.object({
    channelAccepted: z.literal(true),
    deviceDelivered: z.null(),
    acceptedAt: z.coerce.date(),
  }),
  handler: async (_input, ctx) => {
    const settings = await ctx.repos.watchDelivery.settings();
    if (settings.webhookUrl === null || !settings.enabled)
      return errInvalidInput('请先配置并启用飞书通知');
    try {
      await new FeishuWebhookAdapter({ webhookUrl: settings.webhookUrl }).send({
        title: '通知连接测试',
        content: '飞书渠道已受理测试消息，请在目标群核对。',
        level: 'info',
      });
      return { channelAccepted: true as const, deviceDelivered: null, acceptedAt: ctx.clock() };
    } catch {
      return errAdapterError('feishu-webhook', '连接测试失败，未确认受理', true);
    }
  },
});
export const listHostedWatchDeliveriesTool = defineTool({
  name: 'list_hosted_watch_deliveries',
  description: '读取当前租户预警投递事实，受理与设备送达分开',
  sideEffect: 'read',
  input: z.object({}).strict(),
  output: z.array(WatchDeliveryIntentSchema),
  handler: async (_input, ctx) => [...(await ctx.repos.watchDelivery.list())].slice(-100).reverse(),
});
export const suppressHostedWatchDeliveriesTool = defineTool({
  name: 'suppress_hosted_watch_deliveries',
  description: 'worker-only：停止已失效服务期的未发预警',
  sideEffect: 'write',
  input: z.object({}).strict(),
  output: z.object({ suppressed: z.number().int().nonnegative() }),
  handler: async (_input, ctx) => {
    if (ctx.identity?.mode !== 'hosted' || ctx.identity.actor !== 'worker') return workerDenied();
    return {
      suppressed: await ctx.repos.watchDelivery.suppressPending('tenant-unavailable', ctx.clock()),
    };
  },
});

export const claimHostedWatchTickTool = defineTool({
  name: 'claim_hosted_watch_tick',
  description: 'worker-only：原子认领当前租户的一分钟预警批次',
  sideEffect: 'write',
  input: z.object({}).strict(),
  output: WorkflowRunSchema.nullable(),
  handler: async (_input, ctx) => {
    if (ctx.identity?.mode !== 'hosted' || ctx.identity.actor !== 'worker') return workerDenied();
    const now = ctx.clock();
    const run = WorkflowRunSchema.parse({
      id: `hosted-alerts:${Math.floor(now.getTime() / 60_000)}`,
      workflowName: 'hosted-alerts',
      mode: 'daemon',
      status: 'running',
      startedAt: now,
      inputSummary: { claimToken: randomUUID() },
      providerStatuses: [],
    });
    return (await ctx.repos.workflowRun.claim(run)) ? run : null;
  },
});
export const finishHostedWatchTickTool = defineTool({
  name: 'finish_hosted_watch_tick',
  description: 'worker-only：按认领令牌结束租户预警批次审计',
  sideEffect: 'write',
  input: z.object({ run: WorkflowRunSchema, claimToken: z.string().min(1) }).strict(),
  output: z.object({ saved: z.boolean() }),
  handler: async ({ run, claimToken }, ctx) => {
    if (
      ctx.identity?.mode !== 'hosted' ||
      ctx.identity.actor !== 'worker' ||
      run.workflowName !== 'hosted-alerts'
    )
      return workerDenied();
    return { saved: await ctx.repos.workflowRun.finishClaim(run, claimToken) };
  },
});

export const createHostedWatchNotificationManager = (
  ctx: ToolContext,
  authorize: () => Promise<ToolResult<never> | null>,
): NotificationManagerLike => ({
  send: async (input) => {
    const delivery = input.watchDelivery;
    if (delivery === undefined || ctx.identity?.mode !== 'hosted')
      throw new Error('预警发送缺少受保护的执行上下文');
    const settings = await ctx.repos.watchDelivery.settings();
    if ((await authorize()) !== null) {
      await ctx.repos.watchDelivery.suppressPending('tenant-unavailable', ctx.clock());
      throw new Error('预警投递权益已失效');
    }
    if (hostedQuietUntil(settings.quietHours, ctx.clock()) !== null)
      throw new Error('预警处于安静时段');
    const attemptId = randomUUID();
    const claimed = await ctx.repos.watchDelivery.claim({
      ...delivery,
      attemptId,
      now: ctx.clock(),
    });
    if (claimed === null) throw new Error('预警投递条件或执行令牌已失效');
    const id = `watch-notification:${attemptId}`;
    if (settings.webhookUrl === null)
      ctx.logger.info('watch notification fallback-log', {
        notificationId: id,
        triggerCount: delivery.triggerIds.length,
      });
    const { notification, state, errorKind } = await sendHostedFeishu(
      ctx,
      settings.webhookUrl,
      id,
      input.payload,
    );
    const completed = await ctx.repos.watchDelivery.complete({
      ...delivery,
      attemptId,
      state,
      notificationId: id,
      errorKind,
      now: ctx.clock(),
    });
    if (!completed) throw new Error('预警发送结束后租约已失效，结果等待核对');
    return { notification };
  },
});
