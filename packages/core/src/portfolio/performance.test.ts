import { describe, expect, it } from 'vitest';
import { MIN_TWR_SAMPLE_TRADING_DAYS } from '../entity/portfolio-performance.js';
import type { DailyBar } from '../entity/quote.js';
import { money, quantity } from '../types/branded.js';
import { calculatePortfolioPerformance } from './performance.js';

const date = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const bar = (stockId: string, day: string, close: number): DailyBar => ({
  stockId,
  date: date(day),
  open: money(close),
  high: money(close),
  low: money(close),
  close: money(close),
  volume: 1_000,
  adjustment: 'qfq' as const,
  source: 'eastmoney',
});

describe('calculatePortfolioPerformance', () => {
  it('keeps external cash flow out of TWR and calculates realized/unrealized contribution', () => {
    const result = calculatePortfolioPerformance({
      accountId: 'account-1',
      currency: 'CNY',
      initialCapital: 10_000,
      from: date('2026-08-10'),
      to: date('2026-08-11'),
      trades: [
        {
          id: 'trade-1',
          accountId: 'account-1',
          stockId: '600519.SH',
          side: 'buy',
          quantity: quantity(100),
          price: money(50),
          fee: money(10),
          executedAt: date('2026-08-10'),
          source: 'manual',
          createdAt: date('2026-08-10'),
        },
      ],
      cashFlows: [
        {
          id: 'flow-1',
          accountId: 'account-1',
          occurredAt: date('2026-08-11'),
          kind: 'deposit',
          amount: 5_000,
          currency: 'CNY',
          source: 'manual',
          createdAt: date('2026-08-11'),
        },
      ],
      corporateActions: [],
      barsByStock: new Map([
        ['600519.SH', [bar('600519.SH', '2026-08-10', 50), bar('600519.SH', '2026-08-11', 55)]],
      ]),
      benchmarkBars: [bar('000300.SH', '2026-08-10', 100), bar('000300.SH', '2026-08-11', 110)],
    });
    expect(result.completeness).toBe('complete');
    expect(result.valuation[1]?.externalCashFlow).toBe(5_000);
    expect(result.valuation[1]?.totalValue).toBe(15_490);
    expect(result.contributions).toMatchObject([
      { stockId: '600519.SH', unrealizedPnl: 490, contribution: 490 },
    ]);
    // 2 个交易日 = 噪声，不是区间收益：只报 insufficient，不给百分比。
    expect(result.metrics).toEqual({
      twr: { status: 'insufficient', reason: 'sample-too-small' },
      benchmarkTwr: { status: 'insufficient', reason: 'benchmark-sample-too-small' },
      excessTwr: { status: 'insufficient', reason: 'sample-too-small' },
    });
    expect(result.twrPct).toBeUndefined();
    expect(result.benchmarkTwrPct).toBeUndefined();
    expect(result.excessTwrPct).toBeUndefined();
    expect(result.coverage).toEqual({
      status: 'complete',
      expectedTradingDays: 2,
      completeTradingDays: 2,
      missingDates: [],
      sampleDays: 2,
      requiredSampleDays: MIN_TWR_SAMPLE_TRADING_DAYS,
    });
    expect(result.warnings).toContain(
      `TWR 样本不足：完整估值日 2 < ${String(MIN_TWR_SAMPLE_TRADING_DAYS)}，未给出百分比`,
    );
    // 日收益仍是事实（逐日明细照常输出），被拦住的只是区间汇总口径。
    expect(result.valuation[1]?.twrReturnPct).toBeCloseTo(5.005005005, 8);
  });

  it('does not fill missing prices with zero and applies split ratio to quantity/cost', () => {
    const result = calculatePortfolioPerformance({
      accountId: 'account-1',
      currency: 'CNY',
      initialCapital: 1_000,
      from: date('2026-08-10'),
      to: date('2026-08-11'),
      trades: [
        {
          id: 'trade-1',
          accountId: 'account-1',
          stockId: '600519.SH',
          side: 'buy',
          quantity: quantity(10),
          price: money(50),
          fee: money(0),
          executedAt: date('2026-08-10'),
          source: 'manual',
          createdAt: date('2026-08-10'),
        },
      ],
      cashFlows: [],
      corporateActions: [
        {
          id: 'action-1',
          accountId: 'account-1',
          stockId: '600519.SH',
          occurredAt: date('2026-08-11'),
          kind: 'split',
          ratio: 2,
          source: 'manual',
          createdAt: date('2026-08-11'),
        },
      ],
      barsByStock: new Map([['600519.SH', [bar('600519.SH', '2026-08-10', 50)]]]),
    });
    expect(result.valuation[1]?.completeness).toBe('partial');
    expect(result.valuation[1]?.missingStockIds).toEqual(['600519.SH']);
    expect(result.valuation[1]?.holdingsValue).toBeUndefined();
    expect(result.valuation[1]?.totalValue).toBeUndefined();
    expect(result.valuation[1]?.drawdownPct).toBeUndefined();
    expect(result.contributions[0]).toMatchObject({
      stockId: '600519.SH',
      completeness: 'unavailable',
    });
    expect(result.contributions[0]?.currentValue).toBeUndefined();
    expect(result.twrPct).toBeUndefined();
  });

  it('只把入金/出金/转账排除在 TWR 外，分红与费用仍影响投资收益', () => {
    const result = calculatePortfolioPerformance({
      accountId: 'account-1',
      currency: 'CNY',
      initialCapital: 1_000,
      from: date('2026-08-10'),
      to: date('2026-08-11'),
      trades: [],
      cashFlows: [
        {
          id: 'dividend-1',
          accountId: 'account-1',
          occurredAt: date('2026-08-11'),
          kind: 'dividend',
          amount: 20,
          currency: 'CNY',
          source: 'import',
          createdAt: date('2026-08-11'),
        },
        {
          id: 'fee-1',
          accountId: 'account-1',
          occurredAt: date('2026-08-11'),
          kind: 'fee',
          amount: 5,
          currency: 'CNY',
          source: 'import',
          createdAt: date('2026-08-11'),
        },
      ],
      corporateActions: [],
      barsByStock: new Map(),
    });
    expect(result.valuation[1]?.externalCashFlow).toBe(0);
    expect(result.valuation[1]?.twrReturnPct).toBeCloseTo(1.5, 8);
    expect(result.twrPct).toBeUndefined();
    expect(result.metrics?.twr).toEqual({ status: 'insufficient', reason: 'sample-too-small' });
    expect(result.totalPnl).toBe(15);
    expect(result.warnings).toContain('存在未关联股票的分红现金流，已计入总 PnL 但无法拆分到持仓');
  });

  it('supports directly recorded holdings when no trade fact exists', () => {
    const result = calculatePortfolioPerformance({
      accountId: 'account-1',
      currency: 'CNY',
      initialCapital: 1_000,
      from: date('2026-08-10'),
      to: date('2026-08-10'),
      trades: [],
      initialHoldings: [{ stockId: '600519.SH', quantity: 10, avgCost: money(50) }],
      cashFlows: [],
      corporateActions: [],
      barsByStock: new Map([['600519.SH', [bar('600519.SH', '2026-08-10', 55)]]]),
    });
    expect(result.valuation[0]?.cash).toBe(500);
    expect(result.valuation[0]?.holdingsValue).toBe(550);
    expect(result.valuation[0]?.totalValue).toBe(1_050);
  });

  it('keeps total PnL available for a closed position without an ending quote', () => {
    const result = calculatePortfolioPerformance({
      accountId: 'account-1',
      currency: 'CNY',
      initialCapital: 1_000,
      from: date('2026-08-10'),
      to: date('2026-08-11'),
      trades: [
        {
          id: 'buy-1',
          accountId: 'account-1',
          stockId: '600519.SH',
          side: 'buy',
          quantity: quantity(1),
          price: money(100),
          fee: money(0),
          executedAt: date('2026-08-10'),
          source: 'manual',
          createdAt: date('2026-08-10'),
        },
        {
          id: 'sell-1',
          accountId: 'account-1',
          stockId: '600519.SH',
          side: 'sell',
          quantity: quantity(1),
          price: money(110),
          fee: money(0),
          executedAt: date('2026-08-10'),
          source: 'manual',
          createdAt: date('2026-08-10'),
        },
      ],
      cashFlows: [],
      corporateActions: [],
      barsByStock: new Map(),
    });

    expect(result.completeness).toBe('complete');
    expect(result.realizedPnl).toBe(10);
    expect(result.unrealizedPnl).toBe(0);
    expect(result.totalPnl).toBe(10);
    expect(result.contributions[0]).toMatchObject({
      stockId: '600519.SH',
      currentValue: 0,
      unrealizedPnl: 0,
      completeness: 'complete',
    });
  });

  // 2026-08 的 20 个交易日：样本刚好达到 MIN_TWR_SAMPLE_TRADING_DAYS。
  const twentyTradingDays = [
    '2026-08-03',
    '2026-08-04',
    '2026-08-05',
    '2026-08-06',
    '2026-08-07',
    '2026-08-10',
    '2026-08-11',
    '2026-08-12',
    '2026-08-13',
    '2026-08-14',
    '2026-08-17',
    '2026-08-18',
    '2026-08-19',
    '2026-08-20',
    '2026-08-21',
    '2026-08-24',
    '2026-08-25',
    '2026-08-26',
    '2026-08-27',
    '2026-08-28',
  ] as const;

  const series = (
    stockId: string,
    days: readonly string[],
    closeAt: (day: string, index: number) => number,
  ): DailyBar[] => days.map((day, index) => bar(stockId, day, closeAt(day, index)));

  it('样本达标时给出 TWR / 基准 TWR / 超额，并把归因指回事实 id', () => {
    const result = calculatePortfolioPerformance({
      accountId: 'account-1',
      currency: 'CNY',
      initialCapital: 10_000,
      from: date('2026-08-03'),
      to: date('2026-08-28'),
      trades: [
        {
          id: 'trade-1',
          accountId: 'account-1',
          stockId: '600519.SH',
          side: 'buy',
          quantity: quantity(100),
          price: money(50),
          fee: money(0),
          executedAt: date('2026-08-03'),
          source: 'manual',
          createdAt: date('2026-08-03'),
        },
      ],
      cashFlows: [],
      corporateActions: [],
      barsByStock: new Map([
        [
          '600519.SH',
          series('600519.SH', twentyTradingDays, (_day, index) => (index === 19 ? 55 : 50)),
        ],
      ]),
      benchmarkBars: series('000300.SH', twentyTradingDays, (_day, index) =>
        index === 19 ? 102 : 100,
      ),
    });

    expect(result.valuation).toHaveLength(20);
    expect(result.coverage).toEqual({
      status: 'complete',
      expectedTradingDays: 20,
      completeTradingDays: 20,
      missingDates: [],
      sampleDays: 20,
      requiredSampleDays: MIN_TWR_SAMPLE_TRADING_DAYS,
    });
    expect(result.metrics).toEqual({
      twr: { status: 'available' },
      benchmarkTwr: { status: 'available' },
      excessTwr: { status: 'available' },
    });
    // 20 天只有最后一天从 50 涨到 55：TWR = 5%，基准 100→102 = 2%，超额 3%。
    expect(result.twrPct).toBeCloseTo(5, 8);
    expect(result.benchmarkTwrPct).toBeCloseTo(2, 8);
    expect(result.excessTwrPct).toBeCloseTo(3, 8);
    expect(result.contributions[0]?.factIds).toEqual([
      'daily_bar:600519.SH:2026-08-28',
      'trade:trade-1',
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('缺价日只进 missingDates 与 unavailable，不填 0 也不给百分比', () => {
    const result = calculatePortfolioPerformance({
      accountId: 'account-1',
      currency: 'CNY',
      initialCapital: 10_000,
      from: date('2026-08-03'),
      to: date('2026-08-28'),
      trades: [
        {
          id: 'trade-1',
          accountId: 'account-1',
          stockId: '600519.SH',
          side: 'buy',
          quantity: quantity(100),
          price: money(50),
          fee: money(0),
          executedAt: date('2026-08-03'),
          source: 'manual',
          createdAt: date('2026-08-03'),
        },
      ],
      cashFlows: [],
      corporateActions: [],
      barsByStock: new Map([
        [
          '600519.SH',
          series('600519.SH', twentyTradingDays, (_day, index) => (index === 19 ? 55 : 50)).filter(
            (item) => item.date.getTime() !== date('2026-08-07').getTime(),
          ),
        ],
      ]),
      benchmarkBars: series('000300.SH', twentyTradingDays, () => 100),
    });

    expect(result.coverage).toMatchObject({
      status: 'partial',
      expectedTradingDays: 20,
      completeTradingDays: 19,
      missingDates: ['2026-08-07'],
      sampleDays: 19,
    });
    expect(result.metrics?.twr).toEqual({ status: 'unavailable', reason: 'coverage-gap' });
    expect(result.metrics?.excessTwr).toEqual({ status: 'unavailable', reason: 'twr-unavailable' });
    expect(result.twrPct).toBeUndefined();
    expect(result.excessTwrPct).toBeUndefined();
    const gapDay = result.valuation.find(
      (day) => day.date.getTime() === date('2026-08-07').getTime(),
    );
    expect(gapDay?.totalValue).toBeUndefined();
    expect(gapDay?.missingStockIds).toEqual(['600519.SH']);
    expect(result.warnings).toContain('部分持仓缺少对应估值日行情，收益指标保持 unavailable');
  });

  it('基准缺失时超额收益 unavailable 并给原因，不填 0', () => {
    const result = calculatePortfolioPerformance({
      accountId: 'account-1',
      currency: 'CNY',
      initialCapital: 10_000,
      from: date('2026-08-03'),
      to: date('2026-08-28'),
      trades: [
        {
          id: 'trade-1',
          accountId: 'account-1',
          stockId: '600519.SH',
          side: 'buy',
          quantity: quantity(100),
          price: money(50),
          fee: money(0),
          executedAt: date('2026-08-03'),
          source: 'manual',
          createdAt: date('2026-08-03'),
        },
      ],
      cashFlows: [],
      corporateActions: [],
      barsByStock: new Map([
        [
          '600519.SH',
          series('600519.SH', twentyTradingDays, (_day, index) => (index === 19 ? 55 : 50)),
        ],
      ]),
    });

    expect(result.metrics).toEqual({
      twr: { status: 'available' },
      benchmarkTwr: { status: 'unavailable', reason: 'benchmark-not-configured' },
      excessTwr: { status: 'unavailable', reason: 'benchmark-unavailable' },
    });
    expect(result.twrPct).toBeCloseTo(5, 8);
    expect(result.benchmarkTwrPct).toBeUndefined();
    expect(result.excessTwrPct).toBeUndefined();
    expect(result.warnings).toContain('benchmark 日线不可用，未填充替代值');
  });
});
