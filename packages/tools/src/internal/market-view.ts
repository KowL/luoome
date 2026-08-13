import {
  BUILTIN_HOLIDAYS,
  type DailyBar,
  type DataFreshness,
  dateInShanghai,
  type Holiday,
  isHoliday,
  isWeekend,
  type Money,
  money,
  type Quote,
} from '@luoome/core';

/**
 * Market View 纯 helper（docs/ddd/stock-market-view-detailed-design.md §8）。
 *
 * 全部纯函数、零 IO：时间范围归一化、bars 规范化、昨收推导、当日 candle 合并、
 * marketSession、数据状态判定。Tool（get-stock-market-view.ts）只负责拉数 / 落库 / 组装。
 *
 * 日期约定：DailyBar.date 用 UTC 零点表达 Asia/Shanghai 自然日
 * （adapter 侧 `new Date('YYYY-MM-DDT00:00:00.000Z')`），本模块沿用同一口径。
 */

export type MarketViewRange = '1m' | '3m' | '6m' | '1y';

/** range → 自然日回看长度（§7.1，给节假日留余量）。 */
export const MARKET_VIEW_RANGE_DAYS: Readonly<Record<MarketViewRange, number>> = {
  '1m': 35,
  '3m': 100,
  '6m': 190,
  '1y': 370,
};

/** 输出日 K 上限（§7.1：避免输出无上限）。 */
export const MAX_CANDLES = 260;
/** 月 K 聚合需要的日线窗口：~5 年（1y 窗口只够 12 根月 K）。 */
export const MONTH_GRANULARITY_LOOKBACK_DAYS = 5 * 370;
/** 月 K 窗口内的日线上限（5 年约 1220 个交易日，留余量）。 */
export const MONTH_GRANULARITY_MAX_BARS = 1300;
/** 低于该根数视为历史不足（§8.3：追加 bars-insufficient）。 */
export const MIN_SUFFICIENT_BARS = 20;

export type MarketSession = 'pre-open' | 'trading' | 'midday-break' | 'closed' | 'non-trading-day';

export type MarketViewWarning =
  | 'quote-local-fallback'
  | 'bars-local-fallback'
  | 'provider-fallback'
  | 'previous-close-unavailable'
  | 'bars-insufficient'
  | 'bars-truncated'
  | 'market-closed';

export interface MarketCandle {
  /** YYYY-MM-DD（Asia/Shanghai 自然日）。 */
  readonly date: string;
  readonly open: Money;
  readonly high: Money;
  readonly low: Money;
  readonly close: Money;
  readonly volume: number;
  readonly source: string;
  readonly completeness: 'closed' | 'live';
}

const DAY_MS = 86_400_000;

/**
 * 时间范围归一化（§8.1）：
 * - today = Asia/Shanghai 的 YYYY-MM-DD；
 * - end = today 对应 UTC 00:00（与 DailyBar.date 同口径）；
 * - start = end − range 对应自然日数。
 * start/end 按自然日对齐，DailyBarCache 的 exact-range key 才能命中。
 */
export const normalizeMarketRange = (
  range: MarketViewRange,
  now: Date,
): { readonly start: Date; readonly end: Date } => {
  const today = dateInShanghai(now);
  const end = new Date(`${today}T00:00:00.000Z`);
  const start = new Date(end.getTime() - MARKET_VIEW_RANGE_DAYS[range] * DAY_MS);
  return { start, end };
};

export interface NormalizedBars {
  readonly bars: readonly DailyBar[];
  /** 因 OHLC 关系非法被丢弃的条数（调用方记 warn 日志）。 */
  readonly droppedInvalid: number;
}

/**
 * bars 规范化（§8.3）：裁剪 [start, end] → OHLC 关系校验（非法丢弃）→
 * 同日去重留最后 → date 升序 → 最多保留最后 maxBars 根（默认 MAX_CANDLES=260；
 * 月 K 聚合需要 ~5 年日线，调用方显式放大）。
 * DailyBarSchema 已保证价格为正；OHLC 关系是对外部数据的防御性校验。
 */
