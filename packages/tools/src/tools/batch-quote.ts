import { QuoteSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

/**
 * batch_quote（v0.2 起，external）。
 * 批量拉行情；stockIds 全解析为 Stock.id 后批量 fetch + 写 quote_snapshot。
 * 未找到的 stockId 静默跳过（不抛错，与 v0.1 list_holdings 容忍单条失败的语义一致）。
 */
export const BatchQuoteInput = z.object({
  stockIds: z.array(z.string().min(1)).min(1).max(100),
});

export const BatchQuoteOutput = z.object({
  quotes: z.array(QuoteSchema),
  /** 请求了但未找到 / 未解析的 stockId 列表，方便调用方对齐。 */
  unresolved: z.array(z.string()),
});

export const batchQuoteTool = defineTool({
  name: 'batch_quote',
  description: '批量拉行情并写 quote_snapshot；解析失败的 stockId 列入 unresolved',
  sideEffect: 'external',
  input: BatchQuoteInput,
  output: BatchQuoteOutput,
  handler: async (input, ctx) => {
    const resolved: string[] = [];
    const unresolved: string[] = [];
    for (const raw of input.stockIds) {
      const stock =
        (await ctx.repos.stock.findById(raw)) ??
        (await ctx.repos.stock.findByCode(raw.trim().toUpperCase()));
      if (stock === null) unresolved.push(raw);
      else resolved.push(stock.id);
    }
    const quotes = resolved.length === 0 ? [] : await ctx.adapters.market.batchQuote(resolved);
    const quoteList = [...quotes.values()];
    await Promise.all(quoteList.map((q) => ctx.repos.quote.save(q)));
    return { quotes: quoteList, unresolved };
  },
});
