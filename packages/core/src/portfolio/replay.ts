import type { Holding } from '../entity/holding.js';
import type {
  PortfolioCashFlow,
  PortfolioCorporateAction,
  PortfolioValuationDay,
} from '../entity/portfolio-performance.js';
import type { DailyBar } from '../entity/quote.js';
import type { Trade } from '../entity/trade.js';
import { isHoliday, isWeekend } from '../trading-calendar.js';

/**
 * 「逐笔重放基座」（REQ-M3-14 / S1）。
 *
 * `calculatePortfolioPerformance` 与单条建议归因**必须共用同一套账本重放**：
 * 两个实现各写一遍，迟早会出现「同一个盈亏在两个页面不一样」——那是 M3b-3 抓到过的
 * 同一类错误。这里把「按交易日推进、逐笔吃成交/现金流/公司行动、逐日估值」抽出来，
 * 上层（账户层绩效、单条归因）只消费它产出的状态。
 *
 * **纯函数、零 IO**：只吃事实，不读仓储、不读时钟。
 */

export interface ReplayPositionState {
  quantity: number;
  averageCost: number;
  realizedPnl: number;
  dividends: number;
}

export interface ReplayInput {
  readonly initialCapital: number;
  readonly from: Date;
  readonly to: Date;
  readonly trades: readonly Trade[];
  /** 只有没有对应 Trade 事实的直接录入持仓才作为期初仓位使用。 */
  readonly initialHoldings?: readonly (Pick<Holding, 'stockId' | 'quantity' | 'avgCost'> & {
    readonly id?: string;
  })[];
  readonly cashFlows: readonly PortfolioCashFlow[];
  readonly corporateActions: readonly PortfolioCorporateAction[];
  readonly barsByStock: ReadonlyMap<string, readonly DailyBar[]>;
}

export interface ReplayResult {
  /** 期末逐股状态（与 `calculatePortfolioPerformance` 的 `positions` 同口径）。 */
  readonly positions: ReadonlyMap<string, ReplayPositionState>;
  /** 逐日估值，除 TWR / 回撤外的全部字段（那两项由调用方按自己的口径算）。 */
  readonly valuation: readonly ReplayValuationDay[];
  /** 归因事实索引：`stockId → fact id[]`（含 `holding:` / `trade:` / `cash-flow:` / `corporate-action:` / `daily_bar:`）。 */
  readonly facts: ReadonlyMap<string, readonly string[]>;
  readonly unallocatedDividends: number;
  readonly cashCosts: number;
  /** 期初即作为仓位使用（无对应成交）的股票。 */
  readonly initialHoldingStockIds: readonly string[];
}

/** 逐日估值（不含 TWR / 回撤：不同消费方口径不同，留给上层算）。 */
export interface ReplayValuationDay {
  readonly date: Date;
  readonly cash: number;
  readonly holdingsValue?: number;
  readonly totalValue?: number;
  readonly completeness: PortfolioValuationDay['completeness'];
  readonly missingStockIds: readonly string[];
  readonly externalCashFlow: number;
}

const dayKey = (date: Date): string => date.toISOString().slice(0, 10);

/** 现金流对现金余额的符号：入金/分红/转入为正，其余为负。 */
export const signOfCashFlow = (kind: PortfolioCashFlow['kind']): number =>
  kind === 'deposit' || kind === 'dividend' || kind === 'transfer-in' ? 1 : -1;

/** 是否为外部现金流（计入 TWR 分母调整；分红/费用/税不算）。 */
export const isExternalCashFlow = (kind: PortfolioCashFlow['kind']): boolean =>
  kind === 'deposit' || kind === 'withdrawal' || kind === 'transfer-in' || kind === 'transfer-out';

