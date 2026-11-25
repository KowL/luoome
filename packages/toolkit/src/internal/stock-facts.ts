import { createHash } from 'node:crypto';
import {
  AccountFactsSchema,
  type DailyBar,
  DailyBarSchema,
  dateInShanghai,
  type IndexQuote,
  IndexQuoteSchema,
  type IntradayMinute,
  type NewsList,
  NewsListSchema,
  PluginExecutionDenied,
  type Quote,
  QuoteSchema,
  SectorQuoteItemSchema,
  type SectorQuoteList,
  SectorQuoteListSchema,
  type Stock,
  type StockBriefMissing,
  type StockBriefMissingDimension,
  StockSectorMembershipViewSchema,
  type StrategySignal,
  StrategySignalSchema,
  summarizeIndicatorAvailability,
  TechnicalIndicatorsSchema,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { deriveAccountFacts } from '../tools/account-facts.js';
import { computeSimpleIndicators } from './indicators.js';
import { resolveQuote } from './resolve-quotes.js';
import { readStrategySignalsByStock } from './strategy-signal-scope.js';

/** 开盘相对昨收的方向；平开区间用于吸收集合竞价的最小噪声。 */
export type OpenDirection = 'low' | 'flat' | 'high';

export interface OpeningFact {
  readonly open: number;
  readonly prevClose: number;
  readonly openChangePct: number;
  readonly direction: OpenDirection;
  readonly label: '低开' | '平开' | '高开';
}

export type OpeningFactResult =
  | { readonly status: 'ok'; readonly data: OpeningFact }
  | { readonly status: 'unavailable'; readonly reason: string };

/** |openChangePct| 不超过该值视为平开。 */
export const OPEN_FLAT_TOLERANCE_PCT = 0.1;

/**
 * 开盘方向只能由 open 与上一交易日收盘价派生。
 * 缺 prevClose 时保持 unavailable，不用当日 open 顶替昨收（CONTEXT.md 口径）。
 */
export const deriveOpeningFact = (quote: Pick<Quote, 'open' | 'prevClose'>): OpeningFactResult => {
  const prevClose = quote.prevClose;
  if (prevClose === undefined || !Number.isFinite(prevClose) || prevClose <= 0) {
    return { status: 'unavailable', reason: '缺少上一交易日收盘价，无法判断开盘方向' };
  }
  const open = quote.open;
  if (!Number.isFinite(open) || open <= 0) {
    return { status: 'unavailable', reason: '开盘价不可用，无法判断开盘方向' };
  }
  const openChangePct = ((open - prevClose) / prevClose) * 100;
  const direction: OpenDirection =
    Math.abs(openChangePct) <= OPEN_FLAT_TOLERANCE_PCT
      ? 'flat'
      : openChangePct < 0
        ? 'low'
        : 'high';
  return {
    status: 'ok',
    data: {
      open,
      prevClose,
      openChangePct,
      direction,
      label: direction === 'flat' ? '平开' : direction === 'low' ? '低开' : '高开',
    },
  };
};

// ---------- 事实包（design.md §6.1） ----------

export const OPENING_FACT_SCHEMA = z.object({
  open: z.number().positive(),
  prevClose: z.number().positive(),
  openChangePct: z.number().finite(),
  direction: z.enum(['low', 'flat', 'high']),
  label: z.enum(['低开', '平开', '高开']),
});

const FACT_SECTION_NAMES = [
  'quote',
  'bars',
  'indicators',
  'intraday',
  'news',
  'sectors',
  'sectorQuote',
  'signals',
  'account',
  'market',
] as const;
export const StockFactSectionSchema = z.enum(FACT_SECTION_NAMES);
export type StockFactSection = z.infer<typeof StockFactSectionSchema>;

const buildFactSectionSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.discriminatedUnion('status', [
    z.object({
      status: z.literal('ok'),
      data,
      dataAsOf: z.coerce.date(),
      source: z.string().min(1),
    }),
    z.object({
      status: z.literal('unavailable'),
      reason: z.string().min(1),
      dataAsOf: z.coerce.date().optional(),
      source: z.string().min(1).optional(),
    }),
  ]);

export const StockIdentitySchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
  exchange: z.string().min(1),
});

