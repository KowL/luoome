import { StrategyResultSchema, StrategyRunSchema, StrategySignalSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';

export const ListStrategyRunsInput = z.object({
  strategyId: z.string().min(1).optional(),
  status: z.enum(['running', 'complete', 'partial', 'failed']).optional(),
  since: z.coerce.date().optional(),
  limit: z.number().int().positive().max(500).default(50),
});
export const ListStrategyRunsOutput = z.object({
  runs: z.array(StrategyRunSchema),
  total: z.number().int().nonnegative(),
});

export const listStrategyRunsTool = defineTool({
  name: 'list_strategy_runs',
  description: '查询 StrategyRun 历史',
  sideEffect: 'read',
  input: ListStrategyRunsInput,
  output: ListStrategyRunsOutput,
  handler: async (input, ctx) => {
    const runs = await ctx.repos.strategyRun.listRuns({
      ...(input.strategyId === undefined ? {} : { strategyId: input.strategyId }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.since === undefined ? {} : { since: input.since }),
    });
    return { runs: runs.slice(0, input.limit), total: runs.length };
  },
});

export const GetStrategyRunInput = z.object({ runId: z.string().min(1) });
export const GetStrategyRunOutput = z.object({
  run: StrategyRunSchema,
  results: z.array(StrategyResultSchema),
});

export const getStrategyRunTool = defineTool({
  name: 'get_strategy_run',
  description: '查询单次 StrategyRun 及逐股结果',
  sideEffect: 'read',
  input: GetStrategyRunInput,
  output: GetStrategyRunOutput,
  handler: async (input, ctx) => {
    const run = await ctx.repos.strategyRun.findRunById(input.runId);
    if (run === null) return errNotFound('StrategyRun', input.runId);
    return { run, results: await ctx.repos.strategyRun.listResults(run.id) };
  },
});

export const StrategySignalsByStockInput = z.object({
  stockId: z.string().min(1),
  since: z.coerce.date().optional(),
  limit: z.number().int().positive().max(500).default(50),
});
export const StrategySignalsByStockOutput = z.object({
  stockId: z.string(),
  signals: z.array(StrategySignalSchema),
  total: z.number().int().nonnegative(),
});

export const strategySignalsByStockTool = defineTool({
  name: 'strategy_signals_by_stock',
  description: '按股票查询 StrategySignal 事实；signal 不等于 Advice 或交易',
  sideEffect: 'read',
  input: StrategySignalsByStockInput,
  output: StrategySignalsByStockOutput,
  handler: async (input, ctx) => {
    const signals = await ctx.repos.strategyRun.signalsByStock(input.stockId, input.since);
    return {
      stockId: input.stockId,
      signals: signals.slice(0, input.limit),
      total: signals.length,
    };
  },
});
