import {
  type UnifiedRun,
  watchRunToUnified,
  WorkflowRunStatusSchema,
  workflowRunToUnified,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

export const UnifiedRunSchema = z.object({
  source: z.enum(['watch', 'workflow']),
  name: z.string(),
  mode: z.string(),
  status: z.enum(['running', 'succeeded', 'partial', 'failed']),
  startedAt: z.coerce.date(),
  finishedAt: z.coerce.date().optional(),
  summary: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
});

export const ListWorkflowRunsInput = z.object({
  workflowName: z.string().min(1).optional(),
  status: WorkflowRunStatusSchema.optional(),
  since: z.coerce.date().optional(),
  limit: z.number().int().positive().max(200).default(50),
  /** 合并 WatchRun（intraday-watch）视图，默认 true。 */
  includeWatch: z.boolean().default(true),
});

export const ListWorkflowRunsOutput = z.object({
  runs: z.array(UnifiedRunSchema),
});

/**
 * list_workflow_runs（ruo 迁移 §3.4 / §7.3，read）。
 * 默认返回 WorkflowRun + WatchRun 合并的统一视图（UnifiedRun），按 startedAt 倒序。
 */
export const listWorkflowRunsTool = defineTool({
  name: 'list_workflow_runs',
  description: '查询 workflow 运行审计（含 intraday-watch，统一读模型，按时间倒序）',
  sideEffect: 'read',
  input: ListWorkflowRunsInput,
  output: ListWorkflowRunsOutput,
  handler: async (input, ctx) => {
    const workflowRuns = await ctx.repos.workflowRun.listRecent({
      ...(input.workflowName !== undefined ? { workflowName: input.workflowName } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.since !== undefined ? { since: input.since } : {}),
      limit: input.limit,
    });
    const runs: UnifiedRun[] = workflowRuns.map(workflowRunToUnified);

    const wantWatch =
      input.includeWatch &&
      (input.workflowName === undefined || input.workflowName === 'intraday-watch');
    if (wantWatch) {
      const watchRuns = await ctx.repos.watchRun.listRecent(input.limit);
      for (const wr of watchRuns) {
        const u = watchRunToUnified(wr);
        if (input.since !== undefined && u.startedAt.getTime() < input.since.getTime()) continue;
        if (input.status !== undefined && u.status !== input.status) continue;
        runs.push(u);
      }
    }

    runs.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    return { runs: runs.slice(0, input.limit) };
  },
});
