import {
  type DailyBar,
  DataFreshnessSchema,
  dateInShanghai,
  ExchangeSchema,
  MoneySchema,
  type Quote,
  QuoteSchema,
  TechnicalIndicatorsSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errAdapterError, errNotFound } from '../define-tool.js';
import { computeSimpleIndicators } from '../internal/indicators.js';
import { ensureStockStub, STOCK_ID_PATTERN } from '../internal/manual-entry.js';
import {
  buildMarketCandles,
  buildMarketDataStatus,
  candlesToBars,
  computeMarketSession,
  derivePreviousClose,
  deriveQuoteChange,
  normalizeDailyBars,
  normalizeMarketRange,
} from '../internal/market-view.js';

/**
 * get_stock_market_view（个股行情查看 Phase 1，docs/ddd/stock-market-view-detailed-design.md §7）。
 * 一次返回股票、实时快照、日 K、派生涨跌、指标和数据状态；
 * sideEffect=external：访问外部行情源，成功结果写入 Quote / DailyBar repository。
 * 组合规则集中在 Tool 内，CLI / MCP / Web 复用同一契约；页面不复制行情派生逻辑。
 */

export const MarketViewRangeSchema = z.enum(['1m', '3m', '6m', '1y']);

export const GetStockMarketViewInput = z.object({
  stockId: z.string().trim().min(1),
  /** 搜索候选带回的股票名；完整 stockId 尚未入库时一并登记。 */
  stockName: z.string().trim().min(1).max(100).optional(),
  range: MarketViewRangeSchema.default('3m'),
});

export const MarketCandleSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  open: MoneySchema,
  high: MoneySchema,
  low: MoneySchema,
  close: MoneySchema,
  volume: z.number().nonnegative(),
  source: z.string().min(1),
  completeness: z.enum(['closed', 'live']),
});

const MarketQuoteSummarySchema = z.object({
  quote: QuoteSchema,
  previousClose: MoneySchema.nullable(),
  change: z.number().nullable(),
  changePct: z.number().nullable(),
});

const MarketDataStatusSchema = z.object({
  freshness: DataFreshnessSchema,
  retrieval: z.enum(['live', 'local-fallback']),
  quoteFetchedAt: z.coerce.date().nullable(),
  barsAsOf: z.string().nullable(),
  sources: z.array(z.string().min(1)),
  marketSession: z.enum(['pre-open', 'trading', 'midday-break', 'closed', 'non-trading-day']),
  warnings: z.array(
    z.enum([
      'quote-local-fallback',
      'bars-local-fallback',
      'provider-fallback',
      'previous-close-unavailable',
      'bars-insufficient',
      'market-closed',
    ]),
  ),
});

export const GetStockMarketViewOutput = z.object({
  stock: z.object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    exchange: ExchangeSchema,
  }),
  quote: MarketQuoteSummarySchema,
  candles: z.array(MarketCandleSchema),
  indicators: TechnicalIndicatorsSchema,
  indicatorsAsOf: z.string().nullable(),
  dataStatus: MarketDataStatusSchema,
});

export const getStockMarketViewTool = defineTool({
  name: 'get_stock_market_view',
  description: '获取个股实时快照、日 K、指标和数据状态',
  sideEffect: 'external',
  input: GetStockMarketViewInput,
  output: GetStockMarketViewOutput,
  handler: async (input, ctx) => {
    // 股票解析：完整 Stock.id / 纯代码；完整新 id + stockName 自动登记（与 fetch_quote 同约定）。
    const normalized = input.stockId.trim().toUpperCase();
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
    if (stock === null) return errNotFound('Stock', input.stockId);

    const now = ctx.clock();
    const { start, end } = normalizeMarketRange(input.range, now);
    const market = ctx.adapters.market;

    // Quote 与 bars 在股票解析后并行拉取，失败各自回退 DB（§8.2）。
    const [quoteResult, barsResult] = await Promise.allSettled([
      market.fetchQuote(stock.id),
      market.fetchDailyBars(stock.id, { start, end }),
    ]);

    const adapterSummary = (reason: unknown): string =>
      reason instanceof Error ? reason.message : String(reason);

    let quote: Quote | null = null;
    let quoteLive = false;
    if (quoteResult.status === 'fulfilled') {
      quote = quoteResult.value;
      quoteLive = true;
      await ctx.repos.quote.save(quote);
    } else {
      ctx.logger.warn('get_stock_market_view: quote 外部拉取失败，尝试本地快照', {
        stockId: stock.id,
        adapter: market.name,
        range: input.range,
        error: adapterSummary(quoteResult.reason),
      });
      quote = await ctx.repos.quote.latestByStock(stock.id);
      if (quote === null) {
        return errAdapterError(market.name, adapterSummary(quoteResult.reason), true);
      }
    }

    let bars: readonly DailyBar[] = [];
    let droppedInvalid = 0;
    let barsLive = false;
    if (barsResult.status === 'fulfilled' && barsResult.value.length > 0) {
      const normalized = normalizeDailyBars(barsResult.value, start, end);
      bars = normalized.bars;
      droppedInvalid = normalized.droppedInvalid;
      if (bars.length > 0) {
        barsLive = true;
        await ctx.repos.dailyBar.saveMany(bars);
      }
    }

    if (!barsLive) {
      const cause = (() => {
        if (barsResult.status === 'rejected') return adapterSummary(barsResult.reason);
        if (barsResult.value.length === 0) return '日线返回空';
        return '日线无有效记录';
      })();
      ctx.logger.warn('get_stock_market_view: 日线外部拉取失败，尝试本地缓存', {
        stockId: stock.id,
        adapter: market.name,
        range: input.range,
        error: cause,
      });
      const cached = await ctx.repos.dailyBar.findInRange(stock.id, start, end);
      if (cached.length === 0) {
        return errAdapterError(market.name, cause, true);
      }
      const normalized = normalizeDailyBars(cached, start, end);
      bars = normalized.bars;
      droppedInvalid += normalized.droppedInvalid;
      if (bars.length === 0) return errAdapterError(market.name, cause, true);
    }

    if (droppedInvalid > 0) {
      ctx.logger.warn('get_stock_market_view: 丢弃 OHLC 关系非法的日线', {
        stockId: stock.id,
        adapter: market.name,
        range: input.range,
        droppedInvalid,
      });
    }

    const quoteDateStart = new Date(`${dateInShanghai(quote.ts)}T00:00:00.000Z`);
    const previousClose = derivePreviousClose(bars, quoteDateStart);
    const candles = buildMarketCandles(bars, quote, end);
    const { change, changePct } = deriveQuoteChange(quote, previousClose);
    const indicators = computeSimpleIndicators(candlesToBars(stock.id, candles));
    const session = computeMarketSession(now);
    const sources = [...new Set([quote.source, ...candles.map((c) => c.source)])];
    const status = buildMarketDataStatus({
      quoteLive,
      barsLive,
      barsCount: bars.length,
      previousClose,
      session,
      sources,
    });
    const lastCandleDate = candles.at(-1)?.date ?? null;

    return {
      stock: { id: stock.id, code: stock.code, name: stock.name, exchange: stock.exchange },
      quote: { quote, previousClose, change, changePct },
      candles,
      indicators,
      indicatorsAsOf: lastCandleDate,
      dataStatus: {
        freshness: status.freshness,
        retrieval: status.retrieval,
        quoteFetchedAt: quote.ts,
        barsAsOf: lastCandleDate,
        sources,
        marketSession: session,
        warnings: status.warnings,
      },
    };
  },
});
