import { dateInShanghai, type Quote, QuoteSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

/**
 * batch_quote（v0.2 起，external）。
 * 批量拉行情；stockIds 全解析为 Stock.id 后批量 fetch + 写 quote_snapshot。
 * 未找到的 stockId 静默跳过（不抛错，与 v0.1 list_holdings 容忍单条失败的语义一致）。
 * 上游失败的标的回落 DB 内最近一次 quote_snapshot，避免一次抖动把整页行情清空。
 */
export const BatchQuoteInput = z.object({
  stockIds: z.array(z.string().min(1)).min(1).max(100),
  context: z.enum(['display', 'intraday-rule', 'post-market']).default('display'),
  watchIntervalSeconds: z.number().int().positive().max(3600).default(60),
});

const BatchQuoteItem = z.discriminatedUnion('status', [
  z.object({
    stockId: z.string(),
    /** 股票目录里的名称，聚合页（dashboard 看板 / 关注总览）直接展示，不再二次解析。 */
    stockName: z.string(),
    status: z.literal('ok'),
    quote: QuoteSchema,
    retrieval: z.enum(['live', 'local-fallback']),
    freshness: z.enum(['fresh', 'stale']),
  }),
  z.object({
    stockId: z.string(),
    status: z.literal('unresolved'),
    reason: z.string(),
  }),
  z.object({
    stockId: z.string(),
    status: z.literal('unavailable'),
    reason: z.string(),
  }),
]);

export const BatchQuoteOutput = z.object({
  items: z.array(BatchQuoteItem),
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
    const resolved: Array<{ id: string; name: string }> = [];
    const items: z.infer<typeof BatchQuoteItem>[] = [];
    for (const raw of input.stockIds) {
      const stock =
        (await ctx.repos.stock.findById(raw)) ??
        (await ctx.repos.stock.findByCode(raw.trim().toUpperCase()));
      if (stock === null) {
        items.push({ stockId: raw, status: 'unresolved', reason: 'stock_not_found' });
      } else if (!resolved.some((s) => s.id === stock.id)) {
        resolved.push({ id: stock.id, name: stock.name });
      }
    }
    const now = ctx.clock();
    const freshAfterMs = Math.max(input.watchIntervalSeconds * 2_000, 180_000);
    const classify = (
      stockId: string,
      stockName: string,
      quote: Quote,
      retrieval: 'live' | 'local-fallback',
    ): z.infer<typeof BatchQuoteItem> => {
      const ageMs = now.getTime() - quote.observedAt.getTime();
      const sameTradingDay = dateInShanghai(now) === dateInShanghai(quote.observedAt);
      const fresh = ageMs >= 0 && ageMs <= freshAfterMs;
      const accepted =
        input.context === 'display' ||
        (input.context === 'intraday-rule' && sameTradingDay && fresh) ||
        (input.context === 'post-market' && sameTradingDay);
      if (!accepted) {
        return {
          stockId,
          status: 'unavailable',
          reason: sameTradingDay ? 'quote_stale' : 'quote_not_current_trading_day',
        };
      }
      return {
        stockId,
        stockName,
        status: 'ok',
        quote,
        retrieval,
        freshness: fresh ? 'fresh' : 'stale',
      };
    };

    if (resolved.length > 0) {
      const quotes = await ctx.adapters.market.batchQuote(resolved.map((s) => s.id));
      const liveQuotes = [...quotes.values()].map((quote) => QuoteSchema.parse(quote));
      await Promise.all(liveQuotes.map((q) => ctx.repos.quote.save(q)));
      const fetched = new Map(liveQuotes.map((q) => [q.stockId, q]));
      for (const { id, name } of resolved) {
        const live = fetched.get(id);
        if (live !== undefined) {
          items.push(classify(id, name, live, 'live'));
          continue;
        }
        const cached = await ctx.repos.quote.latestByStock(id);
        if (cached !== null) {
          items.push(classify(id, name, cached, 'local-fallback'));
        } else {
          items.push({ stockId: id, status: 'unavailable', reason: 'quote_unavailable' });
        }
      }
    }
    const quotes = items.flatMap((item) => (item.status === 'ok' ? [item.quote] : []));
    const unresolved = items.flatMap((item) => (item.status === 'ok' ? [] : [item.stockId]));
    return { items, quotes, unresolved };
  },
});
