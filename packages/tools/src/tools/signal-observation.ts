import {
  completeSignalObservationFromDailyBars,
  type DailyBar,
  type SignalObservation,
  SignalObservationSchema,
  STRATEGY_OBSERVATION_BENCHMARK_STOCK_ID,
} from '@luoome/core';
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
      dueBefore: ctx.clock(),
      retryReadyAt: ctx.clock(),
      order: 'due-first',
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
  byHorizon: z.record(
    z.enum(['t1', 't3', 't5', 't20']),
    z.object({
      scanned: z.number().int().nonnegative(),
      completed: z.number().int().nonnegative(),
      pending: z.number().int().nonnegative(),
    }),
  ),
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
      dueBefore: ctx.clock(),
      retryReadyAt: ctx.clock(),
      order: 'due-first',
      limit: input.limit,
    });
    const byStock = new Map<string, typeof pending>();
    for (const observation of pending) {
      byStock.set(observation.stockId, [...(byStock.get(observation.stockId) ?? []), observation]);
    }
    const completedIds: string[] = [];
    const now = ctx.clock();
    const baselineTimes = pending.flatMap((item) =>
      item.baselineAt === undefined ? [] : [item.baselineAt.getTime()],
    );
    let benchmarkBars: DailyBar[] = [];
    if (baselineTimes.length > 0) {
      try {
        benchmarkBars = await ctx.repos.dailyBar.findInRange(
          STRATEGY_OBSERVATION_BENCHMARK_STOCK_ID,
          new Date(Math.min(...baselineTimes) - 7 * 86_400_000),
          now,
        );
      } catch (error) {
        ctx.logger.warn('complete_strategy_observations: benchmark 日线不可用', {
          benchmark: STRATEGY_OBSERVATION_BENCHMARK_STOCK_ID,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const [stockId, observations] of byStock) {
      const baselineTimes = observations.flatMap((item) =>
        item.baselineAt === undefined ? [] : [item.baselineAt.getTime()],
      );
      if (baselineTimes.length === 0) continue;
      let bars: DailyBar[];
      try {
        bars = await ctx.repos.dailyBar.findInRange(
          stockId,
          new Date(Math.min(...baselineTimes)),
          now,
        );
      } catch (error) {
        for (const observation of observations) {
          await ctx.repos.signalObservation.save(withObservationRetry(observation, now, error));
        }
        continue;
      }
      for (const observation of observations) {
        const completed = completeSignalObservationFromDailyBars(observation, bars, now, {
          benchmarkBars,
        });
        if (completed.status === 'complete') {
          await ctx.repos.signalObservation.save(completed);
          completedIds.push(completed.id);
        } else {
          await ctx.repos.signalObservation.save(
            withObservationRetry(observation, now, new Error('insufficient_daily_bars')),
          );
        }
      }
    }
    return {
      scanned: pending.length,
      completed: completedIds.length,
      pending: pending.length - completedIds.length,
      completedIds,
      byHorizon: Object.fromEntries(
        (['t1', 't3', 't5', 't20'] as const).map((horizon) => {
          const rows = pending.filter((observation) => observation.horizon === horizon);
          const completed = rows.filter((observation) =>
            completedIds.includes(observation.id),
          ).length;
          return [horizon, { scanned: rows.length, completed, pending: rows.length - completed }];
        }),
      ),
    };
  },
});

const withObservationRetry = (
  observation: SignalObservation,
  now: Date,
  error: unknown,
): SignalObservation => {
  const attemptCount = (observation.attemptCount ?? 0) + 1;
  const delay = Math.min(60 * 60 * 1000, 60_000 * 2 ** Math.min(attemptCount - 1, 6));
  return {
    ...observation,
    attemptCount,
    lastAttemptAt: now,
    nextAttemptAt: new Date(now.getTime() + delay),
    lastErrorKind:
      error instanceof Error
        ? error.message === 'insufficient_daily_bars'
          ? error.message
          : error.name
        : 'daily_bar_error',
  };
};