export const QuoteFactDataSchema = z.object({
  quote: QuoteSchema,
  opening: OPENING_FACT_SCHEMA,
  retrieval: z.enum(['live', 'local-fallback']),
  freshness: z.enum(['fresh', 'stale']),
});

export const BarsFactDataSchema = z.object({
  requiredCount: z.number().int().positive(),
  actualCount: z.number().int().nonnegative(),
  bars: z.array(DailyBarSchema),
});

export const IndicatorsFactDataSchema = z.object({
  values: TechnicalIndicatorsSchema,
  availableFields: z.array(z.string().min(1)),
  missingFields: z.array(z.string().min(1)),
  requiredCount: z.number().int().positive(),
  actualCount: z.number().int().nonnegative(),
});

export const IntradayFactDataSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  points: z.array(
    z.object({
      time: z.coerce.date(),
      price: z.number().positive(),
      cumVolume: z.number().nonnegative(),
      cumAmount: z.number().nonnegative().optional(),
      source: z.string().min(1),
    }),
  ),
  sources: z.array(z.string().min(1)),
});

export const SectorsFactDataSchema = z.object({
  memberships: z.array(StockSectorMembershipViewSchema),
});

export const SectorQuoteFactDataSchema = z.object({
  list: SectorQuoteListSchema,
  matched: z.array(SectorQuoteItemSchema),
});

export const SignalsFactDataSchema = z.object({
  since: z.coerce.date(),
  items: z.array(StrategySignalSchema),
});

export const AccountFactDataSchema = z.object({ facts: AccountFactsSchema });

export const MarketFactDataSchema = z.object({
  indices: z.array(IndexQuoteSchema),
});

export const StockFactPackSchema = z.object({
  stock: StockIdentitySchema,
  quote: buildFactSectionSchema(QuoteFactDataSchema).optional(),
  bars: buildFactSectionSchema(BarsFactDataSchema).optional(),
  indicators: buildFactSectionSchema(IndicatorsFactDataSchema).optional(),
  intraday: buildFactSectionSchema(IntradayFactDataSchema).optional(),
  news: buildFactSectionSchema(NewsListSchema).optional(),
  sectors: buildFactSectionSchema(SectorsFactDataSchema).optional(),
  sectorQuote: buildFactSectionSchema(SectorQuoteFactDataSchema).optional(),
  signals: buildFactSectionSchema(SignalsFactDataSchema).optional(),
  account: buildFactSectionSchema(AccountFactDataSchema).optional(),
  market: buildFactSectionSchema(MarketFactDataSchema).optional(),
  factDigest: z.string().min(16),
});
export type StockFactPack = z.infer<typeof StockFactPackSchema>;

/** 日线完整口径（design.md §6.1：≥120 交易日才算完整）。 */
export const REQUIRED_DAILY_BAR_COUNT = 120;
/** 少于该根数时整段日线 unavailable，不拿 3~4 根拼指标。 */
export const MIN_DAILY_BAR_COUNT = 20;
export const MACD_MIN_BARS = 35;
export const MA60_MIN_BARS = 60;
export const CROSSING_MIN_BARS = 120;

const DAY_MS = 86_400_000;
const DAILY_BAR_FETCH_LOOKBACK_DAYS = 400;
const SIGNAL_LOOKBACK_DAYS = 30;

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const ok = <T>(data: T, dataAsOf: Date, source: string) =>
  ({ status: 'ok' as const, data, dataAsOf, source }) as {
    status: 'ok';
    data: T;
    dataAsOf: Date;
    source: string;
  };
const unavailable = (reason: string, source?: string, dataAsOf?: Date) => ({
  status: 'unavailable' as const,
  reason,
  ...(source === undefined ? {} : { source }),
  ...(dataAsOf === undefined ? {} : { dataAsOf }),
});

const uniqueSources = (sources: readonly string[]): string =>
  [...new Set(sources.filter((source) => source.trim().length > 0))].join(',');

const barDateKey = (bar: DailyBar): string => dateInShanghai(bar.date);

