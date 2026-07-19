import { QuoteSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';

/**
 * fetch_quote（v0.2 起，external / sideEffect）。
 * 拉单股实时行情 → 写 quote_snapshot → 返回该 Quote。
 * stockId 可为 Stock.id 或纯代码；先查 Stock 表归一化，找不到时报 not_found。
 */
export const FetchQuoteInput = z.object({
  stockId: z.string().min(1),
});

export const FetchQuoteOutput = z.object({
  quote: QuoteSchema,
});

export const fetchQuoteTool = defineTool({
  name: 'fetch_quote',
  description: '拉单股实时行情，写 quote_snapshot；stockId 支持 Stock.id 或纯代码',
  sideEffect: 'external',
  input: FetchQuoteInput,
  output: FetchQuoteOutput,
  handler: async (input, ctx) => {
    const stock =
      (await ctx.repos.stock.findById(input.stockId)) ??
      (await ctx.repos.stock.findByCode(input.stockId.trim().toUpperCase()));
    if (stock === null) return errNotFound('Stock', input.stockId);
    const quote = await ctx.adapters.market.fetchQuote(stock.id);
    await ctx.repos.quote.save(quote);
    return { quote };
  },
});
