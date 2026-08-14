import type { DailyBar } from '@luoome/core';

export interface StrategyMetaStockInput {
  readonly stockId: string;
  readonly industry?: string | undefined;
  readonly bars: readonly DailyBar[];
  readonly limitUpLadder?: {
    readonly ladderLevel: number;
  };
}

const sortedBars = (bars: readonly DailyBar[]): readonly DailyBar[] =>
  [...bars].sort((left, right) => left.date.getTime() - right.date.getTime());

const changeOverTradingSessions = (
  bars: readonly DailyBar[],
  sessions: number,
): number | undefined => {
  const current = bars.at(-1)?.close;
  const previous = bars.at(-(sessions + 1))?.close;
  if (current === undefined || previous === undefined || previous === 0) return undefined;
  return current / previous - 1;
};

const recentLimitUp = (
  bars: readonly DailyBar[],
): { readonly recentLimitUp: boolean; readonly daysSinceLimitUp?: number } | undefined => {
  if (bars.length < 6) return undefined;
  const firstIndex = Math.max(1, bars.length - 5);
  for (let index = bars.length - 1; index >= firstIndex; index -= 1) {
    const current = bars[index]?.close;
    const previous = bars[index - 1]?.close;
    if (
      current !== undefined &&
      previous !== undefined &&
      previous > 0 &&
      current / previous >= 1.095
    ) {
      return { recentLimitUp: true, daysSinceLimitUp: bars.length - 1 - index };
    }
  }
  return { recentLimitUp: false };
};

/** 从同一次运行已准备的 qfq 日线派生 DSL meta，避免额外 provider 与跨时点数据。 */
export const deriveStrategyMetaByStock = (
  stocks: readonly StrategyMetaStockInput[],
): ReadonlyMap<string, Readonly<Record<string, unknown>>> => {
  const prepared = stocks.map((stock) => {
    const bars = sortedBars(stock.bars);
    return {
      ...stock,
      bars,
      stockChange3d: changeOverTradingSessions(bars, 3),
      limitUp: recentLimitUp(bars),
    };
  });
  const sectorChanges = new Map<string, number[]>();
  for (const stock of prepared) {
    if (stock.industry === undefined || stock.stockChange3d === undefined) continue;
    const values = sectorChanges.get(stock.industry) ?? [];
    values.push(stock.stockChange3d);
    sectorChanges.set(stock.industry, values);
  }

  return new Map(
    prepared.map((stock) => {
      const sectorValues =
        stock.industry === undefined ? undefined : sectorChanges.get(stock.industry);
      const sectorAvgChange3d =
        sectorValues === undefined || sectorValues.length === 0
          ? undefined
          : sectorValues.reduce((sum, value) => sum + value, 0) / sectorValues.length;
      return [
        stock.stockId,
        {
          ...(stock.limitUp === undefined ? {} : stock.limitUp),
          ...(stock.stockChange3d === undefined
            ? {}
            : { stockChange3d: stock.stockChange3d, priceUp: stock.stockChange3d > 0 }),
          ...(sectorAvgChange3d === undefined ? {} : { sectorAvgChange3d }),
          ...(stock.limitUpLadder === undefined
            ? {}
            : {
                limitUpLevel: stock.limitUpLadder.ladderLevel,
                limitUpToday: true,
              }),
        },
      ];
    }),
  );
};
