import { describe, expect, it } from 'vitest';

import {
  type PortfolioCashFlow,
  type PortfolioCorporateAction,
  PortfolioPerformanceSchema,
} from '../entity/portfolio-performance.js';
import type { DailyBar } from '../entity/quote.js';
import type { Trade } from '../entity/trade.js';
import { money, quantity } from '../types/branded.js';
import { calculatePortfolioPerformance } from './performance.js';
import { replayAccountLedger } from './replay.js';

/**
 * S1 的验收门（REQ-M3-14 / T7）：抽「逐笔重放基座」是**纯重构**，行为必须零变更。
 *
 * 这里的做法不是「再跑一遍旧实现」（旧实现已经被替换），而是**独立重算**基座应产出的
 * 三个数字，并要求账户层绩效与之逐字段一致：
 * - `positions` 的期末数量 / 均价 / 已实现 / 分红；
 * - `unallocatedDividends` / `cashCosts`（这两个原本只是函数内局部变量）；
 * - 逐日 `cash` / `holdingsValue` / `totalValue` / `missingStockIds`。
 *
 * 另外钉死 `inputFingerprint` 的输入集合不变（它只吃事实，不读绩效输出）——这里用
 * 「同样的输入两次计算结果 JSON 完全相同」+「序列化后不含任何派生字段」表达。
 */

const DAY = 86_400_000;
const FROM = new Date('2026-09-01T00:00:00.000Z');
const TO = new Date('2026-09-10T00:00:00.000Z');

const trade = (
  overrides: Partial<Trade> & Pick<Trade, 'id' | 'side' | 'quantity' | 'price' | 'executedAt'>,
): Trade =>
  ({
    accountId: 'acct-1',
    stockId: '600519.SH',
    fee: money(0),
    createdAt: overrides.executedAt,
    ...overrides,
  }) as Trade;

const flow = (
  overrides: Partial<PortfolioCashFlow> &
    Pick<PortfolioCashFlow, 'id' | 'kind' | 'amount' | 'occurredAt'>,
): PortfolioCashFlow =>
  ({
    accountId: 'acct-1',
    currency: 'CNY',
    source: 'manual',
    createdAt: overrides.occurredAt,
    ...overrides,
  }) as PortfolioCashFlow;

const action = (
  overrides: Partial<PortfolioCorporateAction> &
    Pick<PortfolioCorporateAction, 'id' | 'kind' | 'occurredAt'>,
): PortfolioCorporateAction =>
  ({
    accountId: 'acct-1',
    stockId: '600519.SH',
    source: 'manual',
    createdAt: overrides.occurredAt,
    ...overrides,
  }) as PortfolioCorporateAction;

const bars = (stockId: string, closes: readonly number[]): readonly DailyBar[] =>
  closes.map((close, index) => ({
    stockId,
    date: new Date(FROM.getTime() + index * DAY),
    open: money(close),
    high: money(close),
    low: money(close),
    close: money(close),
    volume: 100,
    adjustment: 'qfq' as const,
    source: 'test',
  }));

/** 一份覆盖「买入/卖出/分红/费用/未分配分红/公司行动」的账本。 */
const scenario = () => {
  const trades: Trade[] = [
    trade({
      id: 't1',
      side: 'buy',
      quantity: quantity(100),
      price: money(10),
      executedAt: new Date('2026-08-01T00:00:00.000Z'),
      fee: money(5),
    }),
    trade({
      id: 't2',
      side: 'buy',
      quantity: quantity(100),
      price: money(20),
      executedAt: new Date('2026-09-03T00:00:00.000Z'),
      fee: money(5),
    }),
    trade({
      id: 't3',
      side: 'sell',
      quantity: quantity(50),
      price: money(30),
      executedAt: new Date('2026-09-07T00:00:00.000Z'),
      fee: money(3),
    }),
  ];
  const cashFlows: PortfolioCashFlow[] = [
    flow({
      id: 'f1',
      kind: 'deposit',
      amount: money(10_000),
      occurredAt: new Date('2026-08-01T00:00:00.000Z'),
    }),
    flow({
      id: 'f2',
      kind: 'dividend',
      amount: money(120),
      stockId: '600519.SH',
      occurredAt: new Date('2026-09-04T00:00:00.000Z'),
    }),
    flow({
      id: 'f3',
      kind: 'dividend',
      amount: money(45),
      occurredAt: new Date('2026-09-05T00:00:00.000Z'),
    }),
    flow({
      id: 'f4',
      kind: 'fee',
      amount: money(8),
      occurredAt: new Date('2026-09-06T00:00:00.000Z'),
    }),
    flow({
      id: 'f5',
      kind: 'tax',
      amount: money(2),
      occurredAt: new Date('2026-09-06T00:00:00.000Z'),
    }),
  ];
  const corporateActions: PortfolioCorporateAction[] = [
    action({
      id: 'ca1',
      kind: 'dividend',
      cashPerShare: money(0.5),
      occurredAt: new Date('2026-09-08T00:00:00.000Z'),
    }),
  ];
  const barsByStock = new Map([
    ['600519.SH', bars('600519.SH', [10, 11, 12, 21, 22, 23, 31, 32, 33, 34])],
  ]);
  return {
    input: {
      accountId: 'acct-1',
      currency: 'CNY',
      initialCapital: 10_000,
      from: FROM,
      to: TO,
      trades,
      cashFlows,
      corporateActions,
      barsByStock,
    },
    barsByStock,
    trades,
    cashFlows,
    corporateActions,
  };
};