export const normalizeDailyBars = (
  rawBars: readonly DailyBar[],
  start: Date,
  end: Date,
  maxBars: number = MAX_CANDLES,
): NormalizedBars => {
  const startMs = start.getTime();
  const endMs = end.getTime();
  const byDate = new Map<number, DailyBar>();
  let droppedInvalid = 0;
  for (const bar of rawBars) {
    const ms = bar.date.getTime();
    if (ms < startMs || ms > endMs) continue;
    const ocHigh = Math.max(bar.open, bar.close);
    const ocLow = Math.min(bar.open, bar.close);
    if (bar.high < ocHigh || bar.low > ocLow) {
      droppedInvalid += 1;
      continue;
    }
    byDate.set(ms, bar); // 同日重复：后出现的覆盖先出现的（留最后）
  }
  const bars = [...byDate.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
  return { bars: bars.slice(-maxBars), droppedInvalid };
};

/**
 * 昨收推导（§8.4）：严格取 date < 今日上海自然日（todayStart，UTC 零点口径）的
 * 最后一根有效 bar close；不用 quote.open / 当天未收盘 bar / 旧 PriceSnapshot。
 * 输入须为 normalizeDailyBars 的输出（升序）。
 */
export const derivePreviousClose = (bars: readonly DailyBar[], todayStart: Date): Money | null => {
  const todayMs = todayStart.getTime();
  for (let i = bars.length - 1; i >= 0; i--) {
    const bar = bars[i];
    if (bar !== undefined && bar.date.getTime() < todayMs) return bar.close;
  }
  return null;
};

/** 涨跌额 / 涨跌幅（§8.4）；精度与 Money 约定一致（4 位小数），prevClose 缺失或为 0 时全 null。 */
export const deriveQuoteChange = (
  quote: Quote,
  previousClose: Money | null,
): { readonly change: number | null; readonly changePct: number | null } => {
  if (previousClose === null || previousClose <= 0) return { change: null, changePct: null };
  const change = money(quote.close - previousClose);
  const changePct = money(change / previousClose);
  return { change, changePct };
};

/** 振幅 (high−low)/prevClose（§8.4 同口径，小数）；prevClose 缺失或为 0 时 null。 */
export const deriveAmplitude = (quote: Quote, previousClose: Money | null): number | null => {
  if (previousClose === null || previousClose <= 0) return null;
  return money((quote.high - quote.low) / previousClose);
};

/**
 * 当日 candle 合并（§8.5）：
 * 1. 历史 candle 只取 date < today 的 bar，completeness='closed'；
 * 2. Quote 对应当前上海自然日时，用 Quote 生成当天 candle（completeness='live'，
 *    收盘后仍 'live'：Quote.ts 是抓取时间，无法证明是交易所最终结算 K）；
 *    前提：当日已有交易。盘前 / 非交易日 Quote.ts 只是抓取时间，调用方应传 null，
 *    否则会伪造一根未开盘的当日 K 线；
 * 3. 远端当日 bar 被 Quote candle 替换，不同日两根；
 * 4. Quote 是历史本地回退（非今日）时不伪造当日 candle。
 * 输入须为 normalizeDailyBars 的输出（升序）。
 */
export const buildMarketCandles = (
  bars: readonly DailyBar[],
  quote: Quote | null,
  todayStart: Date,
): MarketCandle[] => {
  const todayMs = todayStart.getTime();
  const today = todayStart.toISOString().slice(0, 10);
  const candles: MarketCandle[] = [];
  for (const bar of bars) {
    if (bar.date.getTime() >= todayMs) continue; // 当日 bar 统一由 Quote candle 表达
    candles.push({
      date: bar.date.toISOString().slice(0, 10),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      source: bar.source,
      completeness: 'closed',
    });
  }
  if (quote !== null && dateInShanghai(quote.observedAt) === today) {
    candles.push({
      date: today,
      open: quote.open,
      high: quote.high,
      low: quote.low,
      close: quote.close,
      volume: quote.volume,
      source: quote.source,
      completeness: 'live',
    });
  }
  return candles;
};

export type MarketViewGranularity = 'day' | 'week' | 'month';

/** 上海历 ISO 周（周一起）的分桶键；date 是 YYYY-MM-DD 上海自然日（与 report.ts weekStart 同口径）。 */
const weekBucketKey = (date: string): string => {
  const value = new Date(`${date}T00:00:00.000Z`);
  const daysSinceMonday = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - daysSinceMonday);
  return value.toISOString().slice(0, 10);
};

/**
 * 日 K → 周 / 月 K 纯聚合：open=首根、close=末根、high/low=max/min、volume=sum，
 * source/completeness 取末根；date 用区间内最后交易日（保证图表 time 有序）。
 * 周按上海历 ISO 周（周一起）、月按自然月分组；输入须按 date 升序（buildMarketCandles 的输出）。
 * 聚合只影响输出 candles；indicators 恒用日级 candles 计算（CONTEXT.md 指标口径）。
 */
