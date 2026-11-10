import {
  AlertPlanSchema,
  TradingPlanMonitoringSchema,
  TradingPlanSchema,
  TradingPlanViewSchema,
  WatchTriggerSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';
import { listAlertPlansTool } from './alert-plan.js';
import { listWatchTriggersTool } from './list-watch-triggers.js';
import { ListTradingPlansInput, listTradingPlansTool } from './trading-plan.js';

export const ListWatchPlansInput = ListTradingPlansInput.extend({
  includeAlertPlans: z.boolean().default(true),
  alertPlansEnabledOnly: z.boolean().default(false),
  recentTriggerLimit: z.number().int().positive().max(100).default(10),
});

export const ListWatchPlansOutput = z.object({
  plans: z.array(TradingPlanSchema),
  monitoring: z.array(TradingPlanMonitoringSchema).optional(),
  views: z.array(TradingPlanViewSchema).optional(),
  alertPlans: z.array(AlertPlanSchema).optional(),
  recentTriggers: z.array(WatchTriggerSchema).optional(),
});

export const listWatchPlansTool = defineTool({
  name: 'list_watch_plans',
  description: '查询当前生效的个股交易计划（TradingPlan）与股票池预警（AlertPlan）及最近触发记录',
  sideEffect: 'read',
  input: ListWatchPlansInput,
  output: ListWatchPlansOutput,
  handler: async (input, ctx) => {
    const { includeAlertPlans, alertPlansEnabledOnly, recentTriggerLimit, ...planQuery } = input;
    const plans = await listTradingPlansTool.execute(planQuery, ctx);
    if (!plans.ok) return plans;
    const output: z.infer<typeof ListWatchPlansOutput> = {
      plans: plans.data.plans,
      ...(plans.data.monitoring === undefined ? {} : { monitoring: plans.data.monitoring }),
      ...(plans.data.views === undefined ? {} : { views: plans.data.views }),
    };
    if (includeAlertPlans) {
      const alertPlans = await listAlertPlansTool.execute(
        { enabledOnly: alertPlansEnabledOnly },
        ctx,
      );
      if (!alertPlans.ok) return alertPlans;
      output.alertPlans = [...alertPlans.data.plans];
      const triggers = await listWatchTriggersTool.execute({ limit: recentTriggerLimit }, ctx);
      if (triggers.ok) output.recentTriggers = [...triggers.data.triggers];
    }
    return output;
  },
});