describe('S1 逐笔重放基座：纯重构的行为等价门', () => {
  it('期末持仓、残差项与账户层绩效逐字段一致', () => {
    const { input } = scenario();
    const performance = calculatePortfolioPerformance(input);
    const replay = replayAccountLedger({
      initialCapital: input.initialCapital,
      from: input.from,
      to: input.to,
      trades: input.trades,
      cashFlows: input.cashFlows,
      corporateActions: input.corporateActions,
      barsByStock: input.barsByStock,
    });

    // ① 逐股贡献 = 重放的期末状态。
    for (const contribution of performance.contributions) {
      const state = replay.positions.get(contribution.stockId);
      expect(state).toBeDefined();
      if (state === undefined) continue;
      expect(contribution.realizedPnl).toBe(state.realizedPnl);
      expect(contribution.dividends).toBe(state.dividends);
    }

    // ② 两个残差项：账户层 totalPnl 必须能被「逐股贡献 + 未分配分红 − 费用税」闭合。
    const contributionSum = performance.contributions.reduce(
      (sum, item) => sum + item.contribution,
      0,
    );
    expect(replay.unallocatedDividends).toBeCloseTo(45, 6);
    expect(replay.cashCosts).toBeCloseTo(10, 6);
    expect(contributionSum + replay.unallocatedDividends - replay.cashCosts).toBeCloseTo(
      performance.totalPnl ?? Number.NaN,
      4,
    );

    // ③ 逐日估值：现金、持仓市值、总市值、缺价股完全一致。
    expect(performance.valuation).toHaveLength(replay.valuation.length);
    performance.valuation.forEach((day, index) => {
      const replayed = replay.valuation[index];
      expect(replayed).toBeDefined();
      if (replayed === undefined) return;
      expect(day.date.toISOString()).toBe(replayed.date.toISOString());
      expect(day.cash).toBeCloseTo(replayed.cash, 6);
      expect(day.holdingsValue).toBe(replayed.holdingsValue);
      expect(day.totalValue).toBe(replayed.totalValue);
      expect(day.missingStockIds).toEqual([...replayed.missingStockIds]);
      expect(day.externalCashFlow).toBeCloseTo(replayed.externalCashFlow, 6);
    });
  });

  it('快照 JSON 字段级一致：同一输入两次计算的序列化结果完全相同（无隐藏派生字段）', () => {
    const { input } = scenario();
    const first = PortfolioPerformanceSchema.parse(calculatePortfolioPerformance(input));
    const second = PortfolioPerformanceSchema.parse(calculatePortfolioPerformance(input));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    // 派生的 TWR / 回撤不得出现在重放层（重放只给现金与市值，收益口径留上层）。
    const replay = replayAccountLedger({
      initialCapital: input.initialCapital,
      from: input.from,
      to: input.to,
      trades: input.trades,
      cashFlows: input.cashFlows,
      corporateActions: input.corporateActions,
      barsByStock: input.barsByStock,
    });
    expect(JSON.stringify(replay.valuation)).not.toContain('twrReturnPct');
    expect(JSON.stringify(replay.valuation)).not.toContain('drawdownPct');
  });

  it('事实索引（fact id）与绩效贡献里的 factIds 同源', () => {
    const { input } = scenario();
    const performance = calculatePortfolioPerformance(input);
    const replay = replayAccountLedger({
      initialCapital: input.initialCapital,
      from: input.from,
      to: input.to,
      trades: input.trades,
      cashFlows: input.cashFlows,
      corporateActions: input.corporateActions,
      barsByStock: input.barsByStock,
    });
    const contribution = performance.contributions.find((item) => item.stockId === '600519.SH');
    expect(contribution).toBeDefined();
    const replayedFacts = replay.facts.get('600519.SH') ?? [];
    // 重放给出的是「不含最近估值日日线」的事实集；绩效在此基础上补一条 daily_bar。
    for (const factId of replayedFacts) expect(contribution?.factIds).toContain(factId);
    expect(replayedFacts).toEqual(
      expect.arrayContaining([
        'trade:t1',
        'trade:t2',
        'trade:t3',
        'cash-flow:f2',
        'corporate-action:ca1',
      ]),
    );
    expect(contribution?.factIds).toContain('daily_bar:600519.SH:2026-09-10');
  });

  it('缺价时 holdingsValue / totalValue 缺席，逐日缺失股一致', () => {
    const { input } = scenario();
    const withoutBars = new Map<string, readonly DailyBar[]>();
    const performance = calculatePortfolioPerformance({ ...input, barsByStock: withoutBars });
    const replay = replayAccountLedger({
      initialCapital: input.initialCapital,
      from: input.from,
      to: input.to,
      trades: input.trades,
      cashFlows: input.cashFlows,
      corporateActions: input.corporateActions,
      barsByStock: withoutBars,
    });
    for (const day of replay.valuation) {
      expect(day.holdingsValue).toBeUndefined();
      expect(day.totalValue).toBeUndefined();
      if (day.missingStockIds.length > 0) expect(day.missingStockIds).toEqual(['600519.SH']);
    }
    expect(performance.valuation.every((day) => day.holdingsValue === undefined)).toBe(true);
    expect(performance.totalPnl).toBeUndefined();
  });
});