export const aggregateCandles = (
  candles: readonly MarketCandle[],
  granularity: MarketViewGranularity,
): MarketCandle[] => {
  if (granularity === 'day') return [...candles];
  const groups = new Map<string, MarketCandle[]>();
  for (const candle of candles) {
    const key = granularity === 'week' ? weekBucketKey(candle.date) : candle.date.slice(0, 7);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [candle]);
    else group.push(candle);
  }
  return [...groups.values()].map((group) => {
    const first = group[0] as MarketCandle;
    const last = group[group.length - 1] as MarketCandle;
    return {
      date: last.date,
      open: first.open,
      high: Math.max(...group.map((c) => c.high)) as Money,
      low: Math.min(...group.map((c) => c.low)) as Money,
      close: last.close,
      volume: group.reduce((sum, c) => sum + c.volume, 0),
      source: last.source,
      completeness: last.completeness,
    };
  });
};

/** candles → computeSimpleIndicators 的计算形状（§8.6：指标与输出 candles 同源）。 */
export const candlesToBars = (stockId: string, candles: readonly MarketCandle[]): DailyBar[] =>
  candles.map((c) => ({
    stockId,
    date: new Date(`${c.date}T00:00:00.000Z`),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    adjustment: 'qfq',
    source: c.source,
  }));

/**
 * A 股盘中时段纯计算（§8.7）：复用 core 交易日历（与 cli watch 同一套 BUILTIN_HOLIDAYS）。
 * - 周末 / 节假日 → non-trading-day
 * - < 9:30 → pre-open；9:30–11:30 → trading；11:30–13:00 → midday-break；
 *   13:00–15:00 → trading；> 15:00 → closed
 * 边界与 cli isTradingHours 一致（11:30 / 15:00 整点算 trading）。
 */
export const computeMarketSession = (
  now: Date,
  holidays: ReadonlyMap<number, ReadonlySet<Holiday>> = BUILTIN_HOLIDAYS,
): MarketSession => {
  if (isWeekend(now) || isHoliday(now, holidays)) return 'non-trading-day';
  const shanghaiMs = now.getTime() + 8 * 60 * 60 * 1000;
  const d = new Date(shanghaiMs);
  const t = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (t < 9 * 60 + 30) return 'pre-open';
  if (t <= 11 * 60 + 30) return 'trading';
  if (t < 13 * 60) return 'midday-break';
  if (t <= 15 * 60) return 'trading';
  return 'closed';
};

export interface MarketDataStatus {
  readonly freshness: DataFreshness;
  readonly retrieval: 'live' | 'local-fallback';
  readonly warnings: MarketViewWarning[];
}

/**
 * freshness / retrieval / warnings 判定（§8.7）：
 * - 任一部分 DB 回退 → stale / local-fallback；
 * - 全部 live 但历史不足 → unknown / live；
 * - 全部 live 且历史足够 → fresh / live；
 * - 成功数据中出现 tencent（备源）→ provider-fallback；
 * - 非连续竞价时段 → market-closed（提示性质，不等于故障）。
 */
export const buildMarketDataStatus = (input: {
  readonly quoteLive: boolean;
  readonly barsLive: boolean;
  readonly barsCount: number;
  readonly previousClose: Money | null;
  readonly session: MarketSession;
  readonly sources: readonly string[];
}): MarketDataStatus => {
  const warnings: MarketViewWarning[] = [];
  if (!input.quoteLive) warnings.push('quote-local-fallback');
  if (!input.barsLive) warnings.push('bars-local-fallback');
  if (input.sources.includes('tencent')) warnings.push('provider-fallback');
  if (input.previousClose === null) warnings.push('previous-close-unavailable');
  if (input.barsCount < MIN_SUFFICIENT_BARS) warnings.push('bars-insufficient');
  if (input.session !== 'trading') warnings.push('market-closed');

  const anyFallback = !input.quoteLive || !input.barsLive;
  const freshness: DataFreshness = anyFallback
    ? 'stale'
    : input.barsCount < MIN_SUFFICIENT_BARS
      ? 'unknown'
      : 'fresh';
  return { freshness, retrieval: anyFallback ? 'local-fallback' : 'live', warnings };
};
