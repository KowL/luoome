import { completeSignalObservationFromDailyBars, SignalObservationSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

export const ListPendingStrategyObservationsInput = z.object({
  limit: z.number().int().min(1).max(5000).default(1000),
});
export const ListPendingStrategyObservationsOutput = z.object({
  observations: z.array(SignalObservationSchema),
  stockIds: z.array(z.string()),
});

export const listPendingStrategyObservationsTool = defineTool({
  name: 'list_pending_strategy_observations',
  description: '列出待补齐的 StrategySignal 真实表现观察',
  sideEffect: 'read',
  input: ListPendingStrategyObservationsInput,
  output: ListPendingStrategyObservationsOutput,
  handler: async (input, ctx) => {
    const observations = await ctx.repos.signalObservation.list({
      sourceKind: 'strategy-signal',
      status: 'pending',
      limit: input.limit,
    });
    return {
      observations,
      stockIds: [...new Set(observations.map((item) => item.stockId))].sort(),
    };
  },
});

export const CompleteStrategyObservationsInput = z.object({
  limit: z.number().int().min(1).max(5000).default(1000),
});
export const CompleteStrategyObservationsOutput = z.object({
  scanned: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  completedIds: z.array(z.string()),
});

export const completeStrategyObservationsTool = defineTool({
  name: 'complete_strategy_observations',
  description: '仅用本地规范 qfq 日线补齐 StrategySignal 的 T+1/T+3/T+5/T+20 事实观察',
  sideEffect: 'write',
  input: CompleteStrategyObservationsInput,
  output: CompleteStrategyObservationsOutput,
  handler: async (input, ctx) => {
    const pending = await ctx.repos.signalObservation.list({
      sourceKind: 'strategy-signal',
      status: 'pending',
      limit: input.limit,
    });
    const byStock = new Map<string, typeof pending>();
    for (const observation of pending) {
      byStock.set(observation.stockId, [...(byStock.get(observation.stockId) ?? []), observation]);
    }
    const completedIds: string[] = [];
    const now = ctx.clock();
    for (const [stockId, observations] of byStock) {
      const baselineTimes = observations.flatMap((item) =>
        item.baselineAt === undefined ? [] : [item.baselineAt.getTime()],
      );
      if (baselineTimes.length === 0) continue;
      const bars = await ctx.repos.dailyBar.findInRange(
        stockId,
        new Date(Math.min(...baselineTimes)),
        now,
      );
      for (const observation of observations) {
        const completed = completeSignalObservationFromDailyBars(observation, bars, now);
        if (completed.status !== 'complete') continue;
        await ctx.repos.signalObservation.save(completed);
        completedIds.push(completed.id);
      }
    }
    return {
      scanned: pending.length,
      completed: completedIds.length,
      pending: pending.length - completedIds.length,
      completedIds,
    };
  },
});
