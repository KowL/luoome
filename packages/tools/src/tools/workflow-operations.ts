import {
  type DeliveryStatus,
  DeliveryStatusSchema,
  WatchRuleStateSchema,
  WatchTriggerSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';
import {
  observationsForWatchTrigger,
  saveObservationCandidates,
} from '../internal/signal-observation.js';

/** Workflow-only repository primitives; never added to the public registry. */

export const CommitWatchEvaluationInput = z.object({
  owner: z.string().min(1),
  triggers: z.array(WatchTriggerSchema),
  states: z.array(WatchRuleStateSchema),
});
export const CommitWatchEvaluationOutput = z.object({ saved: z.number().int().nonnegative() });
export const commitWatchEvaluationTool = defineTool({
  name: 'commit_watch_evaluation',
  description: 'workflow-only：在租约保护下原子提交预警触发与边沿状态',
  sideEffect: 'write',
  input: CommitWatchEvaluationInput,
  output: CommitWatchEvaluationOutput,
  handler: async (input, ctx) => {
    const committed = await ctx.repos.watchTrigger.commitEvaluation({ ...input, now: ctx.clock() });
    if (!committed)
      return {
        ok: false as const,
        error: {
          kind: 'lease_lost_before_commit' as const,
          message: '预警执行租约已失效，未提交求值结果',
        },
      };
    await saveObservationCandidates(
      input.triggers.flatMap((trigger) =>
        observationsForWatchTrigger(trigger, {
          provider: trigger.quote === undefined ? 'watch-trigger' : 'quote',
          observedAt: trigger.createdAt,
          fetchedAt: ctx.clock(),
          freshness: trigger.quote === undefined ? 'unavailable' : 'fresh',
        }),
      ),
      ctx.repos.signalObservation,
    );
    return { saved: input.triggers.length };
  },
});

export const WatchExecutionInput = z.object({
  action: z.enum(['acquire', 'renew', 'release']),
  owner: z.string().min(1),
});
export const WatchExecutionOutput = z.object({ acquired: z.boolean() });
export const watchExecutionTool = defineTool({
  name: 'watch_execution',
  description: 'workflow-only：取得、续期或释放预警执行租约',
  sideEffect: 'write',
  input: WatchExecutionInput,
  output: WatchExecutionOutput,
  handler: async ({ action, owner }, ctx) => {
    const now = ctx.clock();
    const until = new Date(now.getTime() + 120_000);
    if (action === 'release') {
      await ctx.repos.watchTrigger.releaseExecution(owner);
      return { acquired: false };
    }
    return {
      acquired: await (action === 'acquire'
        ? ctx.repos.watchTrigger.acquireExecution(owner, now, until)
        : ctx.repos.watchTrigger.renewExecution(owner, now, until)),
    };
  },
});

export const BeginWatchDeliveryInput = z.object({ triggerIds: z.array(z.string().min(1)).min(1) });
export const BeginWatchDeliveryOutput = z.object({ started: z.number().int().nonnegative() });
export const beginWatchDeliveryTool = defineTool({
  name: 'begin_watch_delivery',
  description: 'workflow-only：发送前记录投递尝试',
  sideEffect: 'write',
  input: BeginWatchDeliveryInput,
  output: BeginWatchDeliveryOutput,
  handler: async ({ triggerIds }, ctx) => {
    await ctx.repos.watchTrigger.beginDelivery(triggerIds, ctx.clock());
    return { started: triggerIds.length };
  },
});

export const ListWatchDeliveryRetriesInput = z.object({ poolId: z.string().min(1) });
export const ListWatchDeliveryRetriesOutput = z.object({ triggers: z.array(WatchTriggerSchema) });
export const listWatchDeliveryRetriesTool = defineTool({
  name: 'list_watch_delivery_retries',
  description: 'workflow-only：查询当日未过期且已到退避时间的失败/中断投递',
  sideEffect: 'read',
  input: ListWatchDeliveryRetriesInput,
  output: ListWatchDeliveryRetriesOutput,
  handler: async ({ poolId }, ctx) => {
    const now = ctx.clock();
    const offset = 8 * 60 * 60 * 1000;
    const since = new Date(Math.floor((now.getTime() + offset) / 86_400_000) * 86_400_000 - offset);
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
