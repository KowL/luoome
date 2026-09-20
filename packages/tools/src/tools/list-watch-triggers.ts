import {
  AlertPrioritySchema,
  DeliveryStatusSchema,
  TriggerFeedbackSchema,
  TriggerTypeSchema,
  WatchRuleKindSchema,
  WatchTriggerSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

export const ListWatchTriggersInput = z.object({
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
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.number().int().positive().max(10_000).default(50),
});

export const ListWatchTriggersOutput = z.object({
  triggers: z.array(WatchTriggerSchema.extend({ stockName: z.string().optional() })),
  /** 过滤后、limit 前的总数。 */
  total: z.number().int().nonnegative(),
});

export const listWatchTriggersTool = defineTool({
  name: 'list_watch_triggers',
  description:
    '查询最近 AlertPlan 触发（按计划/股票/规则/优先级/反馈/通知状态过滤，准确计数并分页）',
  sideEffect: 'read',
  input: ListWatchTriggersInput,
  output: ListWatchTriggersOutput,
  handler: async (input, ctx) => {
    const { triggers: page, total } = await ctx.repos.watchTrigger.query({
      offset: input.offset,
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
    };
  },
});
