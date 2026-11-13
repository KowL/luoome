import { z } from 'zod';

import {
  CompleteStrategyObservationsWorkflowInput,
  completeStrategyObservationsOperation,
} from './complete-strategy-observations.js';
import { defineWorkflow } from './define-workflow.js';
import { RunStrategiesInput, runStrategiesOperation } from './run-strategies.js';
import {
  RunStrategySchedulesInput,
  runStrategySchedulesOperation,
} from './run-strategy-schedules.js';
import { StrategyDailyCycleInput, strategyDailyCycleOperation } from './strategy-daily-cycle.js';

/**
 * 策略入口：手动运行 / 到期调度 / 单策略日循环 / 观察补全共用一条 workflow 入口。
 *
 * 每条管线仍写自己的审计名（`run-strategies` / `run-strategy-schedules` /
 * `strategy-daily-cycle` / `complete-strategy-observations`），合并只减少入口数量。
 */
export const StrategyWorkflowInput = z.discriminatedUnion('job', [
  RunStrategiesInput.extend({ job: z.literal('run') }),
  RunStrategySchedulesInput.extend({ job: z.literal('scheduled') }),
  StrategyDailyCycleInput.extend({ job: z.literal('daily') }),
  CompleteStrategyObservationsWorkflowInput.extend({ job: z.literal('observations') }),
]);

export type StrategyWorkflowInputT = z.infer<typeof StrategyWorkflowInput>;

export const strategyWorkflow = defineWorkflow<StrategyWorkflowInputT, unknown>({
  name: 'strategy',
  description:
    '策略运行入口（job=run|scheduled|daily|observations）：手动运行、到期调度、日循环或观察补全',
  input: StrategyWorkflowInput,
  steps: [
    (prev, ctx) => {
      const { job, ...rest } = prev as StrategyWorkflowInputT;
      switch (job) {
        case 'run':
          return runStrategiesOperation.run(rest, ctx);
        case 'scheduled':
          return runStrategySchedulesOperation.run(rest, ctx);
        case 'daily':
          return strategyDailyCycleOperation.run(rest, ctx);
        case 'observations':
          return completeStrategyObservationsOperation.run(rest, ctx);
      }
    },
  ],
});
