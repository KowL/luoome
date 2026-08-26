import {
  buildStrategySchedule,
  nextCronOccurrence,
  StrategyRecommendationPolicySchema,
  StrategyRunAcceptancePolicySchema,
  StrategyScheduleSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

export const GetStrategyScheduleInput = z.object({ strategyId: z.string().min(1) });
export const GetStrategyScheduleOutput = z.object({ schedule: StrategyScheduleSchema.nullable() });

export const getStrategyScheduleTool = defineTool({
  name: 'get_strategy_schedule',
  description: '读取 Strategy 的独立自动运行配置',
  sideEffect: 'read',
  input: GetStrategyScheduleInput,
  output: GetStrategyScheduleOutput,
  handler: async (input, ctx) => ({
    schedule: await ctx.repos.strategySchedule.findByStrategyId(input.strategyId),
  }),
});

export const SetStrategyScheduleInput = z.object({
  strategyId: z.string().min(1),
  cron: z.string().min(1).max(120),
  timezone: z.string().min(1).max(100).default('Asia/Shanghai'),
  enabled: z.boolean().default(true),
  acceptancePolicy: StrategyRunAcceptancePolicySchema.optional(),
  recommendationPolicy: StrategyRecommendationPolicySchema.optional(),
});
export const SetStrategyScheduleOutput = z.object({ schedule: StrategyScheduleSchema });

export const setStrategyScheduleTool = defineTool({
  name: 'set_strategy_schedule',
  description: '创建或更新 StrategySchedule；不修改不可变 StrategyVersion',
  sideEffect: 'write',
  input: SetStrategyScheduleInput,
  output: SetStrategyScheduleOutput,
  handler: async (input, ctx) => {
    const strategy = await ctx.repos.strategy.findById(input.strategyId);
    if (strategy === null) return errNotFound('Strategy', input.strategyId);
    if (
      input.enabled &&
      (strategy.status !== 'active' || strategy.currentVersionId === undefined)
    ) {
      return errInvalidInput('只有 active 且已发布版本的 Strategy 可启用调度');
    }
    const existing = await ctx.repos.strategySchedule.findByStrategyId(input.strategyId);
    const schedule = buildStrategySchedule({
      strategyId: input.strategyId,
      cron: input.cron,
      timezone: input.timezone,
      enabled: input.enabled,
      ...(input.acceptancePolicy === undefined ? {} : { acceptancePolicy: input.acceptancePolicy }),
      ...(input.recommendationPolicy === undefined
        ? {}
        : { recommendationPolicy: input.recommendationPolicy }),
      now: ctx.clock(),
      ...(existing === null ? {} : { existing }),
    });
    await ctx.repos.strategySchedule.save(schedule);
    return { schedule };
  },
});

export const ClaimDueStrategySchedulesInput = z.object({
  owner: z.string().min(1),
  /** 指定时跳过 nextRunAt 到期判断，供 Web 手动正式运行复用同一 lease。 */
  strategyId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  leaseMinutes: z.number().int().min(5).max(240).default(20),
});
const ClaimedScheduleSchema = z.object({
  schedule: StrategyScheduleSchema,
  eligible: z.boolean(),
  lease: z.object({
    owner: z.string(),
    fence: z.number().int().nonnegative(),
    leaseUntil: z.coerce.date(),
  }),
  reason: z.string().optional(),
});
export const ClaimDueStrategySchedulesOutput = z.object({ items: z.array(ClaimedScheduleSchema) });

export const claimDueStrategySchedulesTool = defineTool({
  name: 'claim_due_strategy_schedules',
  description: '为调度 workflow 原子抢占到期或指定的 StrategySchedule',
  sideEffect: 'write',
  input: ClaimDueStrategySchedulesInput,
  output: ClaimDueStrategySchedulesOutput,
  handler: async (input, ctx) => {
    const now = ctx.clock();
    const leaseUntil = new Date(now.getTime() + input.leaseMinutes * 60_000);
    const claims =
      input.strategyId === undefined
        ? await ctx.repos.strategySchedule.claimDueWithFence({
            now,
            owner: input.owner,
            leaseUntil,
            limit: input.limit,
          })
        : [
            await ctx.repos.strategySchedule.claimByStrategyIdWithFence({
              strategyId: input.strategyId,
              now,
              owner: input.owner,
              leaseUntil,
            }),
          ].flatMap((claim) => (claim === null ? [] : [claim]));
    const items = await Promise.all(
      claims.map(async ({ schedule, token }) => {
        const strategy = await ctx.repos.strategy.findById(schedule.strategyId);
        const eligible = strategy?.status === 'active' && strategy.currentVersionId !== undefined;
        return {
          schedule,
          eligible,
          lease: token,
          ...(eligible
            ? {}
            : {
                reason:
                  strategy === null
                    ? 'Strategy 不存在'
                    : 'Strategy 未处于 active 或没有 currentVersion',
              }),
        };
      }),
    );
    return { items };
  },
});

export const FinishStrategyScheduleClaimInput = z.object({
  scheduleId: z.string().min(1),
  owner: z.string().min(1),
  fence: z.number().int().nonnegative().optional(),
  lastRunId: z.string().min(1).optional(),
});
export const FinishStrategyScheduleClaimOutput = z.object({ schedule: StrategyScheduleSchema });

export const finishStrategyScheduleClaimTool = defineTool({
  name: 'finish_strategy_schedule_claim',
  description: '完成 StrategySchedule lease 并把 nextRunAt 推进到未来',
  sideEffect: 'write',
  input: FinishStrategyScheduleClaimInput,
  output: FinishStrategyScheduleClaimOutput,
  handler: async (input, ctx) => {
    const schedule = await ctx.repos.strategySchedule.findById(input.scheduleId);
    if (schedule === null) return errNotFound('StrategySchedule', input.scheduleId);
    const now = ctx.clock();
    await ctx.repos.strategySchedule.finishClaim({
      id: schedule.id,
      owner: input.owner,
      ...(input.fence === undefined ? {} : { fence: input.fence }),
      nextRunAt: nextCronOccurrence(schedule.cron, schedule.timezone, now),
      updatedAt: now,
      ...(input.lastRunId === undefined ? {} : { lastRunId: input.lastRunId }),
    });
    const updated = await ctx.repos.strategySchedule.findById(schedule.id);
    if (updated === null) return errNotFound('StrategySchedule', schedule.id);
    return { schedule: updated };
  },
});

export const RenewStrategyScheduleClaimInput = z.object({
  scheduleId: z.string().min(1),
  owner: z.string().min(1),
  fence: z.number().int().nonnegative(),
  leaseMinutes: z.number().int().min(5).max(240).default(120),
});
export const RenewStrategyScheduleClaimOutput = z.object({ renewed: z.boolean() });

export const renewStrategyScheduleClaimTool = defineTool({
  name: 'renew_strategy_schedule_claim',
  description: '按 owner+fence 延长 StrategySchedule lease；失去 fencing 时返回 renewed=false',
  sideEffect: 'write',
  input: RenewStrategyScheduleClaimInput,
  output: RenewStrategyScheduleClaimOutput,
  handler: async (input, ctx) => {
    const now = ctx.clock();
    const renewed = await ctx.repos.strategySchedule.renewClaim({
      id: input.scheduleId,
      owner: input.owner,
      fence: input.fence,
      now,
      leaseUntil: new Date(now.getTime() + input.leaseMinutes * 60_000),
    });
    return { renewed };
  },
});
