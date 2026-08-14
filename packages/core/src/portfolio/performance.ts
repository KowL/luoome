import type { Holding } from '../entity/holding.js';
import type {
  PortfolioCashFlow,
  PortfolioContribution,
  PortfolioCorporateAction,
  PortfolioPerformance,
  PortfolioValuationDay,
} from '../entity/portfolio-performance.js';
import type { DailyBar } from '../entity/quote.js';
import type { Trade } from '../entity/trade.js';
import { isHoliday, isWeekend } from '../trading-calendar.js';

export interface PortfolioPerformanceInput {
  readonly accountId: string;
  readonly currency: string;
  readonly initialCapital: number;
  readonly from: Date;
  readonly to: Date;
  readonly trades: readonly Trade[];
  /** 只有没有对应 Trade 事实的直接录入持仓才作为期初仓位使用。 */
  readonly initialHoldings?: readonly Pick<Holding, 'stockId' | 'quantity' | 'avgCost'>[];
  readonly cashFlows: readonly PortfolioCashFlow[];
  readonly corporateActions: readonly PortfolioCorporateAction[];
  readonly barsByStock: ReadonlyMap<string, readonly DailyBar[]>;
  readonly benchmarkBars?: readonly DailyBar[];
}

interface PositionState {
  quantity: number;
  averageCost: number;
  realizedPnl: number;
  dividends: number;
}

const dayKey = (date: Date): string => date.toISOString().slice(0, 10);
const signOfCashFlow = (kind: PortfolioCashFlow['kind']): number =>
  kind === 'deposit' || kind === 'dividend' || kind === 'transfer-in' ? 1 : -1;

const isExternalCashFlow = (kind: PortfolioCashFlow['kind']): boolean =>
  kind === 'deposit' || kind === 'withdrawal' || kind === 'transfer-in' || kind === 'transfer-out';

const tradingDays = (from: Date, to: Date): Date[] => {
  const result: Date[] = [];
  for (
    let cursor = new Date(from);
    cursor <= to;
    cursor = new Date(cursor.getTime() + 86_400_000)
  ) {
    if (!isWeekend(cursor) && !isHoliday(cursor)) result.push(new Date(cursor));
  }
  return result;
};

const priceAt = (bars: readonly DailyBar[] | undefined, date: Date): number | undefined => {
  if (bars === undefined) return undefined;
  const key = dayKey(date);
  const bar = bars.find((item) => dayKey(item.date) === key);
  return bar?.close;
};

const emptyContribution = (stockId: string): PortfolioContribution => ({
  stockId,
  currentValue: 0,
  realizedPnl: 0,
  dividends: 0,
  contribution: 0,
  completeness: 'unavailable',
});

