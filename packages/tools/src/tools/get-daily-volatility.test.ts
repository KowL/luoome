import { type DailyBar, isHoliday, isWeekend, money } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { getDailyVolatilityTool } from './get-daily-volatility.js';

const STOCK_ID = '600519.SH';
/** 2026-07-31 是周五，往前取 21 个交易日不跨长假日历边界。 */
const END = new Date('2026-07-31T00:00:00.000Z');
const DAY_MS = 86_400_000;

/**
 * 从 `end` 往前取 `count` 个交易日（跳过周末与节假日），可指定在最新 `afterNewest` 根之后
 * 再跳过 `missing` 个交易日——模拟停牌期间不产生 bar。
 * 返回按时间升序的日期；`missing` 段内的交易日没有任何 bar。
 */
const tradingDaysBack = (
  count: number,
  options: { readonly end?: Date; readonly afterNewest?: number; readonly missing?: number } = {},
): Date[] => {
  const end = options.end ?? END;
  const afterNewest = options.afterNewest ?? -1;
  let remainingMissing = options.missing ?? 0;
  const descending: Date[] = [];
  let cursor = end.getTime();
  while (descending.length < count) {
    const day = new Date(cursor);
    if (!isWeekend(day) && !isHoliday(day)) {
      if (descending.length === afterNewest && remainingMissing > 0) remainingMissing -= 1;
      else descending.push(day);
    }
    cursor -= DAY_MS;
  }
  return descending.reverse();
};

/** 第 `offset` 个交易日之前（0 = `end` 当天）的日期。 */
const tradingDayAt = (offset: number, end: Date = END): Date =>
  tradingDaysBack(offset + 1, { end })[0] as Date;

/** 由 20 个日收益率派生 21 个收盘价。 */
const closesFromReturns = (returns: readonly number[]): number[] => {
  const closes: number[] = [100];
  for (const value of returns) {
    closes.push((closes.at(-1) as number) * (1 + value));
  }
  return closes;
};

/** 把收盘价落到给定日期上，构造 qfq 日线；`zeroVolumeIndexes` 里的 bar 记 volume=0（停牌占位）。 */
const barsAtDates = (
  closes: readonly number[],
  dates: readonly Date[],
  options: { readonly volume?: number; readonly zeroVolumeIndexes?: readonly number[] } = {},
): DailyBar[] =>
  closes.map((close, index) => ({
    stockId: STOCK_ID,
    date: dates[index] as Date,
    open: money(close),
    high: money(close),
    low: money(close),
    close: money(close),
    volume: options.zeroVolumeIndexes?.includes(index) ? 0 : (options.volume ?? 1_000_000),
    adjustment: 'qfq' as const,
    source: 'fixture',
  }));

/** 21 根「连续交易日」的日线（默认全部有成交），收益率由参数派生。 */
const barsFromReturns = (
  returns: readonly number[],
  options: {
    readonly end?: Date;
    readonly volume?: number;
    readonly zeroVolumeIndexes?: readonly number[];
  } = {},
): DailyBar[] => {
  const closes = closesFromReturns(returns);
  return barsAtDates(closes, tradingDaysBack(closes.length, { end: options.end ?? END }), options);
};

/** 独立复算的总体标准差（百分点）：与被测实现的公式分开写，用来交叉验证。 */
const sigmaPctOfReturns = (returns: readonly number[]): number => {
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * 100;
};

/** 收盘价环比 → 收益率（不做断档 / 零成交过滤，仅供测试里对照）。 */
const returnsOfCloses = (closes: readonly number[]): number[] =>
  closes
    .slice(1)
    .map((close, index) => (close - (closes[index] as number)) / (closes[index] as number));

const populationSigmaPct = (closes: readonly number[]): number =>
  sigmaPctOfReturns(returnsOfCloses(closes));

/** 交替 ±3% 的 20 个收益率 → 已实现波动率 3.0%。 */
const THREE_PCT_RETURNS = Array.from({ length: 20 }, (_, index) =>
  index % 2 === 0 ? 0.03 : -0.03,
);

/** 交替 ±0.02% 的 20 个收益率 → 已实现波动率 0.02%（远低于 0.1 的默认下限）。 */
const MICRO_MOVE_RETURNS = Array.from({ length: 20 }, (_, index) =>
  index % 2 === 0 ? 0.0002 : -0.0002,
);

/** 交替 ±0.3% 的 20 个收益率 → 已实现波动率 0.3%（高于默认下限，但可被调高的下限拒掉）。 */
const LOW_MOVE_RETURNS = Array.from({ length: 20 }, (_, index) =>
  index % 2 === 0 ? 0.003 : -0.003,
);

