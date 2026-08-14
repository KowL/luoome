import { describe, expect, it } from 'vitest';
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
    expect(result.twrPct).toBeCloseTo(5.005005005, 8);
    expect(result.benchmarkStatus).toBe('available');
    expect(result.benchmarkTwrPct).toBeCloseTo(10, 8);
    expect(result.excessTwrPct).toBeCloseTo(-4.994994995, 8);
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
    expect(result.twrPct).toBeCloseTo(1.5, 8);
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
});
