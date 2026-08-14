import { z } from 'zod';

import { defineWorkflow, type WorkflowStep } from './define-workflow.js';
import { strategyDailyCycleWorkflow } from './strategy-daily-cycle.js';

export const RunStrategySchedulesInput = z.object({
  owner: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  concurrency: z.number().int().min(1).max(64).default(8),
});
export type RunStrategySchedulesInputT = z.infer<typeof RunStrategySchedulesInput>;

const ItemSchema = z.object({
  strategyId: z.string(),
  scheduleId: z.string(),
  /** facts-only 的日循环仍已完成事实发布，不能被调度层误报为失败。 */
  status: z.enum(['ran', 'partial', 'skipped', 'failed']),
  runId: z.string().optional(),
  adviceCount: z.number().int().nonnegative().optional(),
  recommendationError: z.string().optional(),
  reason: z.string().optional(),
});
export const RunStrategySchedulesOutput = z.object({
  items: z.array(ItemSchema),
  ran: z.number().int().nonnegative(),
  partial: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type RunStrategySchedulesOutputT = z.infer<typeof RunStrategySchedulesOutput>;

const runDue: WorkflowStep = async (previous, ctx) => {
  const input = previous as RunStrategySchedulesInputT;
  const owner = input.owner ?? `strategy-scheduler:${globalThis.crypto.randomUUID()}`;
  const cycle = await strategyDailyCycleWorkflow.run(
    { owner, limit: input.limit, leaseMinutes: 20, concurrency: input.concurrency },
    ctx,
  );
  if (!cycle.ok) return cycle;
  const items = cycle.data.items.map((item) => ({
    strategyId: item.strategyId,
    scheduleId: item.scheduleId,
    status:
      item.status === 'complete'
        ? ('ran' as const)
        : item.status === 'partial'
          ? ('partial' as const)
          : item.status === 'skipped'
            ? ('skipped' as const)
            : ('failed' as const),
    ...(item.runId === undefined ? {} : { runId: item.runId }),
    ...(item.adviceCount === undefined ? {} : { adviceCount: item.adviceCount }),
    ...(item.status === 'partial' && item.reason === undefined
      ? { recommendationError: 'strategy-daily-cycle partial' }
      : {}),
    ...(item.reason === undefined ? {} : { reason: item.reason }),
  }));
  return RunStrategySchedulesOutput.parse({
    items,
    ran: items.filter((item) => item.status === 'ran').length,
    partial: items.filter((item) => item.status === 'partial').length,
    skipped: items.filter((item) => item.status === 'skipped').length,
    failed: items.filter((item) => item.status === 'failed').length,
  });
};

export const runStrategySchedulesWorkflow = defineWorkflow<
  RunStrategySchedulesInputT,
  RunStrategySchedulesOutputT
>({
  name: 'run-strategy-schedules',
  description: '调度到期 StrategySchedule，并委托 strategy-daily-cycle 完成单周期闭环',
  input: RunStrategySchedulesInput,
  steps: [runDue],
});
