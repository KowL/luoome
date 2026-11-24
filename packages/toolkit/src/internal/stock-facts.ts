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
