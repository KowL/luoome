import { describe, expect, it } from 'vitest';
import type { AccountFacts } from '../entity/account-facts.js';
import type { Stock } from '../entity/stock.js';
import type { TradingPlan } from '../entity/trading-plan.js';
import { money } from '../types/branded.js';
import {
  DEFAULT_TRADING_PLAN_BUDGET_LIMITS,
  evaluateTradingPlanBudget,
} from './trading-plan-budget.js';

const facts: AccountFacts = {
  accountId: 'a',
  asOf: new Date('2026-09-08T00:00:00.000Z'),
  digest: 'digest-budget-test',
  cashBalance: money(700),
  stockMarketValue: money(300),
  totalAssets: money(1000),
  status: 'complete',
  reasons: [],
  notes: [],
  positions: [
    {
      stockId: '600519.SH',
      quantity: 10,
      availableQuantity: 10,
      marketValue: money(100),
      industry: '食品饮料',
    },
    {
      stockId: '002594.SZ',
      quantity: 10,
      availableQuantity: 10,
      marketValue: money(200),
      industry: '汽车',
    },
  ],
};

const stock = (id: string, industry: string): Stock => ({
  id,
  code: id.split('.')[0] as Stock['code'],
  exchange: id.endsWith('.SH') ? 'SH' : 'SZ',
  name: id,
  industry,
});

const plan = (input: {
  readonly id: string;
  readonly stockId: string;
  readonly industry?: string;
  readonly currentPct: number;
  readonly targetPct: number;
  readonly action?: TradingPlan['action'];
}): TradingPlan =>
  ({
    id: input.id,
    version: 1,
    accountId: 'a',
    stockId: input.stockId,
    ...(input.industry === undefined ? {} : { industry: input.industry }),
    status: 'active',
    action: input.action ?? 'add',
    entryPriceLow: money(10),
    entryPriceHigh: money(11),
    entryConditions: [],
    invalidEntryConditions: [],
    position: {
      currentPct: input.currentPct,
      targetPct: input.targetPct,
      deltaPct: Math.round((input.targetPct - input.currentPct) * 100) / 100,
      constraintStatus: 'passed',
      constraintReasons: [],
      prerequisiteActions: [],
    },
    holding: {
      minTradingDays: 1,
      maxTradingDays: 5,
      nextReviewAt: new Date('2026-09-10T00:00:00.000Z'),
      earlyExitConditions: [],
      extensionBasis: [],
    },
    exit: { conditions: [], triggerConditions: [], canSellNow: true },
    validFrom: new Date('2026-09-08T00:00:00.000Z'),
    validUntil: new Date('2026-09-20T00:00:00.000Z'),
    invalidationConditions: [],
    accountFactsAsOf: new Date('2026-09-08T00:00:00.000Z'),
    accountFactsDigest: 'digest-budget-test',
    marketFacts: [],
    evidence: [],
    source: { strategyIds: [], strategyVersionIds: [], runIds: [], signalIds: [], adviceIds: [] },
    explanation: { supportingEvidenceIds: [], counterEvidence: [], risks: [], unknowns: [] },
    confidence: 50,
    createdAt: new Date('2026-09-08T01:00:00.000Z'),
  }) as TradingPlan;

