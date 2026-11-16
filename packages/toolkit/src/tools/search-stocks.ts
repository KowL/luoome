import { stockCode as brandStockCode, StockSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

/**
 * search_stocks（v0.2 起，read；v0.8 起接外部数据源）。
 * 模糊搜索 stock：query 为空或仅空白时返回空数组。
 * 数据源链路：adapter.searchStocks（由 market source registry 选择具备 search 能力的源）
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
  source: z.enum(['local-universe', 'external', 'local-history']),
});

/** 产品边界：搜索只面向 A 股（SH/SZ），与股票目录 coverage CN_A_SHARES_SH_SZ 一致。 */
const isAShare = (exchange: string): boolean => exchange === 'SH' || exchange === 'SZ';

export const searchStocksTool = defineTool({
  name: 'search_stocks',
  description:
    '按代码 / 名称搜 A 股（SH/SZ；新鲜本地股票目录优先，外部数据源补充，本地历史兜底）；limit 默认 20',
  sideEffect: 'read',
  input: SearchStocksInput,
  output: SearchStocksOutput,
  handler: async (input, ctx) => {
    const query = input.query.trim();
    if (query.length === 0) {
      return { stocks: [], total: 0, source: 'local-history' as const };
    }

    const latest = await ctx.repos.stockUniverse.latestSuccessfulSync({
      coverage: 'CN_A_SHARES_SH_SZ',
    });
    const directoryFresh =
      latest?.finishedAt !== null &&
      latest?.finishedAt !== undefined &&
      ctx.clock().getTime() - latest.finishedAt.getTime() < 12 * 60 * 60 * 1000;
    if (directoryFresh) {
      const [matches, activeStocks] = await Promise.all([
        ctx.repos.stock.search(query),
        ctx.repos.stockUniverse.listCurrent({
          coverage: 'CN_A_SHARES_SH_SZ',
          status: 'active',
        }),
      ]);
      const activeIds = new Set(activeStocks.map((stock) => stock.id));
      const localUniverseMatches = matches.filter((stock) => activeIds.has(stock.id));
      if (localUniverseMatches.length > 0) {
        return {
          stocks: localUniverseMatches.slice(0, input.limit),
          total: localUniverseMatches.length,
          source: 'local-universe' as const,
        };
      }
    }

    const { market } = ctx.adapters;
    try {
      const candidates = await market.searchStocks(query);
      const aShares = candidates.filter((c) => isAShare(c.exchange));
      const stocks = aShares.slice(0, input.limit).map((c) => ({
        id: c.id,
        code: brandStockCode(c.code),
        exchange: c.exchange,
        name: c.name,
      }));
      return { stocks, total: aShares.length, source: 'external' as const };
    } catch {
      // 外部源失败 → 降级本地库（search 是读路径，永不因搜索源挂掉而报错）
    }

    const stocks = (await ctx.repos.stock.search(query)).filter((stock) =>
      isAShare(stock.exchange),
    );
    const limited = stocks.slice(0, input.limit);
    return { stocks: limited, total: stocks.length, source: 'local-history' as const };
  },
});
