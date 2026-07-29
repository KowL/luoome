import { z } from 'zod';

import { defineWorkflow, type WorkflowStep } from './define-workflow.js';

export const RunStrategiesInput = z.object({
  strategyIds: z.array(z.string().min(1)).optional(),
  mode: z.enum(['scan', 'replay']).default('scan'),
  asOf: z.coerce.date().optional(),
  stockIds: z.array(z.string().min(1)).max(500).optional(),
  persist: z.boolean().default(true),
});
export type RunStrategiesInputT = z.infer<typeof RunStrategiesInput>;

const RunStrategiesItemSchema = z.object({
  strategyId: z.string(),
  status: z.enum(['complete', 'partial', 'failed']),
  runId: z.string().optional(),
  selected: z.number().int().nonnegative(),
  signals: z.number().int().nonnegative(),
  error: z.string().optional(),
});

export const RunStrategiesOutput = z.object({
  items: z.array(RunStrategiesItemSchema),
  complete: z.number().int().nonnegative(),
  partial: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type RunStrategiesOutputT = z.infer<typeof RunStrategiesOutput>;

const runAll: WorkflowStep = async (previous, ctx) => {
  const input = previous as RunStrategiesInputT;
  // 显式 strategyIds 时不依赖 list_strategies（其失败不应阻断显式运行）
  let ids: readonly string[];
  if (input.strategyIds === undefined) {
    const listed = await ctx.tools.list_strategies.execute({ filter: { status: 'active' } });
    if (!listed.ok) return listed;
    ids = listed.data.strategies.map((strategy) => strategy.id);
  } else {
    ids = [...new Set(input.strategyIds)];
  }
  const items: z.infer<typeof RunStrategiesItemSchema>[] = [];
  for (const strategyId of ids) {
    const result = await ctx.tools.run_strategy.execute({
      strategyId,
      mode: input.mode,
      ...(input.asOf === undefined ? {} : { asOf: input.asOf }),
      ...(input.stockIds === undefined ? {} : { stockIds: input.stockIds }),
      persist: input.persist,
    });
    if (!result.ok) {
      const error =
        'message' in result.error
          ? result.error.message
          : 'cause' in result.error
            ? result.error.cause
            : 'required' in result.error
              ? `permission required: ${result.error.required}`
              : `${result.error.entity} not found: ${result.error.id}`;
      items.push({ strategyId, status: 'failed', selected: 0, signals: 0, error });
      continue;
    }
    items.push({
      strategyId,
      status: result.data.run.status === 'running' ? 'failed' : result.data.run.status,
      runId: result.data.run.id,
      selected: result.data.results.filter((candidate) => candidate.selected).length,
      signals: result.data.signals.length,
      ...(result.data.run.error === undefined ? {} : { error: result.data.run.error }),
    });
  }
  return RunStrategiesOutput.parse({
    items,
    complete: items.filter((item) => item.status === 'complete').length,
    partial: items.filter((item) => item.status === 'partial').length,
    failed: items.filter((item) => item.status === 'failed').length,
  });
};

export const runStrategiesWorkflow = defineWorkflow<RunStrategiesInputT, RunStrategiesOutputT>({
  name: 'run-strategies',
  description: '顺序运行 active Strategies；单个失败不会阻塞其它 Strategy',
  input: RunStrategiesInput,
  steps: [runAll],
});