describe('trading plan budget', () => {
  it('uses the default 80/15/30 caps and allows a non-increasing plan above a cap', () => {
    const overCapSnapshot = {
      ...facts,
      cashBalance: money(600),
      stockMarketValue: money(400),
      positions: [
        {
          stockId: '600519.SH',
          quantity: 10,
          availableQuantity: 10,
          marketValue: money(200),
          industry: '食品饮料',
        },
        {
          stockId: '002594.SZ',
          quantity: 10,
          availableQuantity: 10,
          marketValue: money(200),
          industry: '汽车',
        },
      ],
    };
    const result = evaluateTradingPlanBudget({
      facts: overCapSnapshot,
      plans: [
        plan({
          id: 'hold-over-cap',
          stockId: '600519.SH',
          industry: '食品饮料',
          currentPct: 20,
          targetPct: 20,
          action: 'hold',
        }),
      ],
      stocks: new Map([['600519.SH', stock('600519.SH', '食品饮料')]]),
    });
    expect(result.limits).toEqual(DEFAULT_TRADING_PLAN_BUDGET_LIMITS);
    expect(result.totalStatus).toBe('passed');
  });

  it('combines concurrent increases and blocks single-stock and total breaches', () => {
    const result = evaluateTradingPlanBudget({
      facts,
      plans: [
        plan({
          id: 'a',
          stockId: '600519.SH',
          industry: '食品饮料',
          currentPct: 10,
          targetPct: 15,
        }),
        plan({
          id: 'b',
          stockId: '600519.SH',
          industry: '食品饮料',
          currentPct: 10,
          targetPct: 15,
        }),
      ],
      stocks: new Map([['600519.SH', stock('600519.SH', '食品饮料')]]),
    });
    expect(result.totalStatus).toBe('blocked');
    expect(result.allocations.some((item) => item.reasons.includes('single-stock-limit'))).toBe(
      true,
    );
  });

  it('returns unavailable when account facts are not reconciled and does not release budget for a pending sell', () => {
    const incomplete = {
      ...facts,
      status: 'unavailable' as const,
      totalAssets: null,
      stockMarketValue: null,
      reasons: ['账户现金或持仓行情不可用'],
    };
    const unavailable = evaluateTradingPlanBudget({
      facts: incomplete,
      plans: [
        plan({
          id: 'new',
          stockId: '600519.SH',
          industry: '食品饮料',
          currentPct: 10,
          targetPct: 15,
        }),
      ],
      stocks: new Map([['600519.SH', stock('600519.SH', '食品饮料')]]),
    });
    expect(unavailable.totalStatus).toBe('unavailable');
    expect(unavailable.availableStockPct).toBe(null);

    const result = evaluateTradingPlanBudget({
      facts,
      plans: [
        plan({
          id: 'sell',
          stockId: '002594.SZ',
          industry: '汽车',
          currentPct: 20,
          targetPct: 0,
          action: 'exit',
        }),
        plan({
          id: 'buy',
          stockId: '600519.SH',
          industry: '食品饮料',
          currentPct: 10,
          targetPct: 15,
        }),
      ],
      stocks: new Map([
        ['600519.SH', stock('600519.SH', '食品饮料')],
        ['002594.SZ', stock('002594.SZ', '汽车')],
      ]),
    });
    expect(result.currentStockPct).toBe(30);
    expect(result.proposedStockPct).toBe(35);
  });

  it('does not trust a stale plan position percentage to bypass the single-stock cap', () => {
    const result = evaluateTradingPlanBudget({
      facts,
      plans: [
        plan({
          id: 'stale-position',
          stockId: '600519.SH',
          industry: '食品饮料',
          currentPct: 0,
          targetPct: 20,
        }),
      ],
      stocks: new Map([['600519.SH', stock('600519.SH', '食品饮料')]]),
    });
    expect(result.totalStatus).toBe('blocked');
    expect(result.allocations[0]?.reasons).toContain('single-stock-limit');
  });

  it('账户仓位已高于 80% 时，增量计划仍可生效（总仓位上限默认 100%）', () => {
    const mostlyInvested: AccountFacts = {
      ...facts,
      cashBalance: money(160),
      stockMarketValue: money(840),
      totalAssets: money(1000),
      positions: [
        {
          stockId: '600519.SH',
          quantity: 42,
          availableQuantity: 42,
          marketValue: money(840),
        },
      ],
    };
    const result = evaluateTradingPlanBudget({
      facts: mostlyInvested,
      plans: [
        plan({
          id: 'add',
          stockId: '002594.SZ',
          currentPct: 0,
          targetPct: 5,
        }),
      ],
      stocks: new Map(),
    });
    expect(result.currentStockPct).toBe(84);
    expect(result.totalStatus).toBe('passed');
    expect(result.proposedStockPct).toBe(89);
    expect(result.availableStockPct).toBe(11);
  });

  it('建议合计超过账户总资产时仍然阻断（不得超总资产）', () => {
    const mostlyInvested: AccountFacts = {
      ...facts,
      cashBalance: money(160),
      stockMarketValue: money(840),
      totalAssets: money(1000),
      positions: [
        {
          stockId: '600519.SH',
          quantity: 42,
          availableQuantity: 42,
          marketValue: money(840),
        },
      ],
    };
    const result = evaluateTradingPlanBudget({
      facts: mostlyInvested,
      plans: [
        plan({ id: 'a', stockId: '002594.SZ', currentPct: 0, targetPct: 12 }),
        plan({ id: 'b', stockId: '601398.SH', currentPct: 0, targetPct: 12 }),
      ],
      stocks: new Map(),
    });
    expect(result.totalStatus).toBe('blocked');
    expect(result.reasons).toContain('total-stock-limit: 108 > 100');
    expect(result.availableStockPct).toBe(16);
  });

  it('行业信息缺失不再阻断增量计划（行业上限已移除）', () => {
    const existing = facts.positions[1];
    if (existing === undefined) throw new Error('fixture position missing');
    const incompleteIndustry: AccountFacts = {
      ...facts,
      positions: [
        {
          stockId: existing.stockId,
          quantity: existing.quantity,
          availableQuantity: existing.availableQuantity,
          marketValue: existing.marketValue,
        },
      ],
      stockMarketValue: money(100),
      totalAssets: money(1000),
      cashBalance: money(900),
    };
    const result = evaluateTradingPlanBudget({
      facts: incompleteIndustry,
      plans: [
        plan({
          id: 'new-position',
          stockId: '600519.SH',
          industry: '食品饮料',
          currentPct: 10,
          targetPct: 15,
        }),
      ],
      stocks: new Map([['600519.SH', stock('600519.SH', '食品饮料')]]),
    });
    expect(result.totalStatus).toBe('passed');
    expect(result.allocations[0]?.reasons).toEqual([]);
    expect(result.allocations[0]?.incrementalPct).toBe(15);
  });
});
