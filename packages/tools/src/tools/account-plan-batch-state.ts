import { WorkflowRunSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

export const BeginAccountPlanBatchInput = z.object({ run: WorkflowRunSchema });
export const BeginAccountPlanBatchOutput = z.object({
  claimed: z.boolean(),
  run: WorkflowRunSchema,
});

export const beginAccountPlanBatchTool = defineTool({
  name: 'begin_account_plan_batch',
  description: '原子领取账户当日计划批次',
  sideEffect: 'write',
  input: BeginAccountPlanBatchInput,
  output: BeginAccountPlanBatchOutput,
  handler: async ({ run }, ctx) => {
    if (run.workflowName !== 'account-plan-batch' || run.status !== 'running')
      throw new Error('invalid account plan batch claim');
    const now = ctx.clock();
    const claimed = await ctx.repos.workflowRun.claim(run, {
      staleRunningBefore: new Date(now.getTime() - 120 * 60_000),
      failedRetryBefore: new Date(now.getTime() - 15 * 60_000),
    });
    const current = claimed ? run : await ctx.repos.workflowRun.findById(run.id);
    if (current === null) throw new Error('account plan batch claim disappeared');
    return { claimed, run: current };
  },
});

export const GetAccountPlanBatchInput = z.object({ id: z.string().min(1) });
export const GetAccountPlanBatchOutput = z.object({ run: WorkflowRunSchema.nullable() });

export const getAccountPlanBatchTool = defineTool({
  name: 'get_account_plan_batch',
  description: '读取账户当日计划批次状态',
  sideEffect: 'read',
  input: GetAccountPlanBatchInput,
  output: GetAccountPlanBatchOutput,
  handler: async ({ id }, ctx) => ({ run: await ctx.repos.workflowRun.findById(id) }),
});

export const FinishAccountPlanBatchInput = z.object({
  run: WorkflowRunSchema,
  claimToken: z.string().min(1),
});
export const FinishAccountPlanBatchOutput = z.object({ finished: z.boolean() });

export const finishAccountPlanBatchTool = defineTool({
  name: 'finish_account_plan_batch',
  description: '仅由领取者结束账户计划批次',
  sideEffect: 'write',
  input: FinishAccountPlanBatchInput,
  output: FinishAccountPlanBatchOutput,
  handler: async ({ run, claimToken }, ctx) => {
    if (run.workflowName !== 'account-plan-batch' || run.status === 'running')
      throw new Error('invalid account plan batch finish');
    return { finished: await ctx.repos.workflowRun.finishClaim(run, claimToken) };
  },
});
