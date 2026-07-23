import { stockCode as brandStockCode, StockSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

/**
 * search_stocks（v0.2 起，read；v0.8 起接外部数据源）。
 * 模糊搜索 stock：query 为空或仅空白时返回空数组。
 * 数据源链路：adapter.searchStocks（Eastmoney 主 → Tencent 备）
 * 优先；adapter 未实现或抛错时降级本地 StockRepository.search。
 * limit 默认 20，最大 100（防御性上限，避免 agent 误传 10000 把表拖垮）。
 */
export const SearchStocksInput = z.object({
  query: z.string().max(100),
  limit: z.number().int().positive().max(100).default(20),
});

export const SearchStocksOutput = z.object({
  stocks: z.array(StockSchema),
  total: z.number().int().nonnegative(),
  /** 结果来源：market = 外部数据源；local = 本地库兜底。 */
  source: z.enum(['market', 'local']),
});

export const searchStocksTool = defineTool({
  name: 'search_stocks',
  description:
    '按代码 / 名称搜股票（外部数据源：Eastmoney 主 → Tencent 备，本地库兜底）；query 留空返回空数组；limit 默认 20',
  sideEffect: 'read',
  input: SearchStocksInput,
  output: SearchStocksOutput,
  handler: async (input, ctx) => {
    const query = input.query.trim();
    if (query.length === 0) return { stocks: [], total: 0, source: 'local' as const };

    const { market } = ctx.adapters;
    if (typeof market.searchStocks === 'function') {
      try {
        const candidates = await market.searchStocks(query);
        const stocks = candidates.slice(0, input.limit).map((c) => ({
          id: c.id,
          code: brandStockCode(c.code),
          exchange: c.exchange,
          name: c.name,
        }));
        return { stocks, total: candidates.length, source: 'market' as const };
      } catch {
        // 外部源失败 → 降级本地库（search 是读路径，永不因搜索源挂掉而报错）
      }
    }

    const stocks = await ctx.repos.stock.search(query);
    const limited = stocks.slice(0, input.limit);
    return { stocks: limited, total: stocks.length, source: 'local' as const };
  },
});
