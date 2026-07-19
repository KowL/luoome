import { StockSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

/**
 * search_stocks（v0.2 起，read）。
 * 模糊搜索 stock：query 为空或仅空白时返回空数组；底层走 StockRepository.search。
 * limit 默认 20，最大 100（防御性上限，避免 agent 误传 10000 把表拖垮）。
 */
export const SearchStocksInput = z.object({
  query: z.string().max(100),
  limit: z.number().int().positive().max(100).default(20),
});

export const SearchStocksOutput = z.object({
  stocks: z.array(StockSchema),
  total: z.number().int().nonnegative(),
});

export const searchStocksTool = defineTool({
  name: 'search_stocks',
  description: '按代码 / 名称模糊搜 stock；query 留空返回空数组；limit 默认 20',
  sideEffect: 'read',
  input: SearchStocksInput,
  output: SearchStocksOutput,
  handler: async (input, ctx) => {
    const stocks = await ctx.repos.stock.search(input.query);
    const limited = stocks.slice(0, input.limit);
    return { stocks: limited, total: stocks.length };
  },
});
