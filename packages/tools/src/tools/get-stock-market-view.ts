import {
  type DailyBar,
  DataFreshnessSchema,
  dateInShanghai,
  ExchangeSchema,
  MoneySchema,
  type Quote,
  QuoteSchema,
  type ReportSchema,
  TechnicalIndicatorsSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errAdapterError, errNotFound } from '../define-tool.js';
import { computeSimpleIndicators } from '../internal/indicators.js';
import {
  currentLimitUpDate,
  loadStockLimitUpFacts,
  StockLimitUpFactsSchema,
} from '../internal/limit-up-facts.js';
import { ensureStockStub, STOCK_ID_PATTERN } from '../internal/manual-entry.js';
import {
  aggregateCandles,
  buildMarketCandles,
  buildMarketDataStatus,
  candlesToBars,
  computeMarketSession,
  deriveAmplitude,
  derivePreviousClose,
  deriveQuoteChange,
  MONTH_GRANULARITY_LOOKBACK_DAYS,
  MONTH_GRANULARITY_MAX_BARS,
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
export const MarketViewGranularitySchema = z.enum(['day', 'week', 'month']);

export const GetStockMarketViewInput = z.object({
  stockId: z.string().trim().min(1),
  /** 搜索候选带回的股票名；完整 stockId 尚未入库时一并登记。 */
  stockName: z.string().trim().min(1).max(100).optional(),
  range: MarketViewRangeSchema.default('3m'),
  /** 输出 candles 粒度；indicators 恒用日级 candles 计算，聚合只影响输出。 */
  granularity: MarketViewGranularitySchema.default('day'),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
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
  amplitude: z.number().nullable(),
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
      'bars-truncated',
      'market-closed',
    ]),
  ),
});

export const MarketFactMarkerSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  factKind: z.enum([
    'trade',
    'advice',
    'watch-trigger',
    'strategy-signal',
    'report',
    'research',
    'limit-up',
  ]),
  factId: z.string().min(1),
  title: z.string().min(1).max(200),
  href: z.string().min(1),
  tone: z.enum(['action', 'advice', 'fact']),
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
  markers: z.array(MarketFactMarkerSchema),
  limitUp: StockLimitUpFactsSchema,
});

const factDateKey = (date: Date): string => dateInShanghai(date);

const markerInRange = (date: Date, start: Date, end: Date): boolean => {
  const key = factDateKey(date);
  return key >= start.toISOString().slice(0, 10) && key <= end.toISOString().slice(0, 10);
};

