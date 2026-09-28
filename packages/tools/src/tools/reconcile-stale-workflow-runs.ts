import { WorkflowRunSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

export const ReconcileStaleWorkflowRunsInput = z.object({
  olderThanMinutes: z
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .default(30),
  limit: z.number().int().min(1).max(100).default(20),
});

export const ReconcileStaleWorkflowRunsOutput = z.object({
  scanned: z.number().int().nonnegative(),
  reconciled: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  runIds: z.array(z.string()),
});

/**
 * 收敛进程崩溃留下的 workflow running 记录。调用方必须以明显大于正常运行时长的窗口调用，
 * 避免把仍在执行的长任务误判为 stale；正常 workflow 不应直接改 repository。
 */
export const reconcileStaleWorkflowRunsTool = defineTool({
  name: 'reconcile_stale_workflow_runs',
  description: '收敛超出租约窗口且仍为 running 的 workflow 审计记录；不处理近期运行',
  sideEffect: 'write',
  input: ReconcileStaleWorkflowRunsInput,
  output: ReconcileStaleWorkflowRunsOutput,
  handler: async (input, ctx) => {
    const now = ctx.clock();
    const cutoff = new Date(now.getTime() - input.olderThanMinutes * 60_000);
    const [recent, accountBatches] = await Promise.all([
      ctx.repos.workflowRun.listRecent({ status: 'running', limit: input.limit }),
      ctx.repos.workflowRun.listRecent({
        workflowName: 'account-plan-batch',
        status: 'running',
        limit: input.limit,
      }),
    ]);
    const running = [
      ...new Map([...recent, ...accountBatches].map((run) => [run.id, run])).values(),
    ];
    let skipped = 0;
    const runIds: string[] = [];
    for (const run of running) {
      const effectiveCutoff =
        run.workflowName === 'account-plan-batch'
          ? new Date(Math.min(cutoff.getTime(), now.getTime() - 120 * 60_000))
          : cutoff;
      if (run.startedAt > effectiveCutoff) {
        skipped += 1;
        continue;
      }
      const finishedAt = new Date(Math.max(now.getTime(), run.startedAt.getTime()));
      const failed = WorkflowRunSchema.parse({
        ...run,
        status: 'failed',
        finishedAt,
        outputSummary: {
          ...(run.outputSummary ?? {}),
          reconciliation: 'stale_workflow_run_reconciled',
          reconciledAt: finishedAt,
        },
        error: 'stale_workflow_run_reconciled',
      });
      const claimToken = run.inputSummary?.claimToken;
      let reconciled: boolean;
      if (run.workflowName === 'account-plan-batch' && typeof claimToken === 'string') {
        reconciled = await ctx.repos.workflowRun.finishClaim(failed, claimToken);
      } else {
        await ctx.repos.workflowRun.save(failed);
        reconciled = true;
      }
      if (reconciled) runIds.push(run.id);
      else skipped += 1;
    }
    return {
      scanned: running.length,
      reconciled: runIds.length,
      skipped,
      runIds,
    };
  },
});
