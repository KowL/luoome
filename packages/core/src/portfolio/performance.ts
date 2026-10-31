import type { Holding } from '../entity/holding.js';
import {
  MIN_TWR_SAMPLE_TRADING_DAYS,
  type PortfolioCashFlow,
  type PortfolioContribution,
  type PortfolioCorporateAction,
  type PortfolioCoverage,
  type PortfolioMetricAvailability,
  type PortfolioPerformance,
  type PortfolioPerformanceMetrics,
  type PortfolioValuationDay,
} from '../entity/portfolio-performance.js';
import type { DailyBar } from '../entity/quote.js';
import type { Trade } from '../entity/trade.js';
import { priceAt, replayAccountLedger, replayDayKey } from './replay.js';

export interface PortfolioPerformanceInput {
  readonly accountId: string;
  readonly currency: string;
  readonly initialCapital: number;
  readonly from: Date;
  readonly to: Date;
  readonly trades: readonly Trade[];
  /** 只有没有对应 Trade 事实的直接录入持仓才作为期初仓位使用。`id` 可选：给了才能归因到 `holding:<id>`。 */
  readonly initialHoldings?: readonly (Pick<Holding, 'stockId' | 'quantity' | 'avgCost'> & {
    readonly id?: string;
  })[];
  readonly cashFlows: readonly PortfolioCashFlow[];
  readonly corporateActions: readonly PortfolioCorporateAction[];
  readonly barsByStock: ReadonlyMap<string, readonly DailyBar[]>;
  readonly benchmarkBars?: readonly DailyBar[];
}

/** 空贡献行：没有任何成交也没有估值的股票仍要出现在归因里（事实为空，不是「零贡献」）。 */
const emptyContribution = (stockId: string): PortfolioContribution => ({
  stockId,
  factIds: [],
  currentValue: 0,
  realizedPnl: 0,
  dividends: 0,
  contribution: 0,
  completeness: 'unavailable',
});

