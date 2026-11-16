import { QuoteSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errAdapterError, errNotFound } from '../define-tool.js';
import { ensureStockStub, STOCK_ID_PATTERN } from '../internal/manual-entry.js';
import { resolveQuote } from '../internal/resolve-quotes.js';
import { batchQuoteTool } from './batch-quote.js';

/**
 * fetch_quote（v0.2 起，external / sideEffect）。
 * 拉单股实时行情 → 写 quote_snapshot → 返回该 Quote；上游失败回退本地最近快照。
 * stockId 可为 Stock.id 或纯代码；完整 `<code>.<exchange>` 未入库时自动登记。
 * 无法归一化为已知股票或完整 stockId 时返回 not_found。
 */
export const FetchQuoteInput = z
  .object({
    stockId: z.string().min(1).optional(),
    /** 搜索候选带回的股票名；stock 尚未入库时一并登记。 */
    stockName: z.string().trim().min(1).max(100).optional(),
    /** 多只批量拉取（合并原 batch_quote）；与 stockId 二选一。 */
    stockIds: z.array(z.string().min(1)).min(1).max(100).optional(),
    context: z.enum(['display', 'intraday-rule', 'post-market']).default('display'),
    watchIntervalSeconds: z.number().int().positive().max(3600).default(60),
  })
  .refine((input) => (input.stockId === undefined) !== (input.stockIds === undefined), {
    message: 'stockId 与 stockIds 必须且只能提供一个',
  });

export const FetchQuoteOutput = z.object({
  quote: QuoteSchema.optional(),
  quotes: z.array(QuoteSchema).optional(),
  unresolved: z.array(z.string()).optional(),
});

export const fetchQuoteTool = defineTool({
  name: 'fetch_quote',
  description:
    '拉取单只或多只股票实时行情并写 quote_snapshot；stockId 支持 Stock.id 或纯代码，批量传 stockIds',
  sideEffect: 'external',
  input: FetchQuoteInput,
  output: FetchQuoteOutput,
  handler: async (input, ctx) => {
    if (input.stockIds !== undefined) {
      const result = await batchQuoteTool.execute(
        {
          stockIds: input.stockIds,
          context: input.context,
          watchIntervalSeconds: input.watchIntervalSeconds,
        },
        ctx,
      );
      if (!result.ok) return result;
      return { quotes: result.data.quotes, unresolved: result.data.unresolved };
    }
    const normalized = (input.stockId as string).trim().toUpperCase();
    let stock =
      (await ctx.repos.stock.findById(normalized)) ??
      (await ctx.repos.stock.findByCode(normalized));
    if (stock === null && STOCK_ID_PATTERN.test(normalized)) {
      await ensureStockStub(normalized, ctx, input.stockName);
      stock = await ctx.repos.stock.findById(normalized);
    } else if (stock !== null && STOCK_ID_PATTERN.test(stock.id)) {
      await ensureStockStub(stock.id, ctx, input.stockName);
      stock = await ctx.repos.stock.findById(stock.id);
    }
    if (stock === null) return errNotFound('Stock', input.stockId as string);
    const item = await resolveQuote(ctx, stock.id, { context: 'display' });
    if (item !== undefined && item.status === 'ok') return { quote: item.quote };
    if (item !== undefined && item.status === 'unavailable') {
      return errAdapterError(ctx.adapters.market.name, item.reason, true);
    }
    return errNotFound('Stock', input.stockId as string);
  },
});
