import {
  dateInShanghai,
  ExchangeSchema,
  type MinuteBar,
  MoneySchema,
  money,
  QuoteSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errAdapterError, errNotFound } from '../define-tool.js';
import { ensureStockStub, STOCK_ID_PATTERN } from '../internal/manual-entry.js';
import { deriveOpenGap } from '../internal/market-view.js';

export const GetIntradaySummaryInput = z.object({
  stockId: z.string().trim().min(1),
  stockName: z.string().trim().min(1).max(100).optional(),
});

const PointSchema = z.object({
  price: MoneySchema,
  at: z.coerce.date(),
});

export const GetIntradaySummaryOutput = z.object({
  stock: z.object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    exchange: ExchangeSchema,
  }),
  supported: z.boolean(),
  date: z.string().nullable(),
  pointsCount: z.number().int().nonnegative(),
  open: PointSchema.nullable(),
  previousClose: MoneySchema.nullable(),
  openGapPct: z.number().nullable(),
  openVsPrevClose: z.enum(['high', 'low', 'flat']).nullable(),
  high: PointSchema.nullable(),
  low: PointSchema.nullable(),
  latest: PointSchema.nullable(),
  /** 当日 VWAP（Σ成交额 / Σ成交量）；分钟数据没有成交额时为 null。 */
  vwap: MoneySchema.nullable(),
  changePct: z.number().nullable(),
  sources: z.array(z.string().min(1)),
  warnings: z.array(
    z.enum([
      'provider-error',
      'unsupported-capability',
      'no-intraday-points',
      'previous-close-unavailable',
    ]),
  ),
});

type IntradaySummaryWarning = z.infer<typeof GetIntradaySummaryOutput>['warnings'][number];

const latestDateBars = (bars: readonly MinuteBar[]): MinuteBar[] => {
  const latestDate = bars.reduce<string | null>((latest, bar) => {
    const date = dateInShanghai(bar.endedAt);
    return latest === null || date > latest ? date : latest;
  }, null);
  if (latestDate === null) return [];
  return bars.filter((bar) => dateInShanghai(bar.endedAt) === latestDate);
};

const extreme = (
  bars: readonly MinuteBar[],
  pick: (candidate: MinuteBar, current: MinuteBar) => boolean,
): MinuteBar | undefined => {
  let result: MinuteBar | undefined;
  for (const bar of bars) {
    if (result === undefined || pick(bar, result)) result = bar;
  }
  return result;
};

/**
 * get_intraday_summary（read，2026-11-23 深度试用 M3）。
 * 复用分钟 OHLCV 能力，只返回开盘 / 昨收 / 缺口 / 高低点时间 / 最新价 / VWAP 摘要，
 * 不落库、不回传全部分时点；无分时能力时如实返回 supported=false 或快照事实。
 */
export const getIntradaySummaryTool = defineTool({
  name: 'get_intraday_summary',
  description:
    '获取当日分时摘要：开盘、昨收、开盘缺口、最高/最低及时间、最新价与 VWAP；不返回全部分时点',
  sideEffect: 'external',
  input: GetIntradaySummaryInput,
  output: GetIntradaySummaryOutput,
  handler: async (input, ctx) => {
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

    const warnings = new Set<IntradaySummaryWarning>();
    const market = ctx.adapters.market;
    let bars: MinuteBar[] = [];
    let supported = true;
    try {
      bars = [...(await market.fetchMinuteBars(stock.id, '1m'))];
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      if (cause.includes('unsupported_capability')) {
        supported = false;
        warnings.add('unsupported-capability');
      } else {
        warnings.add('provider-error');
        ctx.logger.warn('get_intraday_summary: 分时拉取失败', {
          stockId: stock.id,
          error: cause,
        });
      }
    }

    let quote: z.infer<typeof QuoteSchema> | undefined;
    try {
      quote = QuoteSchema.parse(await market.fetchQuote(stock.id, { requireDetails: true }));
    } catch (error) {
      ctx.logger.warn('get_intraday_summary: 快照拉取失败，仅用分时与本地日线', {
        stockId: stock.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const today = dateInShanghai(ctx.clock());
    const todayBars = latestDateBars(bars);
    if (todayBars.length === 0 && quote === undefined) {
      return errAdapterError(market.name, 'intraday_and_quote_unavailable', true);
    }
    if (todayBars.length === 0) warnings.add('no-intraday-points');

    const quoteAt = quote?.observedAt ?? quote?.ts ?? ctx.clock();
    const first = todayBars[0];
    const last = todayBars.at(-1);
    const high = extreme(todayBars, (candidate, current) => candidate.high > current.high);
    const low = extreme(todayBars, (candidate, current) => candidate.low < current.low);
    const sourceDate = first === undefined ? today : dateInShanghai(first.endedAt);
    const open = first === undefined ? undefined : { price: first.open, at: first.endedAt };
    const latest =
      last === undefined
        ? quote === undefined
          ? undefined
          : { price: quote.close, at: quoteAt }
        : { price: last.close, at: last.endedAt };
    const resolvedOpen =
      open ?? (quote === undefined ? undefined : { price: quote.open, at: quoteAt });
    const resolvedHigh =
      high === undefined
        ? quote === undefined
          ? undefined
          : { price: quote.high, at: quoteAt }
        : { price: high.high, at: high.endedAt };
    const resolvedLow =
      low === undefined
        ? quote === undefined
          ? undefined
          : { price: quote.low, at: quoteAt }
        : { price: low.low, at: low.endedAt };

    let previousClose = quote?.prevClose;
    if (previousClose === undefined) {
      const sessionStart = new Date(`${sourceDate}T00:00:00.000Z`);
      const recent = await ctx.repos.dailyBar.latestBefore(stock.id, ctx.clock(), 5);
      previousClose = recent
        .filter((bar) => bar.date.getTime() < sessionStart.getTime())
        .at(-1)?.close;
    }
    if (previousClose === undefined) warnings.add('previous-close-unavailable');

    const openGap =
      resolvedOpen === undefined ? null : deriveOpenGap(resolvedOpen.price, previousClose ?? null);
    const changePct =
      latest === undefined || previousClose === undefined || previousClose <= 0
        ? null
        : money(((latest.price - previousClose) / previousClose) * 100);
    const amountCovered =
      todayBars.length > 0 && todayBars.every((bar) => bar.amount !== undefined);
    const totalVolume = todayBars.reduce((sum, bar) => sum + bar.volume, 0);
    const totalAmount = todayBars.reduce((sum, bar) => sum + (bar.amount ?? 0), 0);
    const vwap = amountCovered && totalVolume > 0 ? money(totalAmount / totalVolume) : null;

    return {
      stock: {
        id: stock.id,
        code: stock.code,
        name: stock.name,
        exchange: stock.exchange,
      },
      supported,
      date: todayBars.length === 0 ? null : sourceDate,
      pointsCount: todayBars.length,
      open: resolvedOpen ?? null,
      previousClose: previousClose ?? null,
      openGapPct: openGap?.openGapPct ?? null,
      openVsPrevClose: openGap?.openVsPrevClose ?? null,
      high: resolvedHigh ?? null,
      low: resolvedLow ?? null,
      latest: latest ?? null,
      vwap,
      changePct,
      sources: [...new Set(todayBars.map((bar) => bar.source))],
      warnings: [...warnings],
    };
  },
});
