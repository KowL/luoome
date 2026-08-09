import {
  type DeliveryStatus,
  DeliveryStatusSchema,
  WatchRuleStateSchema,
  WatchTriggerSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

/** Workflow-only repository primitives; never added to the public registry. */

export const ListWatchRuleStatesInput = z.object({ poolId: z.string().min(1) });
export const ListWatchRuleStatesOutput = z.object({ states: z.array(WatchRuleStateSchema) });
export const listWatchRuleStatesTool = defineTool({
  name: 'list_watch_rule_states',
  description: 'workflow-only：读取 AlertPlan 的规则边沿状态',
  sideEffect: 'read',
  input: ListWatchRuleStatesInput,
  output: ListWatchRuleStatesOutput,
  handler: async (input, ctx) => ({
    states: [...(await ctx.repos.watchRuleState.listByPool(input.poolId))],
  }),
});

export const SaveWatchRuleStatesInput = z.object({
  states: z.array(WatchRuleStateSchema),
});
export const SaveWatchRuleStatesOutput = z.object({ saved: z.number().int().nonnegative() });
export const saveWatchRuleStatesTool = defineTool({
  name: 'save_watch_rule_states',
  description: 'workflow-only：批量保存 AlertPlan 的规则边沿状态',
  sideEffect: 'write',
  input: SaveWatchRuleStatesInput,
  output: SaveWatchRuleStatesOutput,
  handler: async (input, ctx) => {
    if (input.states.length > 0) await ctx.repos.watchRuleState.upsertMany(input.states);
    return { saved: input.states.length };
  },
});

export const SetWatchTriggerDeliveryStatusInput = z.object({
  triggerIds: z.array(z.string().min(1)).min(1),
  status: DeliveryStatusSchema,
  notificationId: z.string().min(1).optional(),
});
export const SetWatchTriggerDeliveryStatusOutput = z.object({
  triggerIds: z.array(z.string().min(1)),
  status: DeliveryStatusSchema,
});
export const setWatchTriggerDeliveryStatusTool = defineTool({
  name: 'set_watch_trigger_delivery_status',
  description: 'workflow-only：批量回写 WatchTrigger 送达状态',
  sideEffect: 'write',
  input: SetWatchTriggerDeliveryStatusInput,
  output: SetWatchTriggerDeliveryStatusOutput,
  handler: async (input, ctx) => {
    await ctx.repos.watchTrigger.setDeliveryStatus(
      input.triggerIds,
      input.status as DeliveryStatus,
      input.notificationId,
    );
    return { triggerIds: [...input.triggerIds], status: input.status };
  },
});

const DeliveryKeySchema = z.object({
  poolId: z.string().min(1),
  stockId: z.string().min(1),
  ruleId: z.string().min(1),
});

export const GetWatchTriggerDeliveryStatsInput = z.object({
  since: z.coerce.date(),
  cooldownSince: z.coerce.date().optional(),
  poolIds: z.array(z.string().min(1)).default([]),
  cooldownKeys: z.array(DeliveryKeySchema).default([]),
});
export const GetWatchTriggerDeliveryStatsOutput = z.object({
  globalAttempted: z.number().int().nonnegative(),
  byPool: z.array(
    z.object({ poolId: z.string().min(1), attempted: z.number().int().nonnegative() }),
  ),
  cooldowns: z.array(
    z.object({
      key: DeliveryKeySchema,
      trigger: WatchTriggerSchema.nullable(),
    }),
  ),
});
export const getWatchTriggerDeliveryStatsTool = defineTool({
  name: 'get_watch_trigger_delivery_stats',
  description: 'workflow-only：读取 WatchTrigger 每日配额和 cooldown 快照',
  sideEffect: 'read',
  input: GetWatchTriggerDeliveryStatsInput,
  output: GetWatchTriggerDeliveryStatsOutput,
  handler: async (input, ctx) => {
    const [globalAttempted, byPool, cooldowns] = await Promise.all([
      ctx.repos.watchTrigger.countAttemptedSince(input.since, null),
      Promise.all(
        input.poolIds.map(async (poolId) => ({
          poolId,
          attempted: await ctx.repos.watchTrigger.countAttemptedSince(input.since, poolId),
        })),
      ),
      Promise.all(
        input.cooldownKeys.map(async (key) => ({
          key,
          trigger: await ctx.repos.watchTrigger.lastForKey(key, input.cooldownSince ?? input.since),
        })),
      ),
    ]);
    return { globalAttempted, byPool, cooldowns };
  },
});
