import {
  AlertPlanSchema,
  AlertRuleSchema,
  assertAlertPlanInvariants,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

export const ListAlertPlansInput = z.object({
  enabledOnly: z.boolean().default(false),
  watchlistId: z.string().min(1).optional(),
});
export const ListAlertPlansOutput = z.object({
  plans: z.array(AlertPlanSchema),
  total: z.number().int().nonnegative(),
});
export const listAlertPlansTool = defineTool({
  name: 'list_alert_plans',
  description: '列出 AlertPlan，可按启用状态或 Watchlist 过滤',
  sideEffect: 'read',
  input: ListAlertPlansInput,
  output: ListAlertPlansOutput,
  handler: async (input, ctx) => {
    const plans = await ctx.repos.alertPlan.list({
      enabledOnly: input.enabledOnly,
      ...(input.watchlistId === undefined ? {} : { watchlistId: input.watchlistId }),
    });
    return { plans, total: plans.length };
  },
});

const AlertPlanMutableFields = {
  name: z.string().min(1).max(80),
  description: z.string().max(1000).optional(),
  watchlistId: z.string().min(1),
  rules: z.array(AlertRuleSchema).min(1),
  logic: z.enum(['ANY', 'ALL']).default('ANY'),
  triggerMode: z.enum(['on-enter', 'repeat', 'daily-first']).default('on-enter'),
  priority: z.enum(['urgent', 'important', 'normal']).optional(),
  cooldownMinutes: z.number().int().nonnegative().default(30),
  dailyNotificationLimit: z.number().int().min(1).max(500).default(20),
  notifyOnRecovery: z.boolean().default(false),
  enabled: z.boolean().default(true),
};

export const CreateAlertPlanInput = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,63}$/)
    .optional(),
  ...AlertPlanMutableFields,
});
export const CreateAlertPlanOutput = z.object({ plan: AlertPlanSchema });

const validateReferences = async (
  input: {
    readonly watchlistId: string;
    readonly rules: readonly z.infer<typeof AlertRuleSchema>[];
  },
  ctx: ToolContext,
) => {
  if ((await ctx.repos.watchlist.findById(input.watchlistId)) === null) {
    return errNotFound('Watchlist', input.watchlistId);
  }
  for (const rule of input.rules) {
    if (
      rule.kind === 'strategy-signal' &&
      (await ctx.repos.strategy.findById(rule.strategyId)) === null
    ) {
      return errNotFound('Strategy', rule.strategyId);
    }
  }
  return null;
};

export const createAlertPlanTool = defineTool({
  name: 'create_alert_plan',
  description: '创建引用 Watchlist 的 AlertPlan',
  sideEffect: 'write',
  input: CreateAlertPlanInput,
  output: CreateAlertPlanOutput,
  handler: async (input, ctx) => {
    const id = input.id ?? `alert-${globalThis.crypto.randomUUID().slice(0, 8)}`;
    if ((await ctx.repos.alertPlan.findById(id)) !== null) {
      return errInvalidInput(`AlertPlan id 已存在: ${id}`);
    }
    const referenceError = await validateReferences(input, ctx);
    if (referenceError !== null) return referenceError;
    const now = ctx.clock();
    const plan = AlertPlanSchema.parse({ ...input, id, createdAt: now, updatedAt: now });
    assertAlertPlanInvariants(plan);
    await ctx.repos.alertPlan.save(plan);
    return { plan };
  },
});

export const UpdateAlertPlanInput = z
  .object({
    alertPlanId: z.string().min(1),
    name: AlertPlanMutableFields.name.optional(),
    description: AlertPlanMutableFields.description,
    watchlistId: AlertPlanMutableFields.watchlistId.optional(),
    rules: AlertPlanMutableFields.rules.optional(),
    logic: z.enum(['ANY', 'ALL']).optional(),
    triggerMode: z.enum(['on-enter', 'repeat', 'daily-first']).optional(),
    priority: z.enum(['urgent', 'important', 'normal']).optional(),
    cooldownMinutes: z.number().int().nonnegative().optional(),
    dailyNotificationLimit: z.number().int().min(1).max(500).optional(),
    notifyOnRecovery: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((input) => Object.keys(input).some((key) => key !== 'alertPlanId'), {
    message: '至少提供一个更新字段',
  });
export const UpdateAlertPlanOutput = z.object({ plan: AlertPlanSchema });
export const updateAlertPlanTool = defineTool({
  name: 'update_alert_plan',
  description: '更新 AlertPlan 基础字段、规则与启用状态',
  sideEffect: 'write',
  input: UpdateAlertPlanInput,
  output: UpdateAlertPlanOutput,
  handler: async (input, ctx) => {
    const current = await ctx.repos.alertPlan.findById(input.alertPlanId);
    if (current === null) return errNotFound('AlertPlan', input.alertPlanId);
    const { alertPlanId: _id, ...updates } = input;
    void _id;
    const plan = AlertPlanSchema.parse({ ...current, ...updates, updatedAt: ctx.clock() });
    const referenceError = await validateReferences(plan, ctx);
    if (referenceError !== null) return referenceError;
    assertAlertPlanInvariants(plan);
    await ctx.repos.alertPlan.save(plan);
    return { plan };
  },
});

export const DeleteAlertPlanInput = z.object({ alertPlanId: z.string().min(1) });
export const DeleteAlertPlanOutput = z.object({ deleted: z.boolean() });
export const deleteAlertPlanTool = defineTool({
  name: 'delete_alert_plan',
  description: '删除 AlertPlan 配置；保留 WatchTrigger 历史',
  sideEffect: 'write',
  input: DeleteAlertPlanInput,
  output: DeleteAlertPlanOutput,
  handler: async (input, ctx) => {
    if ((await ctx.repos.alertPlan.findById(input.alertPlanId)) === null) {
      return errNotFound('AlertPlan', input.alertPlanId);
    }
    await ctx.repos.alertPlan.remove(input.alertPlanId);
    // 级联清理该计划遗留的 watch_rule_states（poolId = plan.id），避免孤儿状态
    await ctx.repos.watchRuleState.removeByPool(input.alertPlanId);
    return { deleted: true };
  },
});
