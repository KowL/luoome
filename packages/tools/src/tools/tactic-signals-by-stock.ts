import { TacticSignalSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

export const TacticSignalsByStockInput = z.object({
  stockId: z.string().min(1),
  since: z.coerce.date().optional(),
  limit: z.number().int().positive().max(500).default(50),
});

export const TacticSignalsByStockOutput = z.object({
  stockId: z.string(),
  signals: z.array(TacticSignalSchema),
  total: z.number().int().nonnegative(),
});

/**
 * 按股票 id 查信号（v0.3 起，read）。
 */
export const tacticSignalsByStockTool = defineTool({
  name: 'tactic_signals_by_stock',
  description: '按股票 id 查询该股票触发的全部战法信号（按 ts 倒序）',
  sideEffect: 'read',
  input: TacticSignalsByStockInput,
  output: TacticSignalsByStockOutput,
  handler: async (input, ctx) => {
    const sigs = await ctx.repos.tactic.signalsByStock(input.stockId, input.since);
    const sorted = [...sigs].sort((a, b) => b.ts.getTime() - a.ts.getTime());
    const sliced = sorted.slice(0, input.limit);
    return {
      stockId: input.stockId,
      signals: z.array(TacticSignalSchema).parse(sliced),
      total: sorted.length,
    };
  },
});
