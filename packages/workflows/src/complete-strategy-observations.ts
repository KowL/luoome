import { z } from 'zod';

import { defineWorkflow, type WorkflowStep } from './define-workflow.js';

export const CompleteStrategyObservationsWorkflowInput = z.object({
  limit: z.number().int().min(1).max(5000).default(1000),
  syncBars: z.boolean().default(true),
});
export type CompleteStrategyObservationsWorkflowInputT = z.infer<
  typeof CompleteStrategyObservationsWorkflowInput
>;

export const CompleteStrategyObservationsWorkflowOutput = z.object({
  requestedStocks: z.number().int().nonnegative(),
  syncedStocks: z.number().int().nonnegative(),
  failedStocks: z.number().int().nonnegative(),
  scanned: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
});
export type CompleteStrategyObservationsWorkflowOutputT = z.infer<
  typeof CompleteStrategyObservationsWorkflowOutput
>;

const complete: WorkflowStep = async (previous, ctx) => {
  const input = previous as CompleteStrategyObservationsWorkflowInputT;
  const listed = await ctx.tools.list_pending_strategy_observations.execute({
    limit: input.limit,
  });
  if (!listed.ok) return listed;
  let syncedStocks = 0;
  let failedStocks = 0;
  if (input.syncBars && listed.data.stockIds.length > 0) {
    const synced = await ctx.tools.sync_daily_bars.execute({
      scope: 'explicit',
      stockIds: listed.data.stockIds,
      correctionWindowDays: 30,
    });
    if (!synced.ok) return synced;
    syncedStocks = synced.data.synced;
    failedStocks = synced.data.failed;
  }
  const result = await ctx.tools.complete_strategy_observations.execute({ limit: input.limit });
  if (!result.ok) return result;
  return CompleteStrategyObservationsWorkflowOutput.parse({
    requestedStocks: listed.data.stockIds.length,
    syncedStocks,
    failedStocks,
    scanned: result.data.scanned,
    completed: result.data.completed,
    pending: result.data.pending,
  });
};

export const completeStrategyObservationsWorkflow = defineWorkflow<
  CompleteStrategyObservationsWorkflowInputT,
  CompleteStrategyObservationsWorkflowOutputT
>({
  name: 'complete-strategy-observations',
  description: '同步规范日线并补齐 StrategySignal 的真实观察',
  input: CompleteStrategyObservationsWorkflowInput,
  steps: [complete],
});
