import { TacticSignalSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

export const TacticSignalsByTacticInput = z.object({
  tacticId: z.string().min(1),
  since: z.coerce.date().optional(),
  limit: z.number().int().positive().max(500).default(50),
});

export const TacticSignalsByTacticOutput = z.object({
  tacticId: z.string(),
  signals: z.array(TacticSignalSchema),
  total: z.number().int().nonnegative(),
});

/**
 * 按战法 id 查信号（v0.3 起，read）。
 */
export const tacticSignalsByTacticTool = defineTool({
  name: 'tactic_signals_by_tactic',
  description: '按战法 id 查询该战法的全部历史信号（按 ts 倒序）',
  sideEffect: 'read',
  input: TacticSignalsByTacticInput,
  output: TacticSignalsByTacticOutput,
  handler: async (input, ctx) => {
    const sigs = await ctx.repos.tactic.signalsByTactic(input.tacticId, input.since);
    const sliced = sigs.slice(0, input.limit);
    return {
      tacticId: input.tacticId,
      signals: z.array(TacticSignalSchema).parse(sliced),
      total: sigs.length,
    };
  },
});
