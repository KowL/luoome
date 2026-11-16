import { WatchRuleStateSchema, WatchTriggerSchema } from '@luoome/core';
import { z } from 'zod';
import { defineTool } from '../define-tool.js';

export const ListWatchDeliveryRetriesInput = z.object({
  poolId: z.string().min(1),
  since: z.coerce.date().optional(),
});
export const ListWatchDeliveryRetriesOutput = z.object({ triggers: z.array(WatchTriggerSchema) });
export const listWatchDeliveryRetriesTool = defineTool({
  name: 'list_watch_delivery_retries',
  description: 'workflow-only：查询当日未过期且已到退避时间的失败/中断投递',
  sideEffect: 'read',
  input: ListWatchDeliveryRetriesInput,
  output: ListWatchDeliveryRetriesOutput,
  handler: async ({ poolId, since: sessionStart }, ctx) => {
    const now = ctx.clock();
    const offset = 8 * 60 * 60 * 1000;
    const dayStart = Math.floor((now.getTime() + offset) / 86_400_000) * 86_400_000 - offset;
    const since = new Date(Math.max(dayStart, sessionStart?.getTime() ?? dayStart));
    const triggers = await ctx.repos.watchTrigger.listRecent({
      poolId,
      since,
      deliveryStatus: ['pending', 'failed'],
      limit: 10_000,
    });
    return {
      triggers: triggers.filter((trigger) => {
        if (trigger.evalSnapshot.preview === true) return false;
        const attempts = trigger.deliveryAttempts ?? (trigger.deliveryStatus === 'failed' ? 1 : 0);
        const delay = attempts === 0 ? 0 : attempts === 1 ? 60_000 : 300_000;
        return (
          attempts < 3 &&
          now.getTime() >= (trigger.lastDeliveryAttemptAt ?? trigger.createdAt).getTime() + delay
        );
      }),
    };
  },
});

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
