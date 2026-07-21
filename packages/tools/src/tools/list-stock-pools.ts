import { StockPoolSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

export const ListStockPoolsInput = z.object({
  /** true 仅返回 enabled=true（默认）；false 返回全部。 */
  enabledOnly: z.boolean().default(true),
});

export const ListStockPoolsOutput = z.object({
  pools: z.array(StockPoolSchema),
  total: z.number().int().nonnegative(),
});

/**
 * 列出股票池（v0.6 起，read）。
 * 默认仅返回 enabled=true 的池；显式 enabledOnly=false 可看 disabled 的。
 */
export const listStockPoolsTool = defineTool({
  name: 'list_stock_pools',
  description: '列出股票池（默认仅 enabled）',
  sideEffect: 'read',
  input: ListStockPoolsInput,
  output: ListStockPoolsOutput,
  handler: async (input, ctx) => {
    const pools = await ctx.repos.stockPool.list(input.enabledOnly);
    return { pools: z.array(StockPoolSchema).parse([...pools]), total: pools.length };
  },
});
