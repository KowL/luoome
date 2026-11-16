import {
  AlertPlanSchema,
  AlertPrioritySchema,
  DeliveryStatusSchema,
  isWatchAlertDeliveryEligible,
  type ToolContext,
  TradingPlanMonitoringSchema,
  TradingPlanSchema,
  TriggerFeedbackSchema,
  TriggerTypeSchema,
  tradingPlanMonitoring,
  tradingPlanTriggerSource,
  WatchRuleKindSchema,
  type WatchTrigger,
  WatchTriggerSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';
import { deriveAccountFacts } from './account-facts.js';

export const ListWatchTriggersInput = z.object({
  accountId: z.string().min(1).optional(),
  alertPlanId: z.string().min(1).optional(),
  poolId: z.string().min(1).optional(),
  stockId: z.string().min(1).optional(),
  ruleKind: WatchRuleKindSchema.optional(),
  ruleId: z.string().min(1).optional(),
  notified: z.boolean().optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  priority: AlertPrioritySchema.optional(),
  feedback: z.union([TriggerFeedbackSchema, z.literal('unreviewed')]).optional(),
  triggerType: TriggerTypeSchema.optional(),
  deliveryStatus: z.array(DeliveryStatusSchema).optional(),
  includeSummary: z.boolean().default(false),
  orderBy: z.enum(['recent', 'priority']).default('recent'),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.number().int().positive().max(10_000).default(50),
});

export const ListWatchTriggersOutput = z.object({
  triggers: z.array(WatchTriggerSchema.extend({ stockName: z.string().optional() })),
  /** 过滤后、limit 前的总数。 */
  total: z.number().int().nonnegative(),
  summary: z
    .object({
      priorityCounts: z.record(z.string(), z.number().int().nonnegative()),
      deliveryStatusCounts: z.record(z.string(), z.number().int().nonnegative()),
      feedbackCounts: z.record(z.string(), z.number().int().nonnegative()),
      stocks: z.array(
        z.object({
          stockId: z.string(),
          count: z.number().int().positive(),
          maxPriority: AlertPrioritySchema,
          latest: WatchTriggerSchema,
        }),
      ),
    })
    .optional(),
});

export const listWatchTriggersTool = defineTool({
  name: 'list_watch_triggers',
  description:
    '查询最近 AlertPlan 触发（按计划/股票/规则/优先级/反馈/通知状态过滤，准确计数并分页，支持时间或优先级排序，可选 includeSummary 返回筛选范围的完整统计）',
  sideEffect: 'read',
  input: ListWatchTriggersInput,
  output: ListWatchTriggersOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    if (!accountId || (await ctx.repos.account.findById(accountId)) === null)
      return errNotFound('Account', accountId);
    const {
      triggers: page,
      total,
      summary,
    } = await ctx.repos.watchTrigger.query({
      accountId,
      offset: input.offset,
      includeSummary: input.includeSummary,
      orderBy: input.orderBy,
      limit: input.limit,
      ...(input.alertPlanId === undefined ? {} : { alertPlanId: input.alertPlanId }),
      ...(input.stockId === undefined ? {} : { stockId: input.stockId }),
      ...(input.ruleKind === undefined ? {} : { ruleKind: input.ruleKind }),
      ...(input.ruleId === undefined ? {} : { ruleId: input.ruleId }),
      ...(input.notified === undefined ? {} : { notified: input.notified }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.feedback === undefined ? {} : { feedback: input.feedback }),
      ...(input.triggerType === undefined ? {} : { triggerType: input.triggerType }),
      ...(input.deliveryStatus === undefined ? {} : { deliveryStatus: input.deliveryStatus }),
      ...(input.since === undefined ? {} : { since: input.since }),
      ...(input.until === undefined ? {} : { until: input.until }),
      ...(input.alertPlanId === undefined && input.poolId !== undefined
        ? { poolId: input.poolId }
        : {}),
    });
    const names = new Map(
      await Promise.all(
        [...new Set(page.map((trigger) => trigger.stockId))].map(async (stockId) => {
          const stock = await ctx.repos.stock.findById(stockId);
          return [stockId, stock?.name] as const;
        }),
      ),
    );
    return {
      triggers: ListWatchTriggersOutput.shape.triggers.parse(
        page.map((trigger) => ({ ...trigger, stockName: names.get(trigger.stockId) })),
      ),
      total,
      ...(summary === undefined ? {} : { summary: { ...summary, stocks: [...summary.stocks] } }),
    };
  },
});

const tradingPlanState = async (trigger: WatchTrigger, ctx: ToolContext) => {
  const source = tradingPlanTriggerSource(trigger);
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

export const resolveWatchNotificationTool = defineTool({
  name: 'resolve_watch_notification',
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
      tradingPlanTriggerSource(trigger) === null
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
