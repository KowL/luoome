import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import {
  AlertPrioritySchema,
  CostThresholdRuleSchema,
  EventDateRuleSchema,
  PlanLogicSchema,
  PriceChangeRuleSchema,
  PriceLevelRuleSchema,
  TriggerModeSchema,
} from './stock-pool.js';

const AlertRuleBaseFields = {
  id: z.string().min(1),
  priority: AlertPrioritySchema.optional(),
};

export const StrategySignalAlertRuleSchema = z.object({
  ...AlertRuleBaseFields,
  kind: z.literal('strategy-signal'),
  strategyId: z.string().min(1),
  ruleId: z.string().min(1).optional(),
  minScore: z.number().min(0).max(100).default(60),
  direction: z.enum(['bullish', 'bearish', 'neutral']).optional(),
});

export const AlertRuleSchema = z.discriminatedUnion('kind', [
  StrategySignalAlertRuleSchema,
  CostThresholdRuleSchema.safeExtend({ id: z.string().min(1) }),
  PriceChangeRuleSchema.extend({ id: z.string().min(1) }),
  PriceLevelRuleSchema.extend({ id: z.string().min(1) }),
  EventDateRuleSchema.extend({ id: z.string().min(1) }),
]);
export type AlertRule = z.infer<typeof AlertRuleSchema>;

export const AlertPlanSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  name: z.string().min(1).max(80),
  description: z.string().max(1000).optional(),
  watchlistId: z.string().min(1),
  rules: z.array(AlertRuleSchema).min(1),
  logic: PlanLogicSchema,
  triggerMode: TriggerModeSchema,
  priority: AlertPrioritySchema.optional(),
  cooldownMinutes: z.number().int().nonnegative(),
  dailyNotificationLimit: z.number().int().min(1).max(500),
  notifyOnRecovery: z.boolean(),
  enabled: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type AlertPlan = z.infer<typeof AlertPlanSchema>;

export const assertAlertPlanInvariants = (plan: AlertPlan): void => {
  AlertPlanSchema.parse(plan);
  if (plan.updatedAt < plan.createdAt) {
    throw new InvariantError('AlertPlan.updatedAt 不能早于 createdAt');
  }
  const ids = new Set<string>();
  for (const rule of plan.rules) {
    if (ids.has(rule.id)) throw new InvariantError(`AlertPlan.rules[].id 重复: ${rule.id}`);
    ids.add(rule.id);
  }
};
