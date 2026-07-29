import { SIGNAL_OBSERVATION_HORIZON_DAYS, SignalObservationSchema } from '@luoome/core';
import { z } from 'zod';
import { defineTool } from '../define-tool.js';

export const RefreshSignalObservationsInput = z.object({
  limit: z.number().int().positive().max(1000).default(200),
});
export const RefreshSignalObservationsOutput = z.object({
  inspected: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  observations: z.array(SignalObservationSchema),
});
export const refreshSignalObservationsTool = defineTool({
  name: 'refresh_signal_observations',
  description: '仅使用本地日线完成到期信号的后续事实观察（不拉取行情、不形成回测交易）',
  sideEffect: 'write',
  input: RefreshSignalObservationsInput,
  output: RefreshSignalObservationsOutput,
  handler: async (input, ctx) => {
    const pending = await ctx.repos.signalObservation.list({
      status: 'pending',
      limit: input.limit,
    });
    let completed = 0;
    const observations = [];
    for (const observation of pending) {
      if (observation.baselineAt === undefined || observation.baselinePrice === undefined) continue;
      const baselineAt = observation.baselineAt;
      const baselinePrice = observation.baselinePrice;
      const bars = await ctx.repos.dailyBar.findInRange(
        observation.stockId,
        baselineAt,
        ctx.clock(),
      );
      const futureBars = bars.filter((bar) => bar.date.getTime() > baselineAt.getTime());
      const target = futureBars[SIGNAL_OBSERVATION_HORIZON_DAYS[observation.horizon] - 1];
      if (target === undefined) continue;
      const path = futureBars.slice(0, SIGNAL_OBSERVATION_HORIZON_DAYS[observation.horizon]);
      const next = {
        ...observation,
        closePrice: target.close,
        returnPct: (target.close - baselinePrice) / baselinePrice,
        maxFavorableExcursionPct: Math.max(
          ...path.map((bar) => (bar.high - baselinePrice) / baselinePrice),
        ),
        maxAdverseExcursionPct: Math.min(
          ...path.map((bar) => (bar.low - baselinePrice) / baselinePrice),
        ),
        status: 'complete' as const,
        observedAt: target.date,
        provenance: {
          provider: target.source,
          observedAt: target.date,
          fetchedAt: ctx.clock(),
          freshness: 'fresh' as const,
        },
      };
      await ctx.repos.signalObservation.save(next);
      observations.push(next);
      completed += 1;
    }
    return {
      inspected: pending.length,
      completed,
      pending: pending.length - completed,
      observations,
    };
  },
});
