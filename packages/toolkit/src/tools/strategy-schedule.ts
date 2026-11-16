import { StrategySchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';

export const UpdateStrategyScheduleInput = z.object({
  strategyId: z.string().min(1),
  scheduleCron: z.string().min(1).nullable().optional(),
  lastScheduledAt: z.coerce.date().nullable().optional(),
});
export const UpdateStrategyScheduleOutput = z.object({ strategy: StrategySchema });

/**
 * workflow-only：调度表并入 strategies 后的进程内调度台账写入面。
 * 不作为公共 Agent Tool 注册；run-strategy-schedules 用它推进 lastScheduledAt。
 */
export const updateStrategyScheduleTool = defineTool({
  name: 'update_strategy_schedule',
  description: 'workflow-only：更新 Strategy 的 scheduleCron / lastScheduledAt',
  sideEffect: 'write',
  input: UpdateStrategyScheduleInput,
  output: UpdateStrategyScheduleOutput,
  handler: async (input, ctx) => {
    const strategy = await ctx.repos.strategy.findById(input.strategyId);
    if (strategy === null) return errNotFound('Strategy', input.strategyId);
    await ctx.repos.strategy.updateSchedule(
      input.strategyId,
      {
        ...(input.scheduleCron === undefined ? {} : { scheduleCron: input.scheduleCron }),
        ...(input.lastScheduledAt === undefined ? {} : { lastScheduledAt: input.lastScheduledAt }),
      },
      ctx.clock(),
    );
    const updated = await ctx.repos.strategy.findById(input.strategyId);
    if (updated === null) return errNotFound('Strategy', input.strategyId);
    return { strategy: updated };
  },
});