/** 本地 + 远端日线按交易日去重合并；远端补齐的同一根 K 线优先。 */
const mergeBars = (local: readonly DailyBar[], fetched: readonly DailyBar[]): DailyBar[] => {
  const byDate = new Map<string, DailyBar>();
  for (const bar of local) byDate.set(barDateKey(bar), bar);
  for (const bar of fetched) byDate.set(barDateKey(bar), bar);
  return [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, bar]) => bar)
    .slice(-REQUIRED_DAILY_BAR_COUNT);
};

/** 门禁必须在事实包（computeSimpleIndicators 只要 closes>=2 就会算 MACD）。 */
const gateIndicators = (barsCount: number, values: Record<string, number | undefined>) => {
  const gated = { ...values };
  if (barsCount < MACD_MIN_BARS) {
    delete gated.macdDif;
    delete gated.macdDea;
    delete gated.macdHist;
  }
  if (barsCount < MA60_MIN_BARS) {
    delete gated.ma60;
    delete gated.maDistance60Pct;
  }
  if (barsCount < CROSSING_MIN_BARS) {
    delete gated.daysSinceMa20CrossUp;
    delete gated.daysSinceMa60CrossUp;
  }
  return gated;
};

const loadDailyBars = async (
  ctx: ToolContext,
  stock: Stock,
  asOf: Date,
): Promise<{ bars: DailyBar[]; reason?: string }> => {
  let local: readonly DailyBar[] = [];
  try {
    local = await ctx.repos.dailyBar.latestBefore(stock.id, asOf, REQUIRED_DAILY_BAR_COUNT);
  } catch (error) {
    ctx.logger.warn('stock-facts: 本地日线读取失败', {
      stockId: stock.id,
      error: errorText(error),
    });
  }
  if (local.length >= REQUIRED_DAILY_BAR_COUNT) return { bars: [...local] };
  try {
    const fetched = await ctx.adapters.market.fetchDailyBars(stock.id, {
      start: new Date(asOf.getTime() - DAILY_BAR_FETCH_LOOKBACK_DAYS * DAY_MS),
      end: asOf,
    });
    const bars = mergeBars(local, fetched);
    return bars.length >= local.length ? { bars } : { bars: [...local] };
  } catch (error) {
    if (error instanceof PluginExecutionDenied) throw error;
    ctx.logger.warn('stock-facts: 远端日线拉取失败，使用本地缓存', {
      stockId: stock.id,
      error: errorText(error),
    });
    return { bars: [...local], reason: errorText(error) };
  }
};

/**
 * 提示词里保留的日线条数与分时点数（design.md §6.3）：完整 bars 数组不进提示词。
 */
export const PROMPT_RECENT_BAR_COUNT = 20;
export const PROMPT_INTRADAY_POINT_COUNT = 30;
export const PROMPT_NEWS_COUNT = 5;
export const PROMPT_SIGNAL_COUNT = 5;

