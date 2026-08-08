import { isHoliday, isWeekend } from '@luoome/core';
import { z } from 'zod';

import { defineWorkflow, type WorkflowStep } from './define-workflow.js';

export const RunStrategySchedulesInput = z.object({
  owner: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
export type RunStrategySchedulesInputT = z.infer<typeof RunStrategySchedulesInput>;

const ItemSchema = z.object({
  strategyId: z.string(),
  scheduleId: z.string(),
  status: z.enum(['ran', 'skipped', 'failed']),
  runId: z.string().optional(),
  reason: z.string().optional(),
});
export const RunStrategySchedulesOutput = z.object({
  items: z.array(ItemSchema),
  ran: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type RunStrategySchedulesOutputT = z.infer<typeof RunStrategySchedulesOutput>;

const errorText = (error: Record<string, unknown>): string =>
  typeof error.message === 'string'
    ? error.message
    : typeof error.cause === 'string'
      ? error.cause
      : String(error.kind ?? 'unknown error');

const runDue: WorkflowStep = async (previous, ctx) => {
  const input = previous as RunStrategySchedulesInputT;
  const owner = input.owner ?? `strategy-scheduler:${globalThis.crypto.randomUUID()}`;
  const claimed = await ctx.tools.claim_due_strategy_schedules.execute({
    owner,
    limit: input.limit,
    leaseMinutes: 120,
  });
  if (!claimed.ok) return claimed;
  const items: z.infer<typeof ItemSchema>[] = [];
  for (const claim of claimed.data.items) {
    const { schedule } = claim;
    let status: 'ran' | 'skipped' | 'failed' = 'skipped';
    let reason = claim.reason;
    let runId: string | undefined;
    const now = ctx.clock();
    if (claim.eligible && !isWeekend(now) && !isHoliday(now)) {
      const result = await ctx.tools.run_strategy.execute({
        strategyId: schedule.strategyId,
        mode: 'scheduled',
        persist: true,
      });
      if (result.ok) {
        status = 'ran';
        runId = result.data.run.id;
      } else {
        status = 'failed';
        reason = errorText(result.error as unknown as Record<string, unknown>);
      }
    } else if (claim.eligible) {
      reason = '非 A 股交易日，本次跳过并推进下一次运行';
    }
    const finished = await ctx.tools.finish_strategy_schedule_claim.execute({
      scheduleId: schedule.id,
      owner,
      ...(runId === undefined ? {} : { lastRunId: runId }),
    });
    if (!finished.ok) {
      status = 'failed';
      reason = errorText(finished.error as unknown as Record<string, unknown>);
    }
    items.push({
      strategyId: schedule.strategyId,
      scheduleId: schedule.id,
      status,
      ...(runId === undefined ? {} : { runId }),
      ...(reason === undefined ? {} : { reason }),
    });
  }
  return RunStrategySchedulesOutput.parse({
    items,
    ran: items.filter((item) => item.status === 'ran').length,
    skipped: items.filter((item) => item.status === 'skipped').length,
    failed: items.filter((item) => item.status === 'failed').length,
  });
};

export const runStrategySchedulesWorkflow = defineWorkflow<
  RunStrategySchedulesInputT,
  RunStrategySchedulesOutputT
>({
  name: 'run-strategy-schedules',
  description: '原子抢占到期 StrategySchedule 并触发 scheduled StrategyRun',
  input: RunStrategySchedulesInput,
  steps: [runDue],
});
