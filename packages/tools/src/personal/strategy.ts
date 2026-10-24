import { z } from 'zod';
import { defineTool } from '../define-tool.js';

export const HostedStrategyExecutionInput = z
  .object({
    action: z.enum(['acquire', 'renew', 'release']),
    owner: z.string().min(1),
  })
  .strict();
export const HostedStrategyExecutionOutput = z.object({ acquired: z.boolean() });
export const hostedStrategyExecutionTool = defineTool({
  name: 'hosted_strategy_execution',
  description: '按本地领取、续租或结束 Strategy 盘后执行槽',
  sideEffect: 'write',
  input: HostedStrategyExecutionInput,
  output: HostedStrategyExecutionOutput,
  handler: async ({ action, owner }, ctx) => {
    const now = ctx.clock();
    return {
      acquired: await ctx.repos.workflowRun.execution({
        id: 'strategy-execution',
        workflowName: 'strategy-execution',
        action,
        owner,
        now,
        leaseUntil: new Date(now.getTime() + 120_000),
        nextRunAt: new Date((Math.floor(now.getTime() / 60_000) + 1) * 60_000),
      }),
    };
  },
});
