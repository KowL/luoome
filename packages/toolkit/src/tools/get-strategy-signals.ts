import { StrategySignalSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';
import { getSignalObservationStatsTool } from './signal-observation.js';
import { strategySignalsByStockTool } from './strategy-query.js';

export const GetStrategySignalsInput = z.object({
  stockId: z.string().min(1),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  limit: z.number().int().positive().max(500).default(50),
  includeObservationStats: z.boolean().default(true),
});

export const GetStrategySignalsOutput = z.object({
  stockId: z.string().min(1),
  signals: z.array(StrategySignalSchema),
  total: z.number().int().nonnegative(),
  observationStats: z.record(z.string(), z.unknown()).optional(),
});

export const getStrategySignalsTool = defineTool({
  name: 'get_strategy_signals',
  description: '查询策略产出的历史信号及 T+1/5/20 信号观察表现；signal 不等于 Advice 或交易',
  sideEffect: 'read',
  input: GetStrategySignalsInput,
  output: GetStrategySignalsOutput,
  handler: async (input, ctx) => {
    const signals = await strategySignalsByStockTool.execute(
      {
        stockId: input.stockId,
        ...(input.since === undefined ? {} : { since: input.since }),
        ...(input.until === undefined ? {} : { until: input.until }),
        limit: input.limit,
      },
      ctx,
    );
    if (!signals.ok) return signals;
    const output: {
      stockId: string;
      signals: typeof signals.data.signals;
      total: number;
      observationStats?: Record<string, unknown>;
    } = {
      stockId: signals.data.stockId,
      signals: signals.data.signals,
      total: signals.data.total,
    };
    if (input.includeObservationStats) {
      const stats = await getSignalObservationStatsTool.execute({ stockId: input.stockId }, ctx);
      if (stats.ok) output.observationStats = stats.data as Record<string, unknown>;
    }
    return output;
  },
});