describe('tool/get_daily_volatility', () => {
  it('用本地 20 个日收益率算已实现波动率（百分点），不猜当日行情', async () => {
    const ctx = await buildTestContext({ clock: () => END });
    const bars = barsFromReturns(THREE_PCT_RETURNS);
    await ctx.repos.dailyBar.saveMany(bars);

    const result = await getDailyVolatilityTool.execute({ stockIds: [STOCK_ID] }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.window).toBe(20);
    expect(result.data.items).toHaveLength(1);
    const item = result.data.items[0];
    if (item === undefined || item.status !== 'ok') throw new Error('expected ok item');
    expect(item.volatilityPct).toBeCloseTo(3, 2);
    expect(item.barsCount).toBe(21);
    // 21 根连续交易日、全部有成交 → 20 个有效日收益率。
    expect(item.returnsCount).toBe(20);
    expect(item.windowEnd).toEqual(END);
    expect(item.latestBarDate).toEqual(END);
    expect(item.windowStart).toEqual(bars[0]?.date);
    // 日线就是最新交易日 → 滞后 0 个交易日。
    expect(item.stalenessTradingDays).toBe(0);
    // 连续日线没有断档。
    expect(item.maxGapTradingDays).toBe(0);
  });

  it('样本不足返回 unavailable，不返回 0 波动率', async () => {
    const ctx = await buildTestContext({ clock: () => END });
    await ctx.repos.dailyBar.saveMany(barsFromReturns([0.01, -0.01, 0.01, -0.01]));

    const result = await getDailyVolatilityTool.execute({ stockIds: [STOCK_ID, '000001.SZ'] }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items).toEqual([
      {
        stockId: STOCK_ID,
        status: 'unavailable',
        reason: 'insufficient-daily-bars',
        barsCount: 5,
        requiredBars: 21,
      },
      {
        stockId: '000001.SZ',
        status: 'unavailable',
        reason: 'insufficient-daily-bars',
        barsCount: 0,
        requiredBars: 21,
      },
    ]);
  });

  it('21 根完全相同收盘价（停牌形态）判为 insufficient-volatility，不是 0 波动率', async () => {
    const ctx = await buildTestContext({ clock: () => END });
    const bars = barsFromReturns(Array.from({ length: 20 }, () => 0));
    await ctx.repos.dailyBar.saveMany(bars);

    const result = await getDailyVolatilityTool.execute({ stockIds: [STOCK_ID] }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]).toEqual({
      stockId: STOCK_ID,
      status: 'unavailable',
      reason: 'insufficient-volatility',
      barsCount: 21,
      requiredBars: 21,
      returnsCount: 20,
      requiredReturns: 20,
      zeroVolumeBars: 0,
      maxGapTradingDays: 0,
      volatilityPct: 0,
      // 被拒的样本也要能复盘：写明是哪 21 根 bar 算出来的 0。
      windowStart: bars[0]?.date,
      windowEnd: END,
    });
  });

  it('日线停更时给出滞后交易日数，不静默当当前样本', async () => {
    const ctx = await buildTestContext({ clock: () => END });
    // 最后一根日线停在 60 个自然日前：窗口完整、波动率仍是 3%，但它已经旧了。
    const staleEnd = new Date(END.getTime() - 60 * 86_400_000);
    await ctx.repos.dailyBar.saveMany(barsFromReturns(THREE_PCT_RETURNS, { end: staleEnd }));

    const result = await getDailyVolatilityTool.execute({ stockIds: [STOCK_ID] }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.data.items[0];
    if (item === undefined || item.status !== 'ok') throw new Error('expected ok item');
    expect(item.windowEnd).toEqual(staleEnd);
    expect(item.latestBarDate).toEqual(staleEnd);
    expect(item.volatilityPct).toBeCloseTo(3, 2);
    // 60 个自然日 ≈ 42 个交易日；只要求「明显超过 5 个交易日」即可触发降级。
    expect(item.stalenessTradingDays).toBeGreaterThan(5);
    expect(item.stalenessTradingDays).toBeLessThan(60);
  });

  it('截面时点之后的日线不参与计算', async () => {
    const ctx = await buildTestContext({ clock: () => END });
    const bars = barsFromReturns(THREE_PCT_RETURNS);
    await ctx.repos.dailyBar.saveMany(bars);
    const asOf = new Date(END.getTime() - 86_400_000);

    const result = await getDailyVolatilityTool.execute({ stockIds: [STOCK_ID], asOf }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]).toMatchObject({
      status: 'unavailable',
      reason: 'insufficient-daily-bars',
      barsCount: 20,
    });
  });

  it('非正收盘价视为坏样本', async () => {
    const ctx = await buildTestContext({ clock: () => END });
    const bars = barsFromReturns(THREE_PCT_RETURNS);
    const broken = bars.map((bar, index) => (index === 10 ? { ...bar, close: money(0) } : bar));
    await ctx.repos.dailyBar.saveMany(broken);

    const result = await getDailyVolatilityTool.execute({ stockIds: [STOCK_ID] }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]).toMatchObject({
      status: 'unavailable',
      reason: 'invalid-daily-bars',
    });
  });

  it('volume=0 的 bar 不算有效样本：价格微动 0.02% 也判 insufficient-volatility', async () => {
    const ctx = await buildTestContext({ clock: () => END });
    // provider 在停牌期仍写了 bar：日期是新的、volume=0、收盘价还在微动。
    const bars = barsFromReturns(MICRO_MOVE_RETURNS, { volume: 0 });
    await ctx.repos.dailyBar.saveMany(bars);

    const result = await getDailyVolatilityTool.execute({ stockIds: [STOCK_ID] }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]).toEqual({
      stockId: STOCK_ID,
      status: 'unavailable',
      reason: 'insufficient-volatility',
      barsCount: 21,
      requiredBars: 21,
      // 零成交 → 一对收益率都不成立，σ 无定义（不是 0）。
      returnsCount: 0,
      requiredReturns: 20,
      zeroVolumeBars: 21,
      maxGapTradingDays: 0,
      windowStart: bars[0]?.date,
      windowEnd: END,
    });
  });

  it('第三道闸门：volume=0 但价格微动 > 0.1% 必须降级，不得拿到接近上限的仓位', async () => {
    const ctx = await buildTestContext({ clock: () => END });
    // 这是「停牌由新鲜度兜住」这个前提不成立时的漏网形态：21 根 volume=0 的 bar，
    // 日期一路排到最新交易日（staleness=0），收盘价却仍按 ±3% 摆动。
    // 只看收盘价会得到 3.0% 的 σ → 第一/第二档 → 接近区间上限的仓位。
    const bars = barsFromReturns(THREE_PCT_RETURNS, { volume: 0 });
    await ctx.repos.dailyBar.saveMany(bars);

    const result = await getDailyVolatilityTool.execute({ stockIds: [STOCK_ID] }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.data.items[0];
    if (item === undefined) throw new Error('expected item');
    // 关键断言：不得判 ok（ok 就会给出接近上限的仓位）。
    expect(item.status).toBe('unavailable');
    if (item.status !== 'unavailable') return;
    expect(item.reason).toBe('insufficient-volatility');
    expect(item.returnsCount).toBe(0);
    expect(item.zeroVolumeBars).toBe(21);
    // 收盘价确实是 ±3% 摆动的：σ 若被计算出来会高达 3%，所以降级只能来自零成交判据。
    expect(populationSigmaPct(bars.map((bar) => bar.close))).toBeGreaterThan(2.9);
    // 没有可用的 σ，就不该输出一个「看起来能用」的 volatilityPct。
    expect(item.volatilityPct).toBeUndefined();
  });

  it('窗口里夹一根 volume=0 的 bar：有效收益率 18 < 20，判 insufficient-volatility', async () => {
    const ctx = await buildTestContext({ clock: () => END });
    // 中间那根是停牌占位：它与左右各构成一对，两对都不是「有成交的日收益率」。
    const bars = barsFromReturns(THREE_PCT_RETURNS, { zeroVolumeIndexes: [10] });
    await ctx.repos.dailyBar.saveMany(bars);

    const result = await getDailyVolatilityTool.execute({ stockIds: [STOCK_ID] }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.data.items[0];
    if (item === undefined || item.status !== 'unavailable')
      throw new Error('expected unavailable');
    expect(item.reason).toBe('insufficient-volatility');
    expect(item.returnsCount).toBe(18);
    expect(item.requiredReturns).toBe(20);
    expect(item.zeroVolumeBars).toBe(1);
    expect(item.maxGapTradingDays).toBe(0);
    // 剩下 18 个收益率仍然算得出 σ，但样本不够 20 个，不能当「20 日波动率」用。
    // 期望值按「剔除与零成交 bar 相关的两对」独立复算（不能先 filter 掉 bar 再取环比，
    // 那样会把 9→11 这两根并不相邻的 bar 拼成一对）。
    const closes = bars.map((bar) => bar.close);
    const validReturns = returnsOfCloses(closes).filter(
      (_, index) => index + 1 !== 10 && index + 1 !== 11,
    );
    expect(validReturns).toHaveLength(18);
    expect(item.volatilityPct).toBeCloseTo(sigmaPctOfReturns(validReturns), 10);
  });

  it('12 个交易日断档：跨断档的收益率被剔除，有效收益率 19 < 20 判 insufficient-volatility', async () => {
    const ctx = await buildTestContext({ clock: () => END });
    // 最新 10 根之后停牌 12 个交易日，再往前 11 根：窗口跨过整段停牌。
    const dates = tradingDaysBack(21, { afterNewest: 10, missing: 12 });
    const bars = barsAtDates(closesFromReturns(THREE_PCT_RETURNS), dates);
    await ctx.repos.dailyBar.saveMany(bars);

    const result = await getDailyVolatilityTool.execute({ stockIds: [STOCK_ID] }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.data.items[0];
    if (item === undefined || item.status !== 'unavailable')
      throw new Error('expected unavailable');
    // 21 根 bar → 20 对；跨 12 个交易日的那一对是多日收益，不是日收益，被剔除。
    expect(item.barsCount).toBe(21);
    expect(item.returnsCount).toBe(19);
    expect(item.requiredReturns).toBe(20);
    // 断档如实可见：相邻两根 bar 之间有 12 个交易日没有 bar。
    expect(item.maxGapTradingDays).toBe(12);
    expect(item.zeroVolumeBars).toBe(0);
    // 19 个有效收益率 < 20 → 样本不足，降级到区间下限。
    expect(item.reason).toBe('insufficient-volatility');
    // 窗口终点仍是最新 bar：这里的降级不是「数据过期」，是「窗口不连续」。
    expect(item.windowEnd).toEqual(END);
  });

  it('多段停牌：有效收益率只剩 9 个，远低于 20，判 insufficient-volatility', async () => {
    const ctx = await buildTestContext({ clock: () => END });
    // 最近 10 个交易日连续，再往前每两个交易日才有一根 bar（多段停牌）。
    const offsets = [
      ...Array.from({ length: 10 }, (_, index) => index),
      ...Array.from({ length: 11 }, (_, index) => 12 + index * 2),
    ];
    const dates = offsets.map((offset) => tradingDayAt(offset)).reverse();
    const bars = barsAtDates(closesFromReturns(THREE_PCT_RETURNS), dates);
    await ctx.repos.dailyBar.saveMany(bars);

    const result = await getDailyVolatilityTool.execute({ stockIds: [STOCK_ID] }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.data.items[0];
    if (item === undefined || item.status !== 'unavailable')
      throw new Error('expected unavailable');
    expect(item.barsCount).toBe(21);
    // 10 根连续 → 9 对；其余 11 对全部跨断档。
    expect(item.returnsCount).toBe(9);
    expect(item.reason).toBe('insufficient-volatility');
    // 断档段每两根 bar 之间缺 1 个交易日，接缝处（第 10 根 → 第 12 个交易日那根）缺 2 个。
    expect(item.maxGapTradingDays).toBe(2);
    expect(item.zeroVolumeBars).toBe(0);
  });

  it('σ 下限可配置：默认 0.1 放行 0.3%，调到 1 就判 insufficient-volatility', async () => {
    const ctx = await buildTestContext({ clock: () => END });
    await ctx.repos.dailyBar.saveMany(barsFromReturns(LOW_MOVE_RETURNS));

    const byDefault = await getDailyVolatilityTool.execute({ stockIds: [STOCK_ID] }, ctx);
    expect(byDefault.ok).toBe(true);
    if (!byDefault.ok) return;
    const passed = byDefault.data.items[0];
    if (passed === undefined || passed.status !== 'ok') throw new Error('expected ok item');
    expect(passed.volatilityPct).toBeCloseTo(
      populationSigmaPct(barsFromReturns(LOW_MOVE_RETURNS).map((bar) => bar.close)),
      10,
    );
    expect(passed.returnsCount).toBe(20);

    const strict = await getDailyVolatilityTool.execute(
      { stockIds: [STOCK_ID], minVolatilityPct: 1 },
      ctx,
    );
    expect(strict.ok).toBe(true);
    if (!strict.ok) return;
    const rejected = strict.data.items[0];
    if (rejected === undefined || rejected.status !== 'unavailable')
      throw new Error('expected unavailable');
    expect(rejected.reason).toBe('insufficient-volatility');
    expect(rejected.volatilityPct).toBe(passed.volatilityPct);
    // σ 下限这条闸门只在「20 个有效收益率都在」时才轮到它说话。
    expect(rejected.returnsCount).toBe(20);
  });
});
