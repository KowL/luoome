import { describe, expect, it } from 'vitest';

import type { Account } from '../entity/account.js';
import type { Holding } from '../entity/holding.js';
import type { PortfolioCashFlow } from '../entity/portfolio-performance.js';
import type { Trade } from '../entity/trade.js';
import { InvariantError } from '../error/index.js';
import { money, quantity } from '../types/branded.js';
import {
  accountFactsDigest,
  applyCashDelta,
  cashImpactOfCashFlow,
  cashImpactOfHoldingChange,
  cashImpactOfTrade,
  ledgerCoverage,
  recomputeCashFromLedger,
  reconcileCashBalance,
} from './ledger.js';

const T0 = new Date('2026-09-15T02:00:00.000Z');

const makeAccount = (cashBalance: number): Account => ({
  id: 'acc-1',
  name: '主账户',
  kind: 'real',
  currency: 'CNY',
  initialCapital: money(1_000_000),
  cashBalance: money(cashBalance),
  createdAt: T0,
});

const holding = (input: {
  stockId: string;
  quantity: number;
  avgCost: number;
  closed?: boolean;
}): Holding => ({
  id: `holding-${input.stockId}`,
  accountId: 'acc-1',
  stockId: input.stockId,
  quantity: input.quantity,
  availableQuantity: input.quantity,
  avgCost: money(input.avgCost),
  openedAt: T0,
  closedAt: input.closed === true ? T0 : null,
});

const trade = (input: {
  stockId: string;
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
}): Trade => ({
  id: `trade-${input.stockId}-${input.side}-${input.quantity}`,
  accountId: 'acc-1',
  stockId: input.stockId,
  side: input.side,
  quantity: quantity(input.quantity),
  price: money(input.price),
  fee: money(0),
  executedAt: T0,
  source: 'manual',
  createdAt: T0,
});

const flow = (kind: PortfolioCashFlow['kind'], amount: number): PortfolioCashFlow => ({
  id: `flow-${kind}-${amount}`,
  accountId: 'acc-1',
  occurredAt: T0,
  kind,
  amount,
  currency: 'CNY',
  source: 'manual',
  createdAt: T0,
});

describe('现金与账本口径', () => {
  it('产品示例：100 万账户买入 10 万，现金变 90 万', () => {
    const impact = cashImpactOfTrade({ side: 'buy', quantity: quantity(10_000), price: money(10) });
    expect(impact).toBe(-100_000);
    expect(applyCashDelta(money(1_000_000), impact)).toBe(900_000);
  });

  it('买卖按数量 × 成交价增减，不计手续费', () => {
    expect(cashImpactOfTrade({ side: 'sell', quantity: quantity(1000), price: money(98.5) })).toBe(
      98_500,
    );
  });

  it('持仓改动按成本差额结算现金（登记/加仓扣、减仓/平仓回补）', () => {
    const none = null;
    const bought = holding({ stockId: '600519.SH', quantity: 100, avgCost: 1450 });
    expect(cashImpactOfHoldingChange(none, bought)).toBe(-145_000);
    const added = holding({ stockId: '600519.SH', quantity: 150, avgCost: 1450 });
    expect(cashImpactOfHoldingChange(bought, added)).toBe(-72_500);
    const reduced = holding({ stockId: '600519.SH', quantity: 50, avgCost: 1450 });
    expect(cashImpactOfHoldingChange(added, reduced)).toBe(145_000);
    const closed = holding({ stockId: '600519.SH', quantity: 100, avgCost: 1450, closed: true });
    expect(cashImpactOfHoldingChange(bought, closed)).toBe(145_000);
  });

  it('资金流水：入金/转入/分红为正，出金/转出/费用/税为负', () => {
    expect(cashImpactOfCashFlow(flow('deposit', 50_000))).toBe(50_000);
    expect(cashImpactOfCashFlow(flow('dividend', 1_200))).toBe(1_200);
    expect(cashImpactOfCashFlow(flow('withdrawal', 30_000))).toBe(-30_000);
    expect(cashImpactOfCashFlow(flow('fee', 5))).toBe(-5);
  });

  it('现金不允许为负：超买时要求先纠错', () => {
    expect(() => applyCashDelta(money(5_000), money(-10_000))).toThrow(InvariantError);
    expect(() => applyCashDelta(money(5_000), money(-10_000))).toThrow(/现金余额不足/);
  });
});