const reportStockIds = (report: z.infer<typeof ReportSchema>): Set<string> => {
  const ids = new Set<string>();
  for (const section of report.sections) {
    for (const block of section.blocks) {
      if (block.kind !== 'list') continue;
      for (const item of block.items) {
        if (item.entityKind === 'stock' && item.entityId !== undefined) ids.add(item.entityId);
      }
    }
  }
  return ids;
};

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
    const rangeAnchor = input.date === undefined ? now : new Date(`${input.date}T00:00:00.000Z`);
    const { start, end } = normalizeMarketRange(input.range, rangeAnchor);
    // 月 K 拉取窗口扩到 ~5 年（1y 窗口只够 12 根月 K）；markers 仍按原 range 窗口过滤。
    const fetchStart =
      input.granularity === 'month'
        ? new Date(end.getTime() - MONTH_GRANULARITY_LOOKBACK_DAYS * 86_400_000)
        : start;
    const maxBars = input.granularity === 'month' ? MONTH_GRANULARITY_MAX_BARS : undefined;
    const market = ctx.adapters.market;

    // Quote 与 bars 在股票解析后并行拉取，失败各自回退 DB（§8.2）。
    const [quoteResult, barsResult] = await Promise.allSettled([
      market.fetchQuote(stock.id),
      market.fetchDailyBars(stock.id, { start: fetchStart, end }),
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
      const normalized = normalizeDailyBars(barsResult.value, fetchStart, end, maxBars);
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
      const cached = await ctx.repos.dailyBar.findInRange(stock.id, fetchStart, end);
      if (cached.length === 0) {
        return errAdapterError(market.name, cause, true);
      }
      const normalized = normalizeDailyBars(cached, fetchStart, end, maxBars);
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

    // 周/月粒度下备源（如 tencent 单次最多 320 根）可能把历史窗口截短且不触发
    // bars-insufficient；最早 bar 距 fetchStart 超过容忍天数即视为截断并显式告警。
    const earliestBar = bars[0]?.date.getTime();
    const barsTruncated =
      input.granularity !== 'day' &&
      earliestBar !== undefined &&
      earliestBar - fetchStart.getTime() > 60 * 86_400_000;
    if (barsTruncated) {
      ctx.logger.warn('get_stock_market_view: 历史日线被数据源截断', {
        stockId: stock.id,
        adapter: market.name,
        granularity: input.granularity,
        fetchStart: fetchStart.toISOString().slice(0, 10),
        earliestBar: new Date(earliestBar).toISOString().slice(0, 10),
      });
    }

    const quoteDateStart = new Date(`${dateInShanghai(quote.observedAt)}T00:00:00.000Z`);
    const previousClose = derivePreviousClose(bars, quoteDateStart);
    const session = computeMarketSession(now);
    const anchorIsToday = input.date === undefined || input.date === dateInShanghai(now);
    // 盘前 / 非交易日当日尚无成交；retrieval 时间不能证明已有市场观测，
    // 此时把 Quote 拼成当日蜡烛会伪造一根未开盘的 K 线（§8.5 前提：当日已有交易）。
    // 历史锚点没有对应实时 Quote：保留 end 当日的 closed DailyBar；仅当前日期视图才
    // 用 Quote 替换 end 当日 bar。
    const quoteForCandle =
      anchorIsToday && session !== 'pre-open' && session !== 'non-trading-day' ? quote : null;
    const candleCutoff = anchorIsToday ? end : new Date(end.getTime() + 86_400_000);
    const candles = buildMarketCandles(bars, quoteForCandle, candleCutoff);
    const { change, changePct } = deriveQuoteChange(quote, previousClose);
    const amplitude = deriveAmplitude(quote, previousClose);
    const indicators = computeSimpleIndicators(candlesToBars(stock.id, candles));
    const sources = [...new Set([quote.source, ...candles.map((c) => c.source)])];
    const status = buildMarketDataStatus({
      quoteLive,
      barsLive,
      barsCount: bars.length,
      previousClose,
      session,
      sources,
    });
    // indicators / sources / markers 恒用日级 candles；聚合只影响输出 candles（CONTEXT.md 指标口径）。
    const outCandles = aggregateCandles(candles, input.granularity);
    const lastCandleDate = outCandles.at(-1)?.date ?? null;

    const [trades, advices, triggers, signals, reports, researchLinks, limitUp] = await Promise.all(
      [
        ctx.user.defaultAccountId === ''
          ? Promise.resolve([])
          : ctx.repos.trade
              .listByAccount(ctx.user.defaultAccountId)
              .then((items) =>
                items.filter(
                  (trade) =>
                    trade.stockId === stock.id && markerInRange(trade.executedAt, start, end),
                ),
              ),
        ctx.repos.advice.query({
          subjectKind: 'stock',
          subjectId: stock.id,
          includeExpired: true,
          limit: 200,
        }),
        ctx.repos.watchTrigger
          .listRecent({ limit: 10_000 })
          .then((items) => items.filter((trigger) => trigger.stockId === stock.id).slice(0, 200)),
        ctx.repos.strategyRun.signalsByStock(stock.id),
        ctx.repos.report.list({
          ...(ctx.user.defaultAccountId === ''
            ? {}
            : { scopeKey: `account:${ctx.user.defaultAccountId}` }),
          limit: 200,
        }),
        ctx.repos.researchIndex.listSubjectLinks({
          subjectKind: 'stock',
          subjectKey: stock.id,
        }),
        loadStockLimitUpFacts(stock.id, stock.code, input.date ?? currentLimitUpDate(ctx), ctx),
      ],
    );
    const markers = [
      ...trades.map((trade) => ({
        date: factDateKey(trade.executedAt),
        factKind: 'trade' as const,
        factId: trade.id,
        title: `交易 ${trade.side}`,
        href: `#holdings?stockId=${encodeURIComponent(stock.id)}`,
        tone: 'action' as const,
        at: trade.executedAt,
      })),
      ...advices
        .filter((advice) => markerInRange(advice.createdAt, start, end))
        .map((advice) => ({
          date: factDateKey(advice.createdAt),
          factKind: 'advice' as const,
          factId: advice.id,
          title: `Advice ${advice.decision}`,
          href: `#advice?stockId=${encodeURIComponent(stock.id)}`,
          tone: 'advice' as const,
          at: advice.createdAt,
        })),
      ...triggers
        .filter((trigger) => markerInRange(trigger.createdAt, start, end))
        .map((trigger) => ({
          date: factDateKey(trigger.createdAt),
          factKind: 'watch-trigger' as const,
          factId: trigger.id,
          title: trigger.reason,
          href: `#alerts?stockId=${encodeURIComponent(stock.id)}`,
          tone: 'fact' as const,
          at: trigger.createdAt,
        })),
      ...signals
        .filter((signal) => markerInRange(signal.ts, start, end))
        .map((signal) => ({
          date: factDateKey(signal.ts),
          factKind: 'strategy-signal' as const,
          factId: signal.id,
          title: `策略信号 ${signal.direction}`,
          href: `#strategies?stockId=${encodeURIComponent(stock.id)}`,
          tone: 'fact' as const,
          at: signal.ts,
        })),
      ...reports
        .filter(
          (report) =>
            reportStockIds(report).has(stock.id) &&
            markerInRange(new Date(`${report.periodEnd}T00:00:00.000Z`), start, end),
        )
        .map((report) => ({
          date: report.periodEnd,
          factKind: 'report' as const,
          factId: report.id,
          title: report.title,
          href: `#reports?stockId=${encodeURIComponent(stock.id)}`,
          tone: 'fact' as const,
          at: new Date(`${report.periodEnd}T00:00:00.000Z`),
        })),
      ...researchLinks
        .filter(
          (link) =>
            (link.ownerKind === 'topic' || link.ownerKind === 'document') &&
            markerInRange(now, start, end),
        )
        .map((link) => ({
          date: factDateKey(now),
          factKind: 'research' as const,
          factId: link.ownerId,
          title: `研究关联（${link.relation}）`,
          href: `#research?stockId=${encodeURIComponent(stock.id)}`,
          tone: 'fact' as const,
          at: now,
        })),
      ...limitUp.recent
        .filter((item) => markerInRange(new Date(`${item.date}T00:00:00.000Z`), start, end))
        .map((item) => ({
          date: item.date,
          factKind: 'limit-up' as const,
          factId: `${stock.id}:${item.date}`,
          title: `${item.ladderLevel} 连板${item.reason === '--' ? '' : ` · ${item.reason}`}`,
          href: `#market?stockId=${encodeURIComponent(stock.id)}&range=${encodeURIComponent(input.range)}&date=${encodeURIComponent(item.date)}`,
          tone: 'fact' as const,
          at: new Date(`${item.date}T00:00:00.000Z`),
        })),
    ]
      .sort((a, b) => a.at.getTime() - b.at.getTime() || a.factId.localeCompare(b.factId))
      .map(({ at: _at, ...marker }) => marker);

    return {
      stock: { id: stock.id, code: stock.code, name: stock.name, exchange: stock.exchange },
      quote: { quote, previousClose, change, changePct, amplitude },
      candles: outCandles,
      indicators,
      indicatorsAsOf: lastCandleDate,
      dataStatus: {
        freshness: status.freshness,
        retrieval: status.retrieval,
        quoteFetchedAt: quote.fetchedAt,
        barsAsOf: lastCandleDate,
        sources,
        marketSession: session,
        warnings: barsTruncated ? [...status.warnings, 'bars-truncated' as const] : status.warnings,
      },
      markers,
      limitUp,
    };
  },
});
