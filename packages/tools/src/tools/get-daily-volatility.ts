import {
  type DailyBar,
  isHoliday,
  isUsableVolatilityPct,
  isWeekend,
  resolveTradingPlanVolatilityPolicy,
  TRADING_PLAN_VOLATILITY_METRIC,
  TRADING_PLAN_VOLATILITY_WINDOW,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

/**
 * get_daily_volatility（read）：从本地 `daily_bars` 计算已实现波动率。
 *
 * 存在的理由：TradingPlan 的 `rangePick='volatility-scaled'` 需要一个**可复算**的波动率输入，
 * 而 `daily_bars` 是系统里唯一的前复权收盘价事实表。这里只读本地投影、不回源：
 * 样本不足或样本无效时返回 unavailable，由调用方显式降级到区间下限，而不是拿当日行情猜一个波动率。
 *
 * 窗口口径是「最近 21 **根 bar**」，不是「最近 21 个自然日 / 交易日」。停牌期间通常不产生 bar，
 * 两者的差别正是停牌标的的窗口跨度：按 bar 取才能拿到 21 个真实收盘价。
 *
 * 但「停牌不产生 bar」是上游 provider 的常见行为，**不是写入侧的保证**：`sync_daily_bars` 只丢弃
 * 未收盘的当日 bar（`dropUnclosedBars`），既不丢 `volume === 0` 的行、也不校验日期是不是交易日；
 * adapter 也只过滤非正 OHLC（见 `fetchEastmoneyDailyBars` / `parseXueqiuDailyBars`）。若 provider 在
 * 停牌期写了一条 volume=0、收盘价仍在微动的 bar，`stalenessTradingDays` 会恒为 0，新鲜度闸门完全
 * 失效，只剩 σ 下限兜底——而「volume=0 + 价格微动 > 0.1%」正好能穿过 σ 下限，拿到接近区间上限的
 * 仓位。所以这里把零成交 bar 当作**无效样本**：它不是「一笔成交价为 0 的交易」，而是「没有交易」。
 *
 * 另一个失真源是跨断档的收益率：窗口按 bar 取，相邻两根 bar 之间可能缺了 12 个交易日，那一个收益率
 * 其实是 12 日收益，混进「日收益」序列会抬高 σ。剔除它不是策略选择（不需要「gap 多大算不可用」的
 * 阈值），而是定义问题：它不是日收益率。
 *
 * 于是只有「正好相差 1 个交易日、且两端都有成交」的 bar 对才产生收益率；有效收益率不足
 * `TRADING_PLAN_VOLATILITY_WINDOW`（20）个就判 `insufficient-volatility`——21 根 bar 少一对，
 * 说明窗口跨过停牌或含零成交占位，那已经不是「20 个日收益率的标准差」了。
 *
 * `volume` 的**数值**不参与 σ 计算（与 `local-selector` 的 `volatility-20` 同口径，只用收盘价环比）；
 * 它只用来判断这根 bar 是不是真实成交。反过来把 volume=0 的 bar 直接丢掉或补成 0 收益率都会**制造**
 * 失真：前者缩短窗口，后者压低 σ。
 */

/** 20 个收益率需要 21 根收盘价。 */
const REQUIRED_BARS = TRADING_PLAN_VOLATILITY_WINDOW + 1;

/** 窗口必须产出的有效收益率个数；少一个就说明窗口跨了断档或含零成交 bar。 */
const REQUIRED_RETURNS = TRADING_PLAN_VOLATILITY_WINDOW;

export const GetDailyVolatilityInput = z.object({
  stockIds: z.array(z.string().trim().min(1)).min(1).max(200),
  /** 截面时点：只用该时刻及之前已落库的日线；缺省为 ctx.clock()。 */
  asOf: z.coerce.date().optional(),
  /**
   * σ 下限（百分点）。缺省取 `TRADING_PLAN_VOLATILITY_MIN_PCT`（0.1）——**未标定的经验值**，
   * 调用方按真实 `daily_bars` 分布覆盖它；阈值不在这一层写第二份默认值。
   */
  minVolatilityPct: z.number().finite().min(0).max(100).optional(),
});

const DailyVolatilityOkSchema = z.object({
  stockId: z.string(),
  status: z.literal('ok'),
  volatilityMetric: z.string(),
  volatilityPct: z.number().finite().nonnegative(),
  barsCount: z.number().int().positive(),
  /** 参与 σ 的有效收益率个数；`ok` 恒等于窗口宽度（20）。 */
  returnsCount: z.number().int().positive(),
  windowStart: z.coerce.date(),
  /** 窗口最后一根日线（窗口末端即最新日线）。 */
  windowEnd: z.coerce.date(),
  /** 该标的当前可用的最新日线日期；与 `windowEnd` 是同一根 bar，显式给新鲜度消费方用。 */
  latestBarDate: z.coerce.date(),
  /** 最新日线之后已过去的交易日数（0 = 日线就是最新交易日）。 */
  stalenessTradingDays: z.number().int().nonnegative(),
  /**
   * 窗口内相邻 bar 之间缺失的交易日数（0 = 无断档）。`ok` 恒为 0：跨断档的收益率不参与 σ，
   * 而少了任何一个收益率都判 `insufficient-volatility`。保留该字段是为了让「这 21 根 bar 是连续
   * 交易日」这件事在回执里可验证，而不是靠调用方自己假设。
   */
  maxGapTradingDays: z.number().int().nonnegative(),
});

const DailyVolatilityUnavailableSchema = z.object({
  stockId: z.string(),
  status: z.literal('unavailable'),
  reason: z.enum([
    'insufficient-daily-bars',
    'invalid-daily-bars',
    /**
     * 样本齐但不可用，两种成因同属「样本无效」：
     * - σ 低于下限：停牌 / 长期无成交，不是「低波动」。
     * - 有效日收益率不足 20 个：窗口跨过停牌断档，或含 volume=0 的占位 bar。
     * 二者都靠 `returnsCount` / `zeroVolumeBars` / `maxGapTradingDays` 区分，无需第二套 reason。
     */
    'insufficient-volatility',
  ]),
  barsCount: z.number().int().nonnegative(),
  requiredBars: z.number().int().positive(),
  /** 参与 σ 的有效收益率个数（仅 `insufficient-volatility`）。 */
  returnsCount: z.number().int().nonnegative().optional(),
  /** 窗口应产出的收益率个数（仅 `insufficient-volatility`）。 */
  requiredReturns: z.number().int().positive().optional(),
  /** 窗口内 volume=0 的 bar 个数（仅 `insufficient-volatility`）：> 0 说明样本里混了占位 bar。 */
  zeroVolumeBars: z.number().int().nonnegative().optional(),
  /** 窗口内相邻 bar 之间缺失的交易日数（仅 `insufficient-volatility`）。 */
  maxGapTradingDays: z.number().int().nonnegative().optional(),
  /** 有有效收益率时给出实测值，让「σ=0 被拒」在回执里可见。 */
  volatilityPct: z.number().finite().nonnegative().optional(),
  /** 仅在 `insufficient-volatility` 时给出被拒的窗口，回答「这个 σ 是哪 21 天」。 */
  windowStart: z.coerce.date().optional(),
  windowEnd: z.coerce.date().optional(),
});

export const GetDailyVolatilityOutput = z.object({
  volatilityMetric: z.string(),
  window: z.number().int().positive(),
  items: z.array(
    z.discriminatedUnion('status', [DailyVolatilityOkSchema, DailyVolatilityUnavailableSchema]),
  ),
});

const DAY_MS = 86_400_000;

/**
 * 最新日线之后过了几个交易日（0 = 日线就是最新交易日）。
 *
 * 只按 core 的节假日历逐自然日推进，**不**追求「当日是否已收盘」的精确口径：
 * 这里的目的只是让「日线停更了」在回执里可见并驱动降级，不是交易日历基准。
 * 与 `DailyBar.date` 的「交易日 UTC 午夜」约定一致，先截到 UTC 日界再比较。
 */
const tradingDaysElapsed = (latestBarDate: Date, asOf: Date): number => {
  const dayStart = (date: Date): number => Math.floor(date.getTime() / DAY_MS) * DAY_MS;
  const end = dayStart(asOf);
  let days = 0;
  for (let cursor = dayStart(latestBarDate) + DAY_MS; cursor <= end; cursor += DAY_MS) {
    const day = new Date(cursor);
    if (!isWeekend(day) && !isHoliday(day)) days += 1;
  }
  return days;
};

/** 两根 bar 之间是否正好差 1 个交易日（中间没有缺失的交易日）。 */
const isAdjacentTradingDay = (previous: DailyBar, current: DailyBar): boolean =>
  tradingDaysElapsed(previous.date, current.date) === 1;

/**
 * 窗口内相邻 bar 之间**缺失**的交易日数（0 = 无断档）。
 * 只测量、不修正：跨断档的收益率已经不参与 σ（见 `dailyReturnSeries`），这里留下的是
 * 「窗口跨度为什么比 20 个交易日长」的证据。
 */
const windowMaxGapTradingDays = (bars: readonly DailyBar[]): number => {
  let max = 0;
  for (let index = 1; index < bars.length; index += 1) {
    const previous = bars[index - 1];
    const current = bars[index];
    if (previous === undefined || current === undefined) continue;
    const missing = tradingDaysElapsed(previous.date, current.date) - 1;
    if (missing > max) max = missing;
  }
  return max;
};

/** 收益率总体标准差（百分点）；与 local-selector 的 `volatility-20` 同一口径。 */
const sigmaPct = (returns: readonly number[]): number => {
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * 100;
};

type DailyReturnSeries =
  | { readonly status: 'invalid-daily-bars' }
  | {
      readonly status: 'sampled';
      readonly returnsCount: number;
      /** 有效收益率为 0 时无定义：此时整段窗口都是零成交 / 断档。 */
      readonly volatilityPct: number | undefined;
    };

/**
 * 窗口 → 日收益率序列。
 *
 * 只有同时满足「相邻且正好差 1 个交易日」和「两端 volume > 0」的 bar 对才贡献收益率：
 * - 跨断档的收益率是**多日**收益，不是日收益，混进来只会抬高 σ（把标的推去更低档）。
 *   方向虽然安全，但那是巧合，不是设计保证。
 * - 零成交 bar 是停牌占位，不是「一笔成交价为 0 的交易」；用它的收盘价算环比等于把
 *   「没有交易」当成「有价格」，正是 σ 下限挡不住的那种样本。
 */
const dailyReturnSeries = (bars: readonly DailyBar[]): DailyReturnSeries => {
  const returns: number[] = [];
  for (let index = 1; index < bars.length; index += 1) {
    const previous = bars[index - 1];
    const current = bars[index];
    if (previous === undefined || current === undefined) return { status: 'invalid-daily-bars' };
    if (previous.close <= 0 || current.close <= 0) return { status: 'invalid-daily-bars' };
    if (current.date.getTime() <= previous.date.getTime()) return { status: 'invalid-daily-bars' };
    if (!isAdjacentTradingDay(previous, current)) continue;
    if (previous.volume <= 0 || current.volume <= 0) continue;
    returns.push((current.close - previous.close) / previous.close);
  }
  return {
    status: 'sampled',
    returnsCount: returns.length,
    volatilityPct: returns.length === 0 ? undefined : sigmaPct(returns),
  };
};

export const getDailyVolatilityTool = defineTool({
  name: 'get_daily_volatility',
  description:
    '读取本地日线计算 20 日已实现波动率（百分点）；样本不足、有效收益率不足或 σ 过低返回 unavailable，并给出日线滞后交易日数',
  sideEffect: 'read',
  input: GetDailyVolatilityInput,
  output: GetDailyVolatilityOutput,
  handler: async (input, ctx) => {
    const asOf = input.asOf ?? ctx.clock();
    const policy = resolveTradingPlanVolatilityPolicy({
      ...(input.minVolatilityPct === undefined ? {} : { minVolatilityPct: input.minVolatilityPct }),
    });
    const stockIds = [...new Set(input.stockIds)];
    const items = await Promise.all(
      stockIds.map(async (stockId) => {
        const bars = await ctx.repos.dailyBar.latestBefore(stockId, asOf, REQUIRED_BARS);
        if (bars.length < REQUIRED_BARS) {
          return {
            stockId,
            status: 'unavailable' as const,
            reason: 'insufficient-daily-bars' as const,
            barsCount: bars.length,
            requiredBars: REQUIRED_BARS,
          };
        }
        const windowStart = bars[0]?.date;
        const windowEnd = bars.at(-1)?.date;
        const sampled = dailyReturnSeries(bars);
        if (sampled.status !== 'sampled' || windowStart === undefined || windowEnd === undefined) {
          return {
            stockId,
            status: 'unavailable' as const,
            reason: 'invalid-daily-bars' as const,
            barsCount: bars.length,
            requiredBars: REQUIRED_BARS,
          };
        }
        const { volatilityPct } = sampled;
        const zeroVolumeBars = bars.filter((bar) => bar.volume <= 0).length;
        const maxGapTradingDays = windowMaxGapTradingDays(bars);
        // 有效收益率不足 / 一个都没有：窗口跨了断档或含零成交 bar，σ 不是「20 个日收益率的 σ」。
        // 这是**样本无效**，不是「波动很小」，所以同样判 insufficient-volatility 并降级到下限。
        if (volatilityPct === undefined || sampled.returnsCount < REQUIRED_RETURNS) {
          return {
            stockId,
            status: 'unavailable' as const,
            reason: 'insufficient-volatility' as const,
            barsCount: bars.length,
            requiredBars: REQUIRED_BARS,
            returnsCount: sampled.returnsCount,
            requiredReturns: REQUIRED_RETURNS,
            zeroVolumeBars,
            maxGapTradingDays,
            ...(volatilityPct === undefined ? {} : { volatilityPct }),
            windowStart,
            windowEnd,
          };
        }
        // 样本齐但波动率贴地：停牌 / 长期无成交。按无效样本处理，绝不当「最安全」放行。
        if (!isUsableVolatilityPct(volatilityPct, policy.minVolatilityPct)) {
          return {
            stockId,
            status: 'unavailable' as const,
            reason: 'insufficient-volatility' as const,
            barsCount: bars.length,
            requiredBars: REQUIRED_BARS,
            returnsCount: sampled.returnsCount,
            requiredReturns: REQUIRED_RETURNS,
            zeroVolumeBars,
            maxGapTradingDays,
            volatilityPct,
            windowStart,
            windowEnd,
          };
        }
        return {
          stockId,
          status: 'ok' as const,
          volatilityMetric: TRADING_PLAN_VOLATILITY_METRIC,
          volatilityPct,
          barsCount: bars.length,
          returnsCount: sampled.returnsCount,
          windowStart,
          windowEnd,
          latestBarDate: windowEnd,
          stalenessTradingDays: tradingDaysElapsed(windowEnd, asOf),
          maxGapTradingDays,
        };
      }),
    );
    return {
      volatilityMetric: TRADING_PLAN_VOLATILITY_METRIC,
      window: TRADING_PLAN_VOLATILITY_WINDOW,
      items,
    };
  },
});
