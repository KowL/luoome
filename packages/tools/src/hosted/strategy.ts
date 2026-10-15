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
  description: 'worker-only：按租户领取、续租或结束 Strategy 盘后执行槽',
  sideEffect: 'write',
  input: HostedStrategyExecutionInput,
  output: HostedStrategyExecutionOutput,
  handler: async ({ action, owner }, ctx) => {
    if (ctx.identity?.mode !== 'hosted' || ctx.identity.actor !== 'worker')
      return {
        ok: false as const,
        error: { kind: 'permission_denied' as const, required: 'hosted:worker' },
      };
    const now = ctx.clock();
    return {
      acquired: await ctx.repos.workflowRun.execution({
        id: 'hosted-strategy-execution',
        workflowName: 'hosted-strategy-execution',
        action,
        owner,
        now,
        leaseUntil: new Date(now.getTime() + 120_000),
        nextRunAt: new Date((Math.floor(now.getTime() / 60_000) + 1) * 60_000),
      }),
    };
  },
});
