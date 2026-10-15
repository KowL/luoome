import { randomUUID } from 'node:crypto';
import { dateInShanghai, isHoliday, isWeekend, type ToolContext } from '@luoome/core';
import { z } from 'zod';
import { completeStrategyObservationsWorkflow } from './complete-strategy-observations.js';
import { buildWorkflowTools, defineWorkflow } from './define-workflow.js';
import { StrategyDailyCycleOutput, strategyDailyCycleWorkflow } from './strategy-daily-cycle.js';

export const HostedStrategyInput = z.object({}).strict();
export const HostedStrategyOutput = z.object({
  acquired: z.boolean(),
  cycle: StrategyDailyCycleOutput.optional(),
  completedObservations: z.number().int().nonnegative(),
  pendingObservations: z.number().int().nonnegative(),
});

export const hostedStrategyWorkflow = defineWorkflow<
  z.infer<typeof HostedStrategyInput>,
  z.infer<typeof HostedStrategyOutput>
>({
  name: 'hosted-strategy',
  description: '按租户执行盘后 Strategy 日循环，并补全 T+1/T+3/T+5 观察',
  input: HostedStrategyInput,
  steps: [
    async (_input, ctx) => {
      const output: z.infer<typeof HostedStrategyOutput> = {
        acquired: false,
        completedObservations: 0,
        pendingObservations: 0,
      };
      const now = ctx.clock();
      if (
        isWeekend(now) ||
        isHoliday(now) ||
        now < new Date(`${dateInShanghai(now)}T16:30:00+08:00`)
      )
        return output;
      const execution = ctx.tools.hosted_strategy_execution;
      const owner = randomUUID();
      const claimed = await execution.execute({ action: 'acquire', owner });
      if (!claimed.ok) return claimed;
      if (!claimed.data.acquired) return output;
      output.acquired = true;
      let lost = false;
      const renew = async () => {
        if (lost) return false;
        const result = await execution.execute({ action: 'renew', owner });
        lost ||= !result.ok || !result.data.acquired;
        return !lost;
      };
      const timer = setInterval(() => void renew(), 30_000);
      const guarded: ToolContext = {
        ...ctx,
        hostedAuthorization: async (name, input, capabilities) => {
          if (!(await renew()))
            return {
              ok: false,
              error: {
                kind: 'lease_lost_before_commit',
                message: 'Strategy worker 执行租约已失效',
              },
            };
          return (await ctx.hostedAuthorization?.(name, input, capabilities)) ?? null;
        },
      };
      try {
        const tools = buildWorkflowTools(guarded);
        const reconciled = await tools.reconcile_stale_strategy_runs.execute({
          olderThanMinutes: 30,
          limit: 100,
        });
        if (!reconciled.ok) return reconciled;
        const cycle = await strategyDailyCycleWorkflow.run(
          { owner, deferReports: true, concurrency: 2 },
          guarded,
        );
        if (!cycle.ok) return cycle;
        output.cycle = cycle.data;
        // 观察成熟与 schedule 是否到期无关；停用调度也不能丢失已有信号的后续事实。
        const observations = await completeStrategyObservationsWorkflow.run({}, guarded);
        if (!observations.ok) return observations;
        output.completedObservations = observations.data.completed;
        output.pendingObservations = observations.data.pending;
        return HostedStrategyOutput.parse(output);
      } finally {
        clearInterval(timer);
        await execution.execute({ action: 'release', owner });
      }
    },
  ],
});
