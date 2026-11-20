import { z } from 'zod';

import { defineWorkflow } from './define-workflow.js';
import { RunStrategiesInput, runStrategiesOperation } from './run-strategies.js';

/**
 * 策略入口：只做「跑一次策略拿当日信号」。
 *
 * 调度、观察补全与回放链路已经下线；信号由每日判断按需产出，不再维护独立的状态机。
 */
export const StrategyWorkflowInput = RunStrategiesInput.extend({
  job: z.literal('run').default('run'),
});

export type StrategyWorkflowInputT = z.infer<typeof StrategyWorkflowInput>;

export const strategyWorkflow = defineWorkflow<StrategyWorkflowInputT, unknown>({
  name: 'strategy',
  description: '策略运行入口（job=run）：按需运行 Strategy 并返回当日信号',
  input: StrategyWorkflowInput,
  steps: [
    (prev, ctx) => {
      const { job: _job, ...rest } = prev as StrategyWorkflowInputT;
      return runStrategiesOperation.run(rest, ctx);
    },
  ],
});
