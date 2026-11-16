import { type UnifiedRun, WorkflowRunStatusSchema, workflowRunToUnified } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

export const UnifiedRunSchema = z.object({
  source: z.enum(['watch', 'workflow']),
  name: z.string(),
  mode: z.string(),
  status: z.enum(['running', 'succeeded', 'partial', 'failed']),
  startedAt: z.coerce.date(),
  finishedAt: z.coerce.date().optional(),
  inputSummary: z.record(z.string(), z.unknown()).optional(),
  summary: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
});

export const ListWorkflowRunsInput = z.object({
  workflowName: z.string().min(1).optional(),
  status: WorkflowRunStatusSchema.optional(),
  since: z.coerce.date().optional(),
  limit: z.number().int().positive().max(200).default(50),
});

export const ListWorkflowRunsOutput = z.object({
  runs: z.array(UnifiedRunSchema),
});

/**
 * list_workflow_runs（ruo 迁移 §3.4 / §7.3，read）。
 * 返回 WorkflowRun 统一视图（UnifiedRun），按 startedAt 倒序；intraday-watch 同样记录在此。
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
    const runs: UnifiedRun[] = workflowRuns
      .map(workflowRunToUnified)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    return { runs: runs.slice(0, input.limit) };
  },
});
