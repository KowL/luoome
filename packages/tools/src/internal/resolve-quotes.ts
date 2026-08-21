import { dateInShanghai, type Quote, QuoteSchema, type ToolContext } from '@luoome/core';

export type QuoteResolveContext = 'display' | 'intraday-rule' | 'post-market';

export type ResolvedQuoteItem =
  | {
      stockId: string;
      stockName: string;
      status: 'ok';
      quote: Quote;
      retrieval: 'live' | 'local-fallback';
      freshness: 'fresh' | 'stale';
    }
  | { stockId: string; status: 'unresolved' | 'unavailable'; reason: string };

/** 单次 batchQuote 拉取上限（与 batch_quote 输入上限同源）。 */
const RESOLVE_CHUNK_SIZE = 100;

/**
 * 统一行情获取：解析 stockId → 实时批量拉取并落 quote_snapshot →
 * 实时缺席的标的回退本地最近快照（local-fallback）→ 按 context 校验新鲜度。
 * 调用方按 status 自行取舍，不抛异常。
 */
export const resolveQuotes = async (
  ctx: ToolContext,
  stockIds: readonly string[],
  opts: { context: QuoteResolveContext; watchIntervalSeconds?: number },
): Promise<ResolvedQuoteItem[]> => {
  const watchIntervalSeconds = opts.watchIntervalSeconds ?? 60;
  const resolved: Array<{ id: string; name: string }> = [];
  const items: ResolvedQuoteItem[] = [];
  for (const raw of stockIds) {
    const stock =
      (await ctx.repos.stock.findById(raw)) ??
      (await ctx.repos.stock.findByCode(raw.trim().toUpperCase()));
    if (stock === null) {
      items.push({ stockId: raw, status: 'unresolved', reason: 'stock_not_found' });
    } else if (!resolved.some((s) => s.id === stock.id)) {
      resolved.push({ id: stock.id, name: stock.name });
    }
  }

  const freshAfterMs = Math.max(watchIntervalSeconds * 2_000, 180_000);
  const classify = (
    stockId: string,
    stockName: string,
    quote: Quote,
    retrieval: 'live' | 'local-fallback',
  ): ResolvedQuoteItem => {
    const now = ctx.clock();
    const ageMs = now.getTime() - quote.observedAt.getTime();
    const sameTradingDay = dateInShanghai(now) === dateInShanghai(quote.observedAt);
    const fresh = ageMs >= 0 && ageMs <= freshAfterMs;
    const accepted =
      opts.context === 'display' ||
      (opts.context === 'intraday-rule' && sameTradingDay && fresh) ||
      (opts.context === 'post-market' && sameTradingDay);
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

  if (resolved.length === 0) return items;

  const fetched = new Map<string, Quote>();
  for (let offset = 0; offset < resolved.length; offset += RESOLVE_CHUNK_SIZE) {
    const chunk = resolved.slice(offset, offset + RESOLVE_CHUNK_SIZE);
    try {
      const quotes = await ctx.adapters.market.batchQuote(chunk.map((s) => s.id));
      const liveQuotes = [...quotes.values()].map((quote) => QuoteSchema.parse(quote));
      await Promise.all(liveQuotes.map((quote) => ctx.repos.quote.save(quote)));
      for (const quote of liveQuotes) fetched.set(quote.stockId, quote);
    } catch (error) {
      // 整批失败不向上抛：该批标的全部回落本地快照，避免一次抖动清空整页行情。
      ctx.logger.warn('resolveQuotes: 实时批量拉取失败，该批回退本地快照', {
        chunkSize: chunk.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
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
  return items;
};

/** 单股便捷封装；返回 undefined 表示 stockId 未入库（unresolved）。 */
export const resolveQuote = async (
  ctx: ToolContext,
  stockId: string,
  opts: { context: QuoteResolveContext; watchIntervalSeconds?: number },
): Promise<ResolvedQuoteItem | undefined> => {
  const [item] = await resolveQuotes(ctx, [stockId], opts);
  return item;
};
