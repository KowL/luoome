import {
  STRICT_BACKTEST_MODEL_VERSION,
  type StrictBacktestMarketFact,
  type StrictBacktestMetrics,
  type StrictBacktestSpec,
  type StrictBacktestTrade,
} from '../entity/strategy-backtest.js';
import { InvariantError } from '../error/index.js';

export interface StrictBacktestTargetDay {
  readonly date: Date;
  readonly stockIds: readonly string[];
}

export interface RunStrictBacktestInput {
  readonly spec: StrictBacktestSpec;
  readonly targets: readonly StrictBacktestTargetDay[];
  readonly marketFacts: readonly StrictBacktestMarketFact[];
  readonly benchmarkFacts: readonly StrictBacktestMarketFact[];
}

interface Position {
  stockId: string;
  quantity: number;
}

const keyOf = (stockId: string, date: Date): string => `${stockId}\0${date.toISOString()}`;

const commission = (notional: number, spec: StrictBacktestSpec): number =>
  Math.max(spec.fees.minimumCommission, (notional * spec.fees.commissionBps) / 10_000);

const tradeFee = (side: 'buy' | 'sell', notional: number, spec: StrictBacktestSpec): number =>
  commission(notional, spec) +
  (side === 'sell' ? (notional * spec.fees.sellStampDutyBps) / 10_000 : 0);

const applyCorporateActions = (
  positions: Map<string, Position>,
  facts: readonly StrictBacktestMarketFact[],
  cash: number,
): number => {
  let nextCash = cash;
  for (const fact of facts) {
    const position = positions.get(fact.stockId);
    if (position === undefined) continue;
    for (const action of fact.corporateActions) {
      if (action.kind === 'split') {
        position.quantity = Math.floor(position.quantity * action.ratio);
      } else {
        nextCash += position.quantity * action.cashPerShare;
      }
    }
  }
  return nextCash;
};

export const runStrictBacktest = (input: RunStrictBacktestInput): StrictBacktestMetrics => {
  if (input.targets.length === 0) throw new InvariantError('strict backtest 至少需要一个执行日');
  const targetDays = [...input.targets].sort((a, b) => a.date.getTime() - b.date.getTime());
  const factByKey = new Map(
    input.marketFacts.map((fact) => [keyOf(fact.stockId, fact.date), fact]),
  );
  const benchmarkByDate = new Map(
    input.benchmarkFacts.map((fact) => [fact.date.toISOString(), fact]),
  );
  const positions = new Map<string, Position>();
  const trades: StrictBacktestTrade[] = [];
  const equityCurve: StrictBacktestMetrics['equityCurve'][number][] = [];
  let cash = input.spec.initialCash;
  let grossNotional = 0;

  for (const targetDay of targetDays) {
    const stockIds = [...new Set(targetDay.stockIds)]
      .sort()
      .slice(0, input.spec.execution.maxPositions);
    const dayFacts = input.marketFacts.filter(
      (fact) => fact.date.getTime() === targetDay.date.getTime(),
    );
    cash = applyCorporateActions(positions, dayFacts, cash);

    for (const position of [...positions.values()].sort((a, b) =>
      a.stockId.localeCompare(b.stockId),
    )) {
      const fact = factByKey.get(keyOf(position.stockId, targetDay.date));
      if (fact === undefined) throw new InvariantError(`缺少市场事实: ${position.stockId}`);
      if (!fact.sellAllowed) continue;
      const executionPrice = fact.rawOpen * (1 - input.spec.slippage.sellBps / 10_000);
      const notional = executionPrice * position.quantity;
      const fees = tradeFee('sell', notional, input.spec);
      cash += notional - fees;
      grossNotional += notional;
      trades.push({
        date: targetDay.date,
        stockId: position.stockId,
        side: 'sell',
        quantity: position.quantity,
        executionPrice,
        notional,
        fees,
      });
      positions.delete(position.stockId);
    }

    const eligible = stockIds.filter((stockId) => {
      const fact = factByKey.get(keyOf(stockId, targetDay.date));
      if (fact === undefined) throw new InvariantError(`缺少市场事实: ${stockId}`);
      return fact.buyAllowed && !positions.has(stockId);
    });
    for (let index = 0; index < eligible.length; index += 1) {
      const stockId = eligible[index];
      if (stockId === undefined) continue;
      const fact = factByKey.get(keyOf(stockId, targetDay.date));
      if (fact === undefined) throw new InvariantError(`缺少市场事实: ${stockId}`);
      const remaining = eligible.length - index;
      const budget = cash / remaining;
      const executionPrice = fact.rawOpen * (1 + input.spec.slippage.buyBps / 10_000);
      let quantity =
        Math.floor(budget / executionPrice / input.spec.execution.lotSize) *
        input.spec.execution.lotSize;
      while (quantity > 0) {
        const notional = executionPrice * quantity;
        if (notional + tradeFee('buy', notional, input.spec) <= cash) break;
        quantity -= input.spec.execution.lotSize;
      }
      if (quantity <= 0) continue;
      const notional = executionPrice * quantity;
      const fees = tradeFee('buy', notional, input.spec);
      cash -= notional + fees;
      grossNotional += notional;
      positions.set(stockId, { stockId, quantity });
      trades.push({
        date: targetDay.date,
        stockId,
        side: 'buy',
        quantity,
        executionPrice,
        notional,
        fees,
      });
    }

    let equity = cash;
    for (const position of positions.values()) {
      const fact = factByKey.get(keyOf(position.stockId, targetDay.date));
      if (fact === undefined) throw new InvariantError(`缺少收盘估值事实: ${position.stockId}`);
      equity += position.quantity * fact.rawClose;
    }
    equityCurve.push({ date: targetDay.date, equity, cash });
  }

  let peak = input.spec.initialCash;
  let maxDrawdownPct = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - point.equity) / peak) * 100);
  }
  const firstDate = targetDays[0]?.date;
  const lastDate = targetDays.at(-1)?.date;
  const firstBenchmark =
    firstDate === undefined ? undefined : benchmarkByDate.get(firstDate.toISOString());
  const lastBenchmark =
    lastDate === undefined ? undefined : benchmarkByDate.get(lastDate.toISOString());
  if (firstBenchmark === undefined || lastBenchmark === undefined) {
    throw new InvariantError('benchmark 事实不完整');
  }
  const finalEquity = equityCurve.at(-1)?.equity ?? input.spec.initialCash;
  const netReturnPct = (finalEquity / input.spec.initialCash - 1) * 100;
  const benchmarkReturnPct = (lastBenchmark.rawClose / firstBenchmark.rawOpen - 1) * 100;
  return {
    modelVersion: STRICT_BACKTEST_MODEL_VERSION,
    initialEquity: input.spec.initialCash,
    finalEquity,
    netReturnPct,
    maxDrawdownPct,
    benchmarkReturnPct,
    excessReturnPct: netReturnPct - benchmarkReturnPct,
    turnoverPct: (grossNotional / input.spec.initialCash) * 100,
    tradeCount: trades.length,
    equityCurve,
    trades,
  };
};