export const calculatePortfolioPerformance = (
  input: PortfolioPerformanceInput,
): PortfolioPerformance => {
  const positions = new Map<string, PositionState>();
  const allStockIds = new Set<string>();
  const tradedStockIds = new Set<string>();
  for (const trade of input.trades) allStockIds.add(trade.stockId);
  for (const trade of input.trades) tradedStockIds.add(trade.stockId);
  for (const holding of input.initialHoldings ?? []) allStockIds.add(holding.stockId);
  for (const flow of input.cashFlows) if (flow.stockId !== undefined) allStockIds.add(flow.stockId);
  for (const action of input.corporateActions) allStockIds.add(action.stockId);
  for (const stockId of allStockIds) {
    const holding = input.initialHoldings?.find((item) => item.stockId === stockId);
    positions.set(
      stockId,
      holding !== undefined && !tradedStockIds.has(stockId)
        ? {
            quantity: holding.quantity,
            averageCost: holding.avgCost,
            realizedPnl: 0,
            dividends: 0,
          }
        : { quantity: 0, averageCost: 0, realizedPnl: 0, dividends: 0 },
    );
  }

  const trades = [...input.trades].sort(
    (left, right) =>
      left.executedAt.getTime() - right.executedAt.getTime() || left.id.localeCompare(right.id),
  );
  const flows = [...input.cashFlows].sort(
    (left, right) =>
      left.occurredAt.getTime() - right.occurredAt.getTime() || left.id.localeCompare(right.id),
  );
  const actions = [...input.corporateActions].sort(
    (left, right) =>
      left.occurredAt.getTime() - right.occurredAt.getTime() || left.id.localeCompare(right.id),
  );
  const directHoldingCost = (input.initialHoldings ?? [])
    .filter((holding) => !tradedStockIds.has(holding.stockId))
    .reduce((sum, holding) => sum + holding.quantity * holding.avgCost, 0);
  let cash = input.initialCapital - directHoldingCost;
  let tradeIndex = 0;
  let flowIndex = 0;
  let actionIndex = 0;
  const valuation: PortfolioValuationDay[] = [];
  let previousTotal: number | undefined;
  let cumulativeTwr = 1;
  let peakTwr = 1;
  let anyIncomplete = false;
  let unallocatedDividends = 0;
  let cashCosts = 0;

  for (const date of tradingDays(input.from, input.to)) {
    const dayEnd = date.getTime() + 86_400_000 - 1;
    let externalCashFlow = 0;
    while (
      flowIndex < flows.length &&
      (flows[flowIndex]?.occurredAt.getTime() ?? Infinity) <= dayEnd
    ) {
      const flow = flows[flowIndex];
      if (flow === undefined) break;
      flowIndex += 1;
      const signed = signOfCashFlow(flow.kind) * flow.amount;
      cash += signed;
      if (isExternalCashFlow(flow.kind)) externalCashFlow += signed;
      if (flow.kind === 'fee' || flow.kind === 'tax') cashCosts += flow.amount;
      if (flow.stockId !== undefined && flow.kind === 'dividend') {
        const state = positions.get(flow.stockId) ?? {
          quantity: 0,
          averageCost: 0,
          realizedPnl: 0,
          dividends: 0,
        };
        state.dividends += flow.amount;
        positions.set(flow.stockId, state);
      } else if (flow.kind === 'dividend') {
        unallocatedDividends += flow.amount;
      }
    }
    while (
      actionIndex < actions.length &&
      (actions[actionIndex]?.occurredAt.getTime() ?? Infinity) <= dayEnd
    ) {
      const action = actions[actionIndex];
      if (action === undefined) break;
      actionIndex += 1;
      const state = positions.get(action.stockId) ?? {
        quantity: 0,
        averageCost: 0,
        realizedPnl: 0,
        dividends: 0,
      };
      if ((action.kind === 'split' || action.kind === 'bonus') && action.ratio !== undefined) {
        state.quantity *= action.ratio;
        state.averageCost =
          action.ratio === 0 ? state.averageCost : state.averageCost / action.ratio;
      } else if (action.kind === 'dividend' && action.cashPerShare !== undefined) {
        const dividend = state.quantity * action.cashPerShare;
        cash += dividend;
        state.dividends += dividend;
      }
      positions.set(action.stockId, state);
    }
    while (
      tradeIndex < trades.length &&
      (trades[tradeIndex]?.executedAt.getTime() ?? Infinity) <= dayEnd
    ) {
      const trade = trades[tradeIndex];
      if (trade === undefined) break;
      tradeIndex += 1;
      const state = positions.get(trade.stockId) ?? {
        quantity: 0,
        averageCost: 0,
        realizedPnl: 0,
        dividends: 0,
      };
      const gross = trade.quantity * trade.price;
      if (trade.side === 'buy') {
        cash -= gross + trade.fee;
        state.averageCost =
          (state.averageCost * state.quantity + gross + trade.fee) /
          (state.quantity + trade.quantity);
        state.quantity += trade.quantity;
      } else {
        cash += gross - trade.fee;
        state.realizedPnl += trade.quantity * (trade.price - state.averageCost) - trade.fee;
        state.quantity = Math.max(0, state.quantity - trade.quantity);
        if (state.quantity === 0) state.averageCost = 0;
      }
      positions.set(trade.stockId, state);
    }

    let holdingsValue: number | undefined = 0;
    const missingStockIds: string[] = [];
    for (const [stockId, state] of positions) {
      if (state.quantity <= 0) continue;
      const price = priceAt(input.barsByStock.get(stockId), date);
      if (price === undefined || !Number.isFinite(price) || price <= 0) {
        missingStockIds.push(stockId);
        holdingsValue = undefined;
      } else if (holdingsValue !== undefined) {
        holdingsValue += state.quantity * price;
      }
    }
    const completeness = missingStockIds.length > 0 ? 'partial' : 'complete';
    anyIncomplete ||= completeness !== 'complete';
    const totalValue = holdingsValue === undefined ? undefined : Math.max(0, cash + holdingsValue);
    let twrReturnPct: number | undefined;
    if (
      totalValue !== undefined &&
      previousTotal !== undefined &&
      previousTotal > 0 &&
      completeness === 'complete'
    ) {
      twrReturnPct = ((totalValue - externalCashFlow) / previousTotal - 1) * 100;
      cumulativeTwr *= 1 + twrReturnPct / 100;
      peakTwr = Math.max(peakTwr, cumulativeTwr);
    }
    const drawdownPct = cumulativeTwr === 0 ? -100 : (cumulativeTwr / peakTwr - 1) * 100;
    valuation.push({
      date,
      cash,
      ...(holdingsValue === undefined ? {} : { holdingsValue }),
      ...(totalValue === undefined ? {} : { totalValue }),
      completeness,
      missingStockIds,
      externalCashFlow,
      ...(completeness === 'complete' && twrReturnPct !== undefined ? { twrReturnPct } : {}),
      ...(completeness === 'complete' && previousTotal !== undefined
        ? { cumulativeTwrPct: (cumulativeTwr - 1) * 100 }
        : {}),
      ...(completeness === 'complete' ? { drawdownPct } : {}),
    });
    // 中间有缺价时切断收益计算，后续完整日不能跨越未知估值日计算日收益。
    previousTotal = completeness === 'complete' ? totalValue : undefined;
  }

  const contributions = [...positions.entries()].map(([stockId, state]) => {
    const lastDay = valuation.at(-1);
    const lastPrice = priceAt(input.barsByStock.get(stockId), lastDay?.date ?? input.to);
    const currentValue = lastPrice === undefined ? undefined : state.quantity * lastPrice;
    const unrealizedPnl =
      lastPrice === undefined
        ? undefined
        : (currentValue ?? 0) - state.quantity * state.averageCost;
    return {
      stockId,
      ...(currentValue === undefined ? {} : { currentValue }),
      realizedPnl: state.realizedPnl,
      ...(unrealizedPnl === undefined ? {} : { unrealizedPnl }),
      dividends: state.dividends,
      contribution: state.realizedPnl + (unrealizedPnl ?? 0) + state.dividends,
      completeness: lastPrice === undefined && state.quantity > 0 ? 'unavailable' : 'complete',
    } satisfies PortfolioContribution;
  });
  const realizedPnl = contributions.reduce((sum, item) => sum + item.realizedPnl, 0);
  const hasUnrealized = contributions.every((item) => item.unrealizedPnl !== undefined);
  const unrealizedPnl = hasUnrealized
    ? contributions.reduce((sum, item) => sum + (item.unrealizedPnl ?? 0), 0)
    : undefined;
  const dividendPnl =
    contributions.reduce((sum, item) => sum + item.dividends, 0) + unallocatedDividends;
  const totalPnl =
    unrealizedPnl === undefined ? undefined : realizedPnl + unrealizedPnl + dividendPnl - cashCosts;
  const completeDays = valuation.filter((day) => day.completeness === 'complete');
  const twrDays = completeDays.filter((day) => day.twrReturnPct !== undefined);
  const twrPct =
    twrDays.length === 0 || anyIncomplete ? undefined : (twrDays.at(-1)?.cumulativeTwrPct ?? 0);
  const maxDrawdownPct =
    completeDays.length === 0 || anyIncomplete
      ? undefined
      : Math.min(...completeDays.map((day) => day.drawdownPct ?? 0));
  const benchmarkStatus =
    input.benchmarkBars === undefined
      ? 'unavailable'
      : input.benchmarkBars.length === 0 || valuation.length === 0
        ? 'partial'
        : valuation.every((day) => {
              const price = priceAt(input.benchmarkBars, day.date);
              return price !== undefined && price > 0;
            })
          ? 'available'
          : 'partial';
  const benchmarkPrices =
    input.benchmarkBars === undefined
      ? []
      : valuation
          .map((day) => priceAt(input.benchmarkBars, day.date))
          .filter((price): price is number => price !== undefined && price > 0);
  const benchmarkTwrPct =
    benchmarkStatus === 'available' && benchmarkPrices.length >= 2
      ? ((benchmarkPrices.at(-1) ?? 0) / (benchmarkPrices[0] ?? 1) - 1) * 100
      : undefined;
  const excessTwrPct =
    twrPct === undefined || benchmarkTwrPct === undefined ? undefined : twrPct - benchmarkTwrPct;

  return {
    accountId: input.accountId,
    from: input.from,
    to: input.to,
    currency: input.currency,
    completeness: valuation.length === 0 ? 'unavailable' : anyIncomplete ? 'partial' : 'complete',
    cashFlowComplete: true,
    benchmarkStatus,
    ...(twrPct === undefined ? {} : { twrPct }),
    ...(maxDrawdownPct === undefined ? {} : { maxDrawdownPct }),
    ...(benchmarkTwrPct === undefined ? {} : { benchmarkTwrPct }),
    ...(excessTwrPct === undefined ? {} : { excessTwrPct }),
    realizedPnl,
    ...(unrealizedPnl === undefined ? {} : { unrealizedPnl }),
    ...(totalPnl === undefined ? {} : { totalPnl }),
    valuation,
    contributions:
      contributions.length === 0 ? [...positions.keys()].map(emptyContribution) : contributions,
    warnings: [
      ...(anyIncomplete ? ['部分持仓缺少对应估值日行情，收益指标保持 unavailable'] : []),
      ...(benchmarkStatus !== 'available' ? ['benchmark 日线不可用，未填充替代值'] : []),
      ...(unallocatedDividends > 0
        ? ['存在未关联股票的分红现金流，已计入总 PnL 但无法拆分到持仓']
        : []),
    ],
  };
};
