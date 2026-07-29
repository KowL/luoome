import { assertWorkflowRunInvariants, WorkflowRunSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

export const RecordWorkflowRunInput = z.object({
  run: WorkflowRunSchema,
});

export const RecordWorkflowRunOutput = z.object({
  run: WorkflowRunSchema,
});

export const recordWorkflowRunTool = defineTool({
  name: 'record_workflow_run',
  description: '创建或更新同一 id 的 workflow 运行审计记录',
  sideEffect: 'write',
  input: RecordWorkflowRunInput,
  output: RecordWorkflowRunOutput,
  handler: async (input, ctx) => {
    assertWorkflowRunInvariants(input.run);
    await ctx.repos.workflowRun.save(input.run);
    return { run: input.run };
  },
});
