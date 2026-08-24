import { QuoteSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';
import { resolveQuotes } from '../internal/resolve-quotes.js';

/**
 * sync_quotes（v0.2 起，external）。
 * 同步账户下所有活跃持仓的实时行情（accountId 缺省走 ctx.user.defaultAccountId）。
 * 流程：list_holdings → 抽 stockIds → resolveQuotes（实时批量拉取 + 落 quote_snapshot +
 * 缓存兜底）。返回实时成功条数；单条失败回落本地快照、不影响整体，synced 只计实时命中的。
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
    const items = await resolveQuotes(ctx, stockIds, { context: 'display' });
    const synced = items.flatMap((item) =>
      item.status === 'ok' && item.retrieval === 'live' ? [item.quote] : [],
    );
    return { synced, totalRequested: stockIds.length };
  },
});
