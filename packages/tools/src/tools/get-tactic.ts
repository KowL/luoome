import { TacticSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';

export const GetTacticInput = z.object({
  tacticId: z.string().min(1),
});

export const GetTacticOutput = z.object({
  tactic: TacticSchema,
});

/**
 * 查单个战法详情（v0.3 起，read）。
 */
export const getTacticTool = defineTool({
  name: 'get_tactic',
  description: '查单个战法详情（trigger / score / evidenceTemplate）',
  sideEffect: 'read',
  input: GetTacticInput,
  output: GetTacticOutput,
  handler: async (input, ctx) => {
    const t = await ctx.repos.tactic.findById(input.tacticId);
    if (t === null) return errNotFound('Tactic', input.tacticId);
    return { tactic: TacticSchema.parse(t) };
  },
});
