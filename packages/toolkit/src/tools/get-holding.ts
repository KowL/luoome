import { z } from 'zod';

import { defineTool, errAdapterError, errNotFound } from '../define-tool.js';
import { enrichHolding, HoldingPnlSchema } from '../internal/holding-pnl.js';
import { resolveQuote } from '../internal/resolve-quotes.js';

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
    const item = await resolveQuote(ctx, holding.stockId, { context: 'display' });
    if (item === undefined || item.status !== 'ok') {
      return errAdapterError(
        ctx.adapters.market.name,
        item !== undefined && item.status === 'unavailable' ? item.reason : 'quote_unavailable',
        true,
      );
    }
    return enrichHolding(holding, item.quote, stock?.name ?? holding.stockId);
  },
});
