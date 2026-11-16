import {
  type DeliveryStatus,
  DeliveryStatusSchema,
  WatchRuleStateSchema,
  WatchTriggerSchema,
} from '@luoome/core';
import { defineTool } from '@luoome/toolkit';
import { assertNotificationDelivery } from '@luoome/toolkit/internal/notification-delivery.js';
import {
  observationsForWatchTrigger,
  saveObservationCandidates,
} from '@luoome/toolkit/internal/signal-observation.js';
import { assertWatchMonitoring } from '@luoome/toolkit/internal/watch-monitoring.js';
import { z } from 'zod';

/** Workflow-only repository primitives; never added to the public registry. */

export const CommitWatchEvaluationInput = z.object({
  triggers: z.array(WatchTriggerSchema),
  auditTriggers: z.array(WatchTriggerSchema).default([]),
  states: z.array(WatchRuleStateSchema),
  invalidatePending: z
    .object({ triggerIds: z.array(z.string().min(1)).min(1), reason: z.string().min(1) })
    .optional(),
});
export const CommitWatchEvaluationOutput = z.object({
  saved: z.number().int().nonnegative(),
  invalidatedAt: z.coerce.date().optional(),
});
export const commitWatchEvaluationTool = defineTool({
  name: 'commit_watch_evaluation',
  description: 'workflow-only：原子提交预警触发与边沿状态',
  sideEffect: 'write',
  input: CommitWatchEvaluationInput,
  output: CommitWatchEvaluationOutput,
  handler: async (input, ctx) => {
    assertWatchMonitoring(ctx);
    const now = ctx.clock();
    const { invalidatePending, ...evaluation } = input;
    await ctx.repos.watchTrigger.commitEvaluation({
      ...evaluation,
      now,
      ...(invalidatePending === undefined ? {} : { invalidatePending }),
    });
    assertWatchMonitoring(ctx);
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
    return {
      saved:
        input.triggers.length +
        input.auditTriggers.length +
        (input.invalidatePending?.triggerIds.length ?? 0),
      ...(input.invalidatePending === undefined ? {} : { invalidatedAt: now }),
    };
  },
});

export const BeginWatchDeliveryInput = z.object({
  triggerIds: z.array(z.string().min(1)).min(1),
});
export const BeginWatchDeliveryOutput = z.object({
  started: z.number().int().nonnegative(),
  notificationId: z.string().min(1),
});
export const beginWatchDeliveryTool = defineTool({
  name: 'begin_watch_delivery',
  description: 'workflow-only：发送前记录投递尝试',
  sideEffect: 'write',
  input: BeginWatchDeliveryInput,
  output: BeginWatchDeliveryOutput,
  handler: async ({ triggerIds }, ctx) => {
    assertWatchMonitoring(ctx);
    assertNotificationDelivery(ctx);
    const notificationId = `watch-${crypto.randomUUID()}`;
    await ctx.repos.withWriteGuard(
      () => assertNotificationDelivery(ctx),
      () => ctx.repos.watchTrigger.beginDelivery(triggerIds, ctx.clock(), notificationId),
    );
    return { started: triggerIds.length, notificationId };
  },
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
    assertWatchMonitoring(ctx);
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
  completedAt: z.coerce.date(),
});
export const setWatchTriggerDeliveryStatusTool = defineTool({
  name: 'set_watch_trigger_delivery_status',
  description: 'workflow-only：批量回写 WatchTrigger 送达状态',
  sideEffect: 'write',
  input: SetWatchTriggerDeliveryStatusInput,
  output: SetWatchTriggerDeliveryStatusOutput,
  handler: async (input, ctx) => {
    assertWatchMonitoring(ctx);
    const completedAt = ctx.clock();
    await ctx.repos.watchTrigger.setDeliveryStatus(
      input.triggerIds,
      input.status as DeliveryStatus,
      input.notificationId,
      completedAt,
    );
    return { triggerIds: [...input.triggerIds], status: input.status, completedAt };
  },
});