export const tradingDays = (from: Date, to: Date): Date[] => {
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

export const priceAt = (bars: readonly DailyBar[] | undefined, date: Date): number | undefined => {
  if (bars === undefined) return undefined;
  const key = dayKey(date);
  const bar = bars.find((item) => dayKey(item.date) === key);
  return bar?.close;
};

/**
 * 逐笔重放账本。
 *
 * 行为与抽取前的 `calculatePortfolioPerformance` **逐字一致**：
 * 期初持仓判定、排序键、现金流/公司行动/成交的吸收顺序、缺价时 `holdingsValue = undefined`
 * 的传播、`averageCost = 0` 的清零规则都保持原样。
 */
export const replayAccountLedger = (input: ReplayInput): ReplayResult => {
  const positions = new Map<string, ReplayPositionState>();
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

  const factIndex = new Map<string, Set<string>>();
  const addFact = (stockId: string, factId: string): void => {
    const facts = factIndex.get(stockId) ?? new Set<string>();
    facts.add(factId);
    factIndex.set(stockId, facts);
  };
  const initialHoldingStockIds: string[] = [];
  for (const holding of input.initialHoldings ?? []) {
    // 只有真正作为期初仓位使用的直接录入持仓才参与归因；有成交事实时仓位由成交重建。
    if (holding.id === undefined || tradedStockIds.has(holding.stockId)) continue;
    addFact(holding.stockId, `holding:${holding.id}`);
    initialHoldingStockIds.push(holding.stockId);
  }
  const directHoldingCost = (input.initialHoldings ?? [])
    .filter((holding) => !tradedStockIds.has(holding.stockId))
    .reduce((sum, holding) => sum + holding.quantity * holding.avgCost, 0);

  let cash = input.initialCapital - directHoldingCost;
  let tradeIndex = 0;
  let flowIndex = 0;
  let actionIndex = 0;
  const valuation: ReplayValuationDay[] = [];
  let unallocatedDividends = 0;
  let cashCosts = 0;

  const stateOf = (stockId: string): ReplayPositionState => {
    const existing = positions.get(stockId);
    if (existing !== undefined) return existing;
    const created: ReplayPositionState = {
      quantity: 0,
      averageCost: 0,
      realizedPnl: 0,
      dividends: 0,
    };
    positions.set(stockId, created);
    return created;
  };

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
        const state = stateOf(flow.stockId);
        state.dividends += flow.amount;
        addFact(flow.stockId, `cash-flow:${flow.id}`);
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
      const state = stateOf(action.stockId);
      if ((action.kind === 'split' || action.kind === 'bonus') && action.ratio !== undefined) {
        state.quantity *= action.ratio;
        state.averageCost =
          action.ratio === 0 ? state.averageCost : state.averageCost / action.ratio;
      } else if (action.kind === 'dividend' && action.cashPerShare !== undefined) {
        const dividend = state.quantity * action.cashPerShare;
        cash += dividend;
        state.dividends += dividend;
      }
      addFact(action.stockId, `corporate-action:${action.id}`);
    }
    while (
      tradeIndex < trades.length &&
      (trades[tradeIndex]?.executedAt.getTime() ?? Infinity) <= dayEnd
    ) {
      const trade = trades[tradeIndex];
      if (trade === undefined) break;
      tradeIndex += 1;
      const state = stateOf(trade.stockId);
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
      addFact(trade.stockId, `trade:${trade.id}`);
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
    const totalValue = holdingsValue === undefined ? undefined : Math.max(0, cash + holdingsValue);
    valuation.push({
      date,
      cash,
      ...(holdingsValue === undefined ? {} : { holdingsValue }),
      ...(totalValue === undefined ? {} : { totalValue }),
      completeness,
      missingStockIds,
      externalCashFlow,
    });
  }

  const facts = new Map<string, readonly string[]>(
    [...factIndex.entries()].map(([stockId, ids]) => [stockId, [...ids].sort()]),
  );
  return {
    positions,
    valuation,
    facts,
    unallocatedDividends,
    cashCosts,
    initialHoldingStockIds,
  };
};

/** 最近一个估值日的最后一价（归因里算浮动盈亏用）；与重放同一份 `priceAt`。 */
export const lastValuationPrice = (
  bars: readonly DailyBar[] | undefined,
  lastValuationDate: Date,
): number | undefined => priceAt(bars, lastValuationDate);

export { dayKey as replayDayKey };
