import { HoldingSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

export const CloseHoldingInput = z.object({
  holdingId: z.string().min(1),
});

export const CloseHoldingOutput = z.object({
  holding: HoldingSchema,
});

/**
 * 平仓（v0.5 起，write）：把持仓标记为已关闭（closedAt=现在），不删行。
 * 已平仓 → invalid_input。重复开仓请用 add_trade（自动复用旧行）。
 */
export const closeHoldingTool = defineTool({
  name: 'close_holding',
  description: '把一笔持仓标记为已平仓（软关闭，保留历史）',
  sideEffect: 'write',
  input: CloseHoldingInput,
  output: CloseHoldingOutput,
  handler: async (input, ctx) => {
    const existing = await ctx.repos.holding.findById(input.holdingId);
    if (existing === null) return errNotFound('Holding', input.holdingId);
    if (existing.closedAt !== null) {
      return errInvalidInput(`持仓已是平仓状态（closedAt=${existing.closedAt.toISOString()}）`);
    }
    const holding = { ...existing, closedAt: ctx.clock() };
    await ctx.repos.holding.save(holding);
    return { holding };
  },
});
