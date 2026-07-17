import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';
import { enrichHolding, HoldingPnlSchema } from '../internal/holding-pnl.js';

export const GetHoldingInput = z.object({
  holdingId: z.string().min(1),
});

export const GetHoldingOutput = HoldingPnlSchema;

export const getHoldingTool = defineTool({
  name: 'get_holding',
  description: '按 id 查询单条持仓详情（含现价与浮动盈亏）',
  sideEffect: 'read',
  input: GetHoldingInput,
  output: GetHoldingOutput,
  handler: async (input, ctx) => {
    const holding = await ctx.repos.holding.findById(input.holdingId);
    if (holding === null) return errNotFound('Holding', input.holdingId);

    const stock = await ctx.repos.stock.findById(holding.stockId);
    const quote = await ctx.adapters.market.fetchQuote(holding.stockId);
    return enrichHolding(holding, quote, stock?.name ?? holding.stockId);
  },
});