export interface PromptBarSummary {
  readonly date: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export type PromptSection<T> =
  | {
      readonly status: 'ok';
      readonly data: T;
      readonly dataAsOf: Date;
      readonly source: string;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: string;
      readonly dataAsOf?: Date | undefined;
      readonly source?: string | undefined;
    };

/**
 * 事实包 → 提示词投影（design.md §6.3）：只留最近 20 根日线摘要、指标可用集合、
 * 开盘方向与逐维降级原因，避免把整段 bars / 分时原始点塞进提示词。
 */
export interface StockFactPromptProjection {
  readonly factDigest: string;
  readonly stock: z.infer<typeof StockIdentitySchema>;
  readonly quote?: PromptSection<z.infer<typeof QuoteFactDataSchema>>;
  readonly bars?: PromptSection<{
    readonly requiredCount: number;
    readonly actualCount: number;
    readonly recent: readonly PromptBarSummary[];
  }>;
  readonly indicators?: PromptSection<z.infer<typeof IndicatorsFactDataSchema>>;
  readonly intraday?: PromptSection<{
    readonly date: string;
    readonly pointCount: number;
    readonly recent: readonly { readonly time: Date; readonly price: number }[];
  }>;
  readonly news?: PromptSection<{
    readonly items: readonly {
      readonly title: string;
      readonly summary: string;
      readonly source: string;
      readonly publishedAt: string;
    }[];
  }>;
  readonly sectors?: PromptSection<{
    readonly memberships: readonly {
      readonly kind: string;
      readonly name: string;
      readonly sectorState: string;
    }[];
  }>;
  readonly sectorQuote?: PromptSection<{
    readonly matched: readonly {
      readonly name: string;
      readonly changePct: number;
      readonly upCount?: number;
      readonly downCount?: number;
    }[];
  }>;
  readonly signals?: PromptSection<{
    readonly since: Date;
    readonly items: readonly {
      readonly ts: Date;
      readonly ruleId: string;
      readonly direction: string;
      readonly score: number;
    }[];
  }>;
  readonly account?: PromptSection<{
    readonly facts: {
      readonly status: string;
      readonly cashBalance: number;
      readonly totalAssets: number | null;
      readonly reasons: readonly string[];
      readonly positions: readonly {
        readonly stockId: string;
        readonly quantity: number;
        readonly marketValue: number;
      }[];
    };
  }>;
  readonly market?: PromptSection<{
    readonly indices: readonly {
      readonly code: string;
      readonly name: string;
      readonly close: number;
      readonly changePct: number;
    }[];
  }>;
}

const keepUnavailable = <T>(section: PromptSection<T>): PromptSection<T> => section;
export const projectStockFactPackForPrompt = (pack: StockFactPack): StockFactPromptProjection => {
  const bars = pack.bars;
  const intraday = pack.intraday;
  const news = pack.news;
  const sectors = pack.sectors;
  const sectorQuote = pack.sectorQuote;
  const signals = pack.signals;
  const account = pack.account;
  const market = pack.market;
  return {
    factDigest: pack.factDigest,
    stock: pack.stock,
    ...(pack.quote === undefined ? {} : { quote: keepUnavailable(pack.quote) }),
    ...(bars === undefined
      ? {}
      : {
          bars:
            bars.status === 'ok'
              ? {
                  status: 'ok' as const,
                  dataAsOf: bars.dataAsOf,
                  source: bars.source,
                  data: {
                    requiredCount: bars.data.requiredCount,
                    actualCount: bars.data.actualCount,
                    recent: bars.data.bars.slice(-PROMPT_RECENT_BAR_COUNT).map((bar) => ({
                      date: dateInShanghai(bar.date),
                      open: bar.open,
                      high: bar.high,
                      low: bar.low,
                      close: bar.close,
                      volume: bar.volume,
                    })),
                  },
                }
              : keepUnavailable(bars),
        }),
    ...(pack.indicators === undefined ? {} : { indicators: pack.indicators }),
    ...(intraday === undefined
      ? {}
      : {
          intraday:
            intraday.status === 'ok'
              ? {
                  status: 'ok' as const,
                  dataAsOf: intraday.dataAsOf,
                  source: intraday.source,
                  data: {
                    date: intraday.data.date,
                    pointCount: intraday.data.points.length,
                    recent: intraday.data.points
                      .slice(-PROMPT_INTRADAY_POINT_COUNT)
                      .map((point) => ({
                        time: point.time,
                        price: point.price,
                      })),
                  },
                }
              : keepUnavailable(intraday),
        }),
    ...(news === undefined
      ? {}
      : {
          news:
            news.status === 'ok'
              ? {
                  status: 'ok' as const,
                  dataAsOf: news.dataAsOf,
                  source: news.source,
                  data: {
                    items: news.data.items.slice(0, PROMPT_NEWS_COUNT).map((item) => ({
                      title: item.title,
                      summary: item.summary,
                      source: item.source,
                      publishedAt: item.publishedAt.toISOString(),
                    })),
                  },
                }
              : keepUnavailable(news),
        }),
    ...(sectors === undefined
      ? {}
      : {
          sectors:
            sectors.status === 'ok'
              ? {
                  status: 'ok' as const,
                  dataAsOf: sectors.dataAsOf,
                  source: sectors.source,
                  data: {
                    memberships: sectors.data.memberships.map((item) => ({
                      kind: item.kind,
                      name: item.name,
                      sectorState: item.sectorState,
                    })),
                  },
                }
              : keepUnavailable(sectors),
        }),
    ...(sectorQuote === undefined
      ? {}
      : {
          sectorQuote:
            sectorQuote.status === 'ok'
              ? {
                  status: 'ok' as const,
                  dataAsOf: sectorQuote.dataAsOf,
                  source: sectorQuote.source,
                  data: {
                    matched: sectorQuote.data.matched.map((item) => ({
                      name: item.name,
                      changePct: item.changePct,
                      ...(item.upCount === undefined ? {} : { upCount: item.upCount }),
                      ...(item.downCount === undefined ? {} : { downCount: item.downCount }),
                    })),
                  },
                }
              : keepUnavailable(sectorQuote),
        }),
    ...(signals === undefined
      ? {}
      : {
          signals:
            signals.status === 'ok'
              ? {
                  status: 'ok' as const,
                  dataAsOf: signals.dataAsOf,
                  source: signals.source,
                  data: {
                    since: signals.data.since,
                    items: [...signals.data.items]
                      .sort((left, right) => right.ts.getTime() - left.ts.getTime())
                      .slice(0, PROMPT_SIGNAL_COUNT)
                      .map((item) => ({
                        ts: item.ts,
                        ruleId: item.ruleId,
                        direction: item.direction,
                        score: item.score,
                      })),
                  },
                }
              : keepUnavailable(signals),
        }),
    ...(account === undefined
      ? {}
      : {
          account:
            account.status === 'ok'
              ? {
                  status: 'ok' as const,
                  dataAsOf: account.dataAsOf,
                  source: account.source,
                  data: {
                    facts: {
                      status: account.data.facts.status,
                      cashBalance: account.data.facts.cashBalance,
                      totalAssets: account.data.facts.totalAssets ?? null,
                      reasons: account.data.facts.reasons,
                      positions: account.data.facts.positions.map((position) => ({
                        stockId: position.stockId,
                        quantity: position.quantity,
                        marketValue: position.marketValue,
                      })),
                    },
                  },
                }
              : keepUnavailable(account),
        }),
    ...(market === undefined
      ? {}
      : {
          market:
            market.status === 'ok'
              ? {
                  status: 'ok' as const,
                  dataAsOf: market.dataAsOf,
                  source: market.source,
                  data: {
                    indices: market.data.indices.map((item) => ({
                      code: item.code,
                      name: item.name,
                      close: item.close,
                      changePct: item.changePct,
                    })),
                  },
                }
              : keepUnavailable(market),
        }),
  };
};

export interface FactPackBriefSummary {
  readonly factDigest: string;
  readonly quoteAvailable: boolean;
  readonly barsAvailable: boolean;
  readonly missing: readonly StockBriefMissing[];
  readonly dataSources: readonly string[];
  /** 各段最晚的 dataAsOf；无可用段时回退到调用时钟。 */
  readonly factsAsOf: Date;
}

const SECTION_MISSING_DIMENSION: Readonly<
  Partial<Record<keyof StockFactPack, StockBriefMissingDimension>>
> = {
  quote: 'quote',
  bars: 'daily-bars',
  intraday: 'intraday',
  news: 'news',
  sectors: 'sector-membership',
  sectorQuote: 'sector-quote',
  signals: 'signals',
  account: 'account',
};

/**
 * 事实包 → stock_briefs 的降级维度 / 数据来源 / factsAsOf。
 * 任何 unavailable 段都必须带 dimension + reason（design.md §11）。
 */
export const summarizeFactPackForBrief = (
  pack: StockFactPack,
  fallbackAsOf: Date,
): FactPackBriefSummary => {
  const missing: StockBriefMissing[] = [];
  const dataSources = new Set<string>();
  let factsAsOf: Date | undefined;
  for (const [key, dimension] of Object.entries(SECTION_MISSING_DIMENSION)) {
    const section = pack[key as keyof StockFactPack];
    if (section === undefined || typeof section !== 'object') continue;
    if (!('status' in section)) continue;
    if (section.status === 'unavailable') {
      missing.push({
        dimension: dimension as StockBriefMissingDimension,
        reason: section.reason,
        ...(section.source === undefined ? {} : { source: section.source }),
        ...(section.dataAsOf === undefined ? {} : { dataAsOf: section.dataAsOf }),
      });
      continue;
    }
    if (section.source !== undefined) {
      for (const source of section.source.split(',')) {
        if (source.trim().length > 0) dataSources.add(source.trim());
      }
    }
    // 只取各段自己的事实时间：陈旧快照的 dataAsOf 必须留在过去，不能被调用时钟抬到当下。
    if (
      section.dataAsOf !== undefined &&
      (factsAsOf === undefined || section.dataAsOf > factsAsOf)
    ) {
      factsAsOf = section.dataAsOf;
    }
  }
  return {
    factDigest: pack.factDigest,
    quoteAvailable: pack.quote?.status === 'ok',
    barsAvailable: pack.bars?.status === 'ok',
    missing,
    dataSources: [...dataSources],
    factsAsOf: factsAsOf ?? fallbackAsOf,
  };
};

// 只把事实值纳入指纹；抓取 / 计算时间与新鲜度会随调用时钟变化，不参与幂等判断。
const VOLATILE_KEYS = new Set([
  'asOf',
  'dataAsOf',
  'fetchedAt',
  'freshness',
  'retrieval',
  'retrievedAt',
  'updatedAt',
]);

const canonicalize = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (VOLATILE_KEYS.has(key)) continue;
      const item = source[key];
      if (item === undefined) continue;
      out[key] = canonicalize(item);
    }
    return out;
  }
  return value;
};

