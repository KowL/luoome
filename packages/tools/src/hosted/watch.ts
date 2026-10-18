import { randomUUID } from 'node:crypto';
import { FeishuWebhookAdapter } from '@luoome/adapters';
import {
  AlertPlanSchema,
  FeishuWebhookUrlSchema,
  HostedQuietHoursSchema,
  hostedQuietUntil,
  hostedTradingPlanTriggerSource,
  isAshareTradingSession,
  isWatchAlertDeliveryEligible,
  type NotificationManagerLike,
  type NotificationPayload,
  type ToolContext,
  type ToolResult,
  TradingPlanMonitoringSchema,
  TradingPlanSchema,
  tradingPlanMonitoring,
  tradingPlanVersionId,
  WatchDeliveryIntentSchema,
  type WatchTrigger,
  WatchTriggerSchema,
  WorkflowRunSchema,
} from '@luoome/core';
import { z } from 'zod';
import { defineTool, errAdapterError, errInvalidInput, errNotFound } from '../define-tool.js';
import { deriveAccountFacts } from '../tools/account-facts.js';
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

const tradingPlanState = async (trigger: WatchTrigger, ctx: ToolContext) => {
  const source = hostedTradingPlanTriggerSource(trigger);
  if (source === null || source.accountId !== ctx.user.defaultAccountId) return null;
  const plan = await ctx.repos.tradingPlan.findByVersionId(source.planVersionId);
  if (
    plan === null ||
    plan.accountId !== source.accountId ||
    plan.stockId !== trigger.stockId ||
    plan.accountFactsDigest !== source.accountFactsDigest ||
    ![...plan.entryConditions, ...plan.exit.triggerConditions].some(
      (condition) => condition.id === source.conditionId,
    )
  )
    return null;
  const [facts, versions] = await Promise.all([
    deriveAccountFacts(ctx, plan.accountId),
    ctx.repos.tradingPlan.list({
      accountId: plan.accountId,
      stockId: plan.stockId,
      currentOnly: true,
      limit: 1,
    }),
  ]);
  return {
    source,
    plan,
    latestVersion: [...versions].sort((a, b) => b.version - a.version).at(0) ?? null,
    monitoring: tradingPlanMonitoring(plan, facts, ctx.clock(), undefined, versions),
  };
};

export const resolveHostedWatchNotificationTool = defineTool({
  name: 'resolve_hosted_watch_notification',
  description: '核对确切提醒的原始快照和当前计划状态；历史触发不作为当前行动授权',
  sideEffect: 'read',
  input: z.object({ triggerId: z.string().min(1).max(512) }).strict(),
  output: z.object({
    trigger: WatchTriggerSchema,
    sourcePlan: TradingPlanSchema.nullable(),
    latestVersion: TradingPlanSchema.nullable(),
    monitoring: TradingPlanMonitoringSchema.nullable(),
    alertPlan: AlertPlanSchema.nullable(),
    state: z.enum(['requires-recheck', 'changed', 'unavailable']),
    changes: z.array(z.string()),
    currentActionAllowed: z.literal(false),
    checkedAt: z.coerce.date(),
  }),
  handler: async ({ triggerId }, ctx) => {
    const trigger = await ctx.repos.watchTrigger.findById(triggerId);
    if (trigger === null) return errNotFound('WatchTrigger', triggerId);
    if (
      trigger.poolId.startsWith('trading-plan-watch:') &&
      trigger.poolId !== `trading-plan-watch:${ctx.user.defaultAccountId}`
    )
      return errNotFound('WatchTrigger', triggerId);
    const state = await tradingPlanState(trigger, ctx);
    const alertPlan =
      hostedTradingPlanTriggerSource(trigger) === null
        ? await ctx.repos.alertPlan.findById(trigger.poolId)
        : null;
    const [watchlist, member] =
      alertPlan === null
        ? [null, null]
        : await Promise.all([
            ctx.repos.watchlist.findById(alertPlan.watchlistId),
            ctx.repos.watchlistMember.findMember(alertPlan.watchlistId, trigger.stockId),
          ]);
    const alertEligible = isWatchAlertDeliveryEligible(trigger, alertPlan, watchlist, member);
    const changes =
      state === null
        ? alertEligible
          ? ['原提醒计划和成员仍有效；需要使用当前事实重新检查触发条件']
          : ['原提醒计划已停用、删除、条件变化或成员已退出；请查看原始快照，不沿用原行动']
        : state.monitoring.status === 'ready'
          ? ['原计划仍具备监控资格；触发条件需使用当前合格行情重新检查']
          : [state.monitoring.reason, state.monitoring.nextStep];
    return {
      trigger,
      sourcePlan: state?.plan ?? null,
      latestVersion: state?.latestVersion ?? null,
      monitoring: state?.monitoring ?? null,
      alertPlan,
      state:
        state === null
          ? alertPlan === null
            ? ('unavailable' as const)
            : alertEligible
              ? ('requires-recheck' as const)
              : ('changed' as const)
          : state.monitoring.status === 'ready'
            ? ('requires-recheck' as const)
            : ('changed' as const),
      changes,
      currentActionAllowed: false as const,
      checkedAt: ctx.clock(),
    };
  },
});