describe('账本覆盖与对账', () => {
  it('交易完整体现持仓时没有缺口', () => {
    const hold = holding({ stockId: '600519.SH', quantity: 100, avgCost: 1450 });
    const buy = trade({ stockId: '600519.SH', side: 'buy', quantity: 100, price: 1450 });
    expect(ledgerCoverage({ holdings: [hold], trades: [buy] })).toEqual([
      {
        stockId: '600519.SH',
        holdingQuantity: 100,
        tradedQuantity: 100,
        uncoveredQuantity: 0,
        unmatchedTradeQuantity: 0,
        oversoldQuantity: 0,
      },
    ]);
  });

  it('直接登记的持仓（无交易记录）按成本补扣现金', () => {
    const hold = holding({ stockId: '000001.SZ', quantity: 1000, avgCost: 12 });
    const replay = recomputeCashFromLedger({
      account: makeAccount(0),
      holdings: [hold],
      trades: [],
      cashFlows: [],
    });
    expect(replay).toBe(988_000);
    expect(ledgerCoverage({ holdings: [hold], trades: [] })[0]?.uncoveredQuantity).toBe(1000);
  });

  it('持仓多于交易净额时按成本补扣，缺口显式列出', () => {
    const hold = holding({ stockId: '600519.SH', quantity: 100, avgCost: 1450 });
    const trades = [
      trade({ stockId: '600519.SH', side: 'buy', quantity: 100, price: 1450 }),
      trade({ stockId: '600519.SH', side: 'sell', quantity: 100, price: 1500 }),
    ];
    // 买卖轧差为 0，但持仓仍记 100：多出的持仓按成本补扣（直接登记或漏记买入）
    const replay = recomputeCashFromLedger({
      account: makeAccount(0),
      holdings: [hold],
      trades,
      cashFlows: [],
    });
    expect(replay).toBe(1_000_000 - 145_000 + 150_000 - 145_000);
    expect(ledgerCoverage({ holdings: [hold], trades })[0]).toMatchObject({
      holdingQuantity: 100,
      tradedQuantity: 0,
      uncoveredQuantity: 100,
      unmatchedTradeQuantity: 0,
      oversoldQuantity: 0,
    });
    const result = reconcileCashBalance(makeAccount(1_000_000), {
      account: makeAccount(0),
      holdings: [hold],
      trades,
      cashFlows: [],
    });
    expect(result.reconciled).toBe(false);
    expect(result.difference).toBe(1_000_000 - replay);
    expect(result.gaps).toHaveLength(1);
  });

  it('净卖出超过持仓时现金偏高，同样列为缺口', () => {
    const trades = [
      trade({ stockId: '600519.SH', side: 'buy', quantity: 100, price: 1450 }),
      trade({ stockId: '600519.SH', side: 'sell', quantity: 200, price: 1500 }),
    ];
    const replay = recomputeCashFromLedger({
      account: makeAccount(0),
      holdings: [],
      trades,
      cashFlows: [],
    });
    expect(replay).toBe(1_000_000 - 145_000 + 300_000);
    expect(ledgerCoverage({ holdings: [], trades })[0]).toMatchObject({
      holdingQuantity: 0,
      tradedQuantity: -100,
      uncoveredQuantity: 0,
      unmatchedTradeQuantity: 0,
      oversoldQuantity: 100,
    });
  });

  it('字段与账本一致时对账差额为 0', () => {
    const hold = holding({ stockId: '600519.SH', quantity: 100, avgCost: 1450 });
    const trades = [trade({ stockId: '600519.SH', side: 'buy', quantity: 100, price: 1450 })];
    const stored = recomputeCashFromLedger({
      account: makeAccount(0),
      holdings: [hold],
      trades,
      cashFlows: [],
    });
    const result = reconcileCashBalance(makeAccount(stored), {
      account: makeAccount(0),
      holdings: [hold],
      trades,
      cashFlows: [],
    });
    expect(result.reconciled).toBe(true);
    expect(result.difference).toBe(0);
    expect(result.gaps).toEqual([]);
  });
});

describe('账户事实指纹', () => {
  it('持仓或现金变化都会改变指纹，平仓也算变化', () => {
    const base = makeAccount(900_000);
    const open = holding({ stockId: '600519.SH', quantity: 100, avgCost: 1450 });
    const digest = accountFactsDigest({ account: base, holdings: [open] });
    expect(accountFactsDigest({ account: base, holdings: [open] })).toBe(digest);
    expect(accountFactsDigest({ account: makeAccount(800_000), holdings: [open] })).not.toBe(
      digest,
    );
    expect(
      accountFactsDigest({
        account: base,
        holdings: [holding({ stockId: '600519.SH', quantity: 100, avgCost: 1450, closed: true })],
      }),
    ).not.toBe(digest);
  });
});