/** 稳定指纹：键排序、排除抓取时钟；改价格或增减一根 K 线都会变。 */
export const computeStockFactDigest = (
  pack: Omit<StockFactPack, 'factDigest'> | StockFactPack,
): string =>
  createHash('sha256')
    .update(JSON.stringify(canonicalize(pack)))
    .digest('hex');

export interface BuildStockFactPackInput {
  readonly stockId: string;
  readonly asOf?: Date;
  readonly include?: readonly StockFactSection[];
  readonly accountId?: string;
}

/**
 * 组装十段事实包。每段只返回 ok（带 dataAsOf + source）或 unavailable（带 reason），
 * 不用空数组冒充可用；分时只走 intraday-minutes，不推断形态。
 */
export const buildStockFactPack = async (
  ctx: ToolContext,
  input: BuildStockFactPackInput,
): Promise<StockFactPack | null> => {
  const normalized = input.stockId.trim().toUpperCase();
  const stock =
    (await ctx.repos.stock.findById(normalized)) ?? (await ctx.repos.stock.findByCode(normalized));
  if (stock === null) return null;

  const asOf = input.asOf ?? ctx.clock();
  const wanted = (section: StockFactSection): boolean =>
    input.include === undefined || input.include.includes(section);
  const stockIdentity = {
    id: stock.id,
    code: stock.code,
    name: stock.name,
    exchange: stock.exchange,
  };

  let quote: StockFactPack['quote'];
  if (wanted('quote')) {
    const item = await resolveQuote(ctx, stock.id, { context: 'display' });
    if (item === undefined || item.status !== 'ok') {
      quote = unavailable(
        item !== undefined && item.status === 'unavailable' ? item.reason : 'quote_unavailable',
      );
    } else {
      const opening = deriveOpeningFact(item.quote);
      quote =
        opening.status === 'ok'
          ? ok(
              {
                quote: item.quote,
                opening: opening.data,
                retrieval: item.retrieval,
                freshness: item.freshness,
              },
              item.quote.observedAt,
              item.quote.source,
            )
          : unavailable(opening.reason, item.quote.source, item.quote.observedAt);
    }
  }

  const loadedBars =
    wanted('bars') || wanted('indicators') ? await loadDailyBars(ctx, stock, asOf) : null;
  let bars: StockFactPack['bars'];
  if (wanted('bars')) {
    if (loadedBars === null || loadedBars.bars.length < MIN_DAILY_BAR_COUNT) {
      const actualCount = loadedBars?.bars.length ?? 0;
      bars = unavailable(
        `日线仅 ${actualCount} 根，少于最低 ${MIN_DAILY_BAR_COUNT} 根（requiredCount=${REQUIRED_DAILY_BAR_COUNT}，actualCount=${actualCount}）${loadedBars?.reason === undefined ? '' : `：${loadedBars.reason}`}`,
        'daily-bars',
      );
    } else {
      const data = {
        requiredCount: REQUIRED_DAILY_BAR_COUNT,
        actualCount: loadedBars.bars.length,
        bars: loadedBars.bars,
      };
      const last = loadedBars.bars.at(-1);
      bars = ok(data, last?.date ?? asOf, uniqueSources(loadedBars.bars.map((bar) => bar.source)));
    }
  }

  let indicators: StockFactPack['indicators'];
  if (wanted('indicators')) {
    if (loadedBars === null || loadedBars.bars.length < MIN_DAILY_BAR_COUNT) {
      const actualCount = loadedBars?.bars.length ?? 0;
      indicators = unavailable(
        `日线不足 ${MIN_DAILY_BAR_COUNT} 根，无法计算指标（requiredCount=${REQUIRED_DAILY_BAR_COUNT}，actualCount=${actualCount}）`,
        'daily-bars',
      );
    } else {
      const values = gateIndicators(
        loadedBars.bars.length,
        computeSimpleIndicators(loadedBars.bars),
      );
      const availability = summarizeIndicatorAvailability(values, loadedBars.bars.length);
      const data = {
        values,
        availableFields: availability.available,
        missingFields: availability.unavailable.map((item) => item.indicator),
        requiredCount: REQUIRED_DAILY_BAR_COUNT,
        actualCount: loadedBars.bars.length,
      };
      const last = loadedBars.bars.at(-1);
      indicators = ok(
        data,
        last?.date ?? asOf,
        uniqueSources(loadedBars.bars.map((bar) => bar.source)),
      );
    }
  }

  let intraday: StockFactPack['intraday'];
  if (wanted('intraday')) {
    try {
      const points = await ctx.adapters.market.fetchIntradayMinutes(stock.id);
      const last = points.at(-1);
      if (points.length === 0 || last === undefined) {
        intraday = unavailable(
          '当日暂无分时点（盘前、非交易日或数据源返回空）',
          'intraday-minutes',
        );
      } else {
        intraday = ok(
          {
            date: dateInShanghai(last.time),
            points: points.map((point: IntradayMinute) => ({
              time: point.time,
              price: point.price,
              cumVolume: point.cumVolume,
              ...(point.cumAmount === undefined ? {} : { cumAmount: point.cumAmount }),
              source: point.source,
            })),
            sources: [...new Set(points.map((point) => point.source))],
          },
          last.time,
          uniqueSources(points.map((point) => point.source)),
        );
      }
    } catch (error) {
      if (error instanceof PluginExecutionDenied) throw error;
      const cause = errorText(error);
      intraday = unavailable(
        cause.includes('unsupported_capability')
          ? '当前数据源未注册分时能力'
          : `分时拉取失败：${cause}`,
        'intraday-minutes',
      );
    }
  }

  let news: StockFactPack['news'];
  if (wanted('news')) {
    const manager = ctx.adapters.marketIntel?.news;
    if (manager === undefined) {
      news = unavailable('未配置新闻数据源（marketIntel.news）', 'news');
    } else {
      try {
        const result = await manager.fetchNews({ page: 1, limit: 10 });
        if (!result.ok || result.data === undefined) {
          news = unavailable(result.error?.message ?? '新闻数据源不可用', 'news');
        } else {
          const list: NewsList = result.data;
          news = ok(list, list.asOf, list.source);
        }
      } catch (error) {
        news = unavailable(`新闻拉取失败：${errorText(error)}`, 'news');
      }
    }
  }

  let sectors: StockFactPack['sectors'];
  if (wanted('sectors')) {
    try {
      const memberships = await ctx.repos.sectorCatalog.listByStock({
        stockIds: [stock.id],
        includeMissing: false,
      });
      if (memberships.length === 0) {
        sectors = unavailable(
          '板块归属数据源（fuyao sector-catalog）未配置或未同步，无法判断板块归属',
          'sector-catalog',
        );
      } else {
        const latest = memberships.reduce(
          (max, item) => (item.lastSeenAt > max ? item.lastSeenAt : max),
          memberships[0]?.lastSeenAt ?? asOf,
        );
        sectors = ok({ memberships: [...memberships] }, latest, 'sector-catalog');
      }
    } catch (error) {
      sectors = unavailable(`板块归属读取失败：${errorText(error)}`, 'sector-catalog');
    }
  }

  let sectorQuote: StockFactPack['sectorQuote'];
  if (wanted('sectorQuote')) {
    const manager = ctx.adapters.marketIntel?.sectorQuote;
    if (manager === undefined) {
      sectorQuote = unavailable('未配置板块行情数据源（marketIntel.sectorQuote）', 'sector-quote');
    } else {
      try {
        const result: { ok?: boolean; data?: SectorQuoteList; error?: { message?: string } } =
          await manager.fetchList({ sort: 'changePct', limit: 50 });
        if (!result.ok || result.data === undefined) {
          sectorQuote = unavailable(
            result.error?.message ?? '板块行情数据源不可用',
            'sector-quote',
          );
        } else if (result.data.items.length === 0) {
          sectorQuote = unavailable('板块行情返回空列表', 'sector-quote', result.data.asOf);
        } else {
          const membershipIds = new Set(
            sectors?.status === 'ok' ? sectors.data.memberships.map((item) => item.vendorCode) : [],
          );
          const membershipNames = new Set(
            sectors?.status === 'ok' ? sectors.data.memberships.map((item) => item.name) : [],
          );
          const matched = result.data.items.filter(
            (item) => membershipIds.has(item.code) || membershipNames.has(item.name),
          );
          sectorQuote = ok({ list: result.data, matched }, result.data.asOf, result.data.source);
        }
      } catch (error) {
        sectorQuote = unavailable(`板块行情拉取失败：${errorText(error)}`, 'sector-quote');
      }
    }
  }

  let signals: StockFactPack['signals'];
  if (wanted('signals')) {
    const since = new Date(asOf.getTime() - SIGNAL_LOOKBACK_DAYS * DAY_MS);
    try {
      const items: StrategySignal[] = await readStrategySignalsByStock(ctx, {
        stockId: stock.id,
        since,
        scope: 'operational',
      });
      const latest = items.reduce(
        (max, item) => (item.ts > max ? item.ts : max),
        items[0]?.ts ?? asOf,
      );
      signals = ok({ since, items }, latest, 'strategy-run');
    } catch (error) {
      signals = unavailable(`策略信号读取失败：${errorText(error)}`, 'strategy-run');
    }
  }

  let account: StockFactPack['account'];
  if (wanted('account')) {
    try {
      const facts = await deriveAccountFacts(ctx, input.accountId);
      if (facts === null) {
        account = unavailable('账户不存在，无法提供仓位事实', 'local-ledger');
      } else if (facts.status === 'unavailable') {
        account = unavailable(
          facts.reasons.join('；') || '账户事实不可用',
          'local-ledger',
          facts.asOf,
        );
      } else {
        account = ok({ facts }, facts.asOf, 'local-ledger');
      }
    } catch (error) {
      account = unavailable(`账户事实读取失败：${errorText(error)}`, 'local-ledger');
    }
  }

  let market: StockFactPack['market'];
  if (wanted('market')) {
    try {
      const indices: readonly IndexQuote[] = await ctx.adapters.market.fetchIndexQuotes();
      if (indices.length === 0) {
        market = unavailable('指数行情返回空列表', 'realtime-index');
      } else {
        const latest = indices.reduce(
          (max, item) => (item.ts > max ? item.ts : max),
          indices[0]?.ts ?? asOf,
        );
        market = ok(
          { indices: [...indices] },
          latest,
          uniqueSources(indices.map((item) => item.source)),
        );
      }
    } catch (error) {
      if (error instanceof PluginExecutionDenied) throw error;
      const cause = errorText(error);
      market = unavailable(
        cause.includes('unsupported_capability')
          ? '当前数据源未注册指数行情能力'
          : `指数行情拉取失败：${cause}`,
        'realtime-index',
      );
    }
  }

  const pack = {
    stock: stockIdentity,
    ...(quote === undefined ? {} : { quote }),
    ...(bars === undefined ? {} : { bars }),
    ...(indicators === undefined ? {} : { indicators }),
    ...(intraday === undefined ? {} : { intraday }),
    ...(news === undefined ? {} : { news }),
    ...(sectors === undefined ? {} : { sectors }),
    ...(sectorQuote === undefined ? {} : { sectorQuote }),
    ...(signals === undefined ? {} : { signals }),
    ...(account === undefined ? {} : { account }),
    ...(market === undefined ? {} : { market }),
  } satisfies Omit<StockFactPack, 'factDigest'>;
  return { ...pack, factDigest: computeStockFactDigest(pack) };
};