export const calculatePortfolioPerformance = (
  input: PortfolioPerformanceInput,
): PortfolioPerformance => {
  // 逐笔重放只有一份实现（`replay.ts`）：账户层绩效与单条建议归因共用它。
  const replay = replayAccountLedger({
    initialCapital: input.initialCapital,
    from: input.from,
    to: input.to,
    trades: input.trades,
    ...(input.initialHoldings === undefined ? {} : { initialHoldings: input.initialHoldings }),
    cashFlows: input.cashFlows,
    corporateActions: input.corporateActions,
    barsByStock: input.barsByStock,
  });
  const { positions, unallocatedDividends, cashCosts } = replay;
  const facts = {
    add: (stockId: string, factId: string): void => {
      // replay 已记录全部事实；这里只为「最近估值日的日线」补一条（它依赖 lastValuationDate）。
      dynamicFacts.set(stockId, [...(dynamicFacts.get(stockId) ?? []), factId]);
    },
    of: (stockId: string): string[] =>
      [
        ...new Set([...(replay.facts.get(stockId) ?? []), ...(dynamicFacts.get(stockId) ?? [])]),
      ].sort(),
  };
  const dynamicFacts = new Map<string, string[]>();
  let previousTotal: number | undefined;
  let cumulativeTwr = 1;
  let peakTwr = 1;
  let anyIncomplete = false;
  const valuation: PortfolioValuationDay[] = [];
  for (const day of replay.valuation) {
    const completeness = day.completeness;
    const totalValue = day.totalValue;
    anyIncomplete ||= completeness !== 'complete';
    let twrReturnPct: number | undefined;
    if (
      totalValue !== undefined &&
      previousTotal !== undefined &&
      previousTotal > 0 &&
      completeness === 'complete'
    ) {
      twrReturnPct = ((totalValue - day.externalCashFlow) / previousTotal - 1) * 100;
      cumulativeTwr *= 1 + twrReturnPct / 100;
      peakTwr = Math.max(peakTwr, cumulativeTwr);
    }
    const drawdownPct = cumulativeTwr === 0 ? -100 : (cumulativeTwr / peakTwr - 1) * 100;
    valuation.push({
      date: day.date,
      cash: day.cash,
      ...(day.holdingsValue === undefined ? {} : { holdingsValue: day.holdingsValue }),
      ...(totalValue === undefined ? {} : { totalValue }),
      completeness,
      missingStockIds: [...day.missingStockIds],
      externalCashFlow: day.externalCashFlow,
      ...(completeness === 'complete' && twrReturnPct !== undefined ? { twrReturnPct } : {}),
      ...(completeness === 'complete' && previousTotal !== undefined
        ? { cumulativeTwrPct: (cumulativeTwr - 1) * 100 }
        : {}),
      ...(completeness === 'complete' ? { drawdownPct } : {}),
    });
    // 中间有缺价时切断收益计算，后续完整日不能跨越未知估值日计算日收益。
    previousTotal = completeness === 'complete' ? totalValue : undefined;
  }

  const lastValuationDate = valuation.at(-1)?.date ?? input.to;
  const contributions = [...positions.entries()].map(([stockId, state]) => {
    const lastPrice = priceAt(input.barsByStock.get(stockId), lastValuationDate);
    if (lastPrice !== undefined)
      facts.add(stockId, `daily_bar:${stockId}:${replayDayKey(lastValuationDate)}`);
    const currentValue =
      state.quantity <= 0 ? 0 : lastPrice === undefined ? undefined : state.quantity * lastPrice;
    const unrealizedPnl =
      state.quantity <= 0
        ? 0
        : lastPrice === undefined
          ? undefined
          : (currentValue ?? 0) - state.quantity * state.averageCost;
    return {
      stockId,
      factIds: facts.of(stockId),
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
  const gapDates = valuation
    .filter((day) => day.completeness !== 'complete')
    .map((day) => replayDayKey(day.date));
  // 样本 = 完整估值日数。2 天的「TWR」是噪声，样本不足时只报 insufficient。
  const sampleDays = completeDays.length;
  const twrMetric: PortfolioMetricAvailability =
    valuation.length === 0
      ? { status: 'unavailable', reason: 'no-valuation-day' }
      : anyIncomplete
        ? { status: 'unavailable', reason: 'coverage-gap' }
        : twrDays.length === 0
          ? { status: 'unavailable', reason: 'no-return-sample' }
          : sampleDays < MIN_TWR_SAMPLE_TRADING_DAYS
            ? { status: 'insufficient', reason: 'sample-too-small' }
            : { status: 'available' };
  const twrPct =
    twrMetric.status === 'available' ? (twrDays.at(-1)?.cumulativeTwrPct ?? 0) : undefined;
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
  const benchmarkMetric: PortfolioMetricAvailability =
    input.benchmarkBars === undefined
      ? { status: 'unavailable', reason: 'benchmark-not-configured' }
      : valuation.length === 0
        ? { status: 'unavailable', reason: 'no-valuation-day' }
        : benchmarkStatus !== 'available'
          ? { status: 'unavailable', reason: 'benchmark-coverage-gap' }
          : benchmarkPrices.length < MIN_TWR_SAMPLE_TRADING_DAYS
            ? { status: 'insufficient', reason: 'benchmark-sample-too-small' }
            : { status: 'available' };
  const benchmarkTwrPct =
    benchmarkMetric.status === 'available' && benchmarkPrices.length >= 2
      ? ((benchmarkPrices.at(-1) ?? 0) / (benchmarkPrices[0] ?? 1) - 1) * 100
      : undefined;
  const excessMetric: PortfolioMetricAvailability = (() => {
    if (twrMetric.status === 'unavailable')
      return { status: 'unavailable', reason: 'twr-unavailable' };
    if (benchmarkMetric.status === 'unavailable')
      return { status: 'unavailable', reason: 'benchmark-unavailable' };
    if (twrMetric.status === 'insufficient' || benchmarkMetric.status === 'insufficient')
      return { status: 'insufficient', reason: 'sample-too-small' };
    return { status: 'available' };
  })();
  const excessTwrPct =
    twrPct === undefined || benchmarkTwrPct === undefined ? undefined : twrPct - benchmarkTwrPct;
  const coverage: PortfolioCoverage = {
    status: valuation.length === 0 ? 'unavailable' : anyIncomplete ? 'partial' : 'complete',
    expectedTradingDays: valuation.length,
    completeTradingDays: sampleDays,
    missingDates: gapDates,
    sampleDays,
    requiredSampleDays: MIN_TWR_SAMPLE_TRADING_DAYS,
  };
  const metrics: PortfolioPerformanceMetrics = {
    twr: twrMetric,
    benchmarkTwr: benchmarkMetric,
    excessTwr: excessMetric,
  };

  return {
    accountId: input.accountId,
    from: input.from,
    to: input.to,
    currency: input.currency,
    completeness: valuation.length === 0 ? 'unavailable' : anyIncomplete ? 'partial' : 'complete',
    cashFlowComplete: true,
    benchmarkStatus,
    coverage,
    metrics,
    ...(twrPct === undefined ? {} : { twrPct }),
    ...(maxDrawdownPct === undefined ? {} : { maxDrawdownPct }),
    ...(benchmarkTwrPct === undefined ? {} : { benchmarkTwrPct }),
    ...(excessTwrPct === undefined ? {} : { excessTwrPct }),
    realizedPnl,
    ...(unrealizedPnl === undefined ? {} : { unrealizedPnl }),
    ...(totalPnl === undefined ? {} : { totalPnl }),
    valuation,
    contributions:
      contributions.length === 0
        ? [...positions.keys()].map((stockId) => ({
            ...emptyContribution(stockId),
            factIds: facts.of(stockId),
          }))
        : contributions,
    warnings: [
      ...(anyIncomplete ? ['部分持仓缺少对应估值日行情，收益指标保持 unavailable'] : []),
      ...(benchmarkStatus !== 'available' ? ['benchmark 日线不可用，未填充替代值'] : []),
      ...(twrMetric.status === 'insufficient'
        ? [
            `TWR 样本不足：完整估值日 ${String(sampleDays)} < ${String(MIN_TWR_SAMPLE_TRADING_DAYS)}，未给出百分比`,
          ]
        : []),
      ...(benchmarkMetric.status === 'insufficient'
        ? [
            `benchmark 样本不足：有效收盘日 ${String(benchmarkPrices.length)} < ${String(MIN_TWR_SAMPLE_TRADING_DAYS)}，未给出百分比`,
          ]
        : []),
      // 超额收益不给百分比的原因由 `metrics.excessTwr.reason` 机器可读地表达，
      // 不在这里重复一条人话：benchmark 缺失与覆盖缺口已有各自的 warning。
      ...(unallocatedDividends > 0
        ? ['存在未关联股票的分红现金流，已计入总 PnL 但无法拆分到持仓']
        : []),
    ],
  };
};
