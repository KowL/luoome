import { QuoteSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

/**
 * sync_quotes（v0.2 起，external）。
 * 同步账户下所有活跃持仓的实时行情（accountId 缺省走 ctx.user.defaultAccountId）。
 * 流程：list_holdings → 抽 stockIds → batch_quote 逻辑内联（不经 tool 调用）→ 写 quote_snapshot。
 * 返回成功 / 失败条数；不抛异常（单条失败不影响整体）。
 */
export const SyncQuotesInput = z.object({
  accountId: z.uuid().optional(),
});

export const SyncQuotesOutput = z.object({
  synced: z.array(QuoteSchema),
  /** list_holdings 持有的 stockId 数量（去重后）。 */
  totalRequested: z.number().int().nonnegative(),
});

export const syncQuotesTool = defineTool({
  name: 'sync_quotes',
  description: '同步账户下所有活跃持仓的实时行情并写 quote_snapshot',
  sideEffect: 'external',
  input: SyncQuotesInput,
  output: SyncQuotesOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    const holdings = await ctx.repos.holding.listByAccount(accountId);
    const stockIds = [...new Set(holdings.map((h) => h.stockId))];
    if (stockIds.length === 0) return { synced: [], totalRequested: 0 };
    const quotes = await ctx.adapters.market.batchQuote(stockIds);
    const list = [...quotes.values()];
    await Promise.all(list.map((q) => ctx.repos.quote.save(q)));
    return { synced: list, totalRequested: stockIds.length };
  },
});