const linkedWatchPayload = (
  payload: NotificationPayload,
  triggerIds: readonly string[],
  publicOrigin?: string,
): NotificationPayload => {
  if (publicOrigin === undefined) return payload;
  const origin = new URL(publicOrigin);
  if (
    origin.origin !== publicOrigin ||
    origin.username ||
    origin.password ||
    !['https:', 'http:'].includes(origin.protocol)
  )
    throw new Error('invalid notification public origin');
  const links = triggerIds.map((id) => {
    const url = new URL('/', origin);
    url.hash = `alerts?${new URLSearchParams({ triggerId: id })}`;
    return `[查看最新状态与触发快照](${url.href})`;
  });
  return { ...payload, content: `${payload.content}\n\n${links.join('\n')}` };
};

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
  options: { readonly publicOrigin?: string } = {},
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
    const suppress = async (errorKind: string) => {
      const result = await sendHostedFeishu(ctx, null, id, input.payload, errorKind);
      const completed = await ctx.repos.watchDelivery.complete({
        ...delivery,
        attemptId,
        state: 'suppressed',
        notificationId: id,
        errorKind,
        now: ctx.clock(),
      });
      if (!completed) throw new Error('预警投递抑制结果等待核对');
      return { notification: result.notification };
    };
    for (const triggerId of delivery.triggerIds) {
      const trigger = await ctx.repos.watchTrigger.findById(triggerId);
      if (trigger === null) throw new Error('预警触发记录已不可用');
      const source = hostedTradingPlanTriggerSource(trigger);
      if (source === null) continue;
      const state = await tradingPlanState(trigger, ctx);
      const eventAge =
        trigger.quote === undefined
          ? Number.POSITIVE_INFINITY
          : ctx.clock().getTime() - trigger.quote.ts.getTime();
      if (
        state === null ||
        state.monitoring.status !== 'ready' ||
        state.plan.accountFactsDigest !== source.accountFactsDigest ||
        tradingPlanVersionId(state.plan) !== source.planVersionId ||
        eventAge < 0 ||
        eventAge > 10 * 60_000 ||
        !isAshareTradingSession(ctx.clock())
      ) {
        return suppress('conditions-changed');
      }
    }
    const currentSettings = await ctx.repos.watchDelivery.settings();
    if (
      (await authorize()) !== null ||
      !currentSettings.enabled ||
      currentSettings.bindingVersion !== claimed[0]?.bindingVersion ||
      currentSettings.webhookUrl !== settings.webhookUrl ||
      hostedQuietUntil(currentSettings.quietHours, ctx.clock()) !== null
    )
      return suppress('recipient-unavailable');
    if (settings.webhookUrl === null)
      ctx.logger.info('watch notification fallback-log', {
        notificationId: id,
        triggerCount: delivery.triggerIds.length,
      });
    const { notification, state, errorKind } = await sendHostedFeishu(
      ctx,
      settings.webhookUrl,
      id,
      linkedWatchPayload(input.payload, delivery.triggerIds, options.publicOrigin),
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
