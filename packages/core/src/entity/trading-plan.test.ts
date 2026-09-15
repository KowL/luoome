import { describe, expect, it } from 'vitest';

import { InvariantError } from '../error/index.js';
import {
  assertTradingPlanInvariants,
  evaluateTradingPlanCondition,
  isMaterialTradingPlanChange,
  TradingPlanSchema,
  tradingPlanVersionId,
} from './trading-plan.js';

const plan = (overrides: Record<string, unknown> = {}) =>
  TradingPlanSchema.parse({
    id: 'account:a:stock:600519.SH',
    version: 1,
    accountId: 'a',
    stockId: '600519.SH',
    industry: '食品饮料',
    status: 'draft',
    action: 'enter',
    entryPriceLow: 100,
    entryPriceHigh: 105,
    entryConditions: [
      {
        id: 'entry-price',
        kind: 'price-range',
        phase: 'entry',
        metric: 'price',
        comparator: 'between',
        value: 100,
        valueTo: 105,
        description: '价格在入场区间内',
      },
    ],
    invalidEntryConditions: [],
    position: {
      currentPct: 0,
      targetPct: 10,
      deltaPct: 10,
      constraintStatus: 'passed',
      constraintReasons: [],
      prerequisiteActions: ['用户手动执行后更新账户快照'],
    },
    holding: {
      minTradingDays: 3,
      maxTradingDays: 10,
      nextReviewAt: new Date('2026-09-14T00:00:00.000Z'),
      earlyExitConditions: ['跌破止损'],
      extensionBasis: ['市场前提仍成立'],
    },
    exit: {
      stopLoss: 95,
      takeProfit: 120,
      conditions: ['跌破止损或达到目标'],
      canSellNow: false,
    },
    validFrom: new Date('2026-09-08T00:00:00.000Z'),
    validUntil: new Date('2026-09-30T00:00:00.000Z'),
    invalidationConditions: ['行情证据过期'],
    accountFactsAsOf: new Date('2026-09-08T00:00:00.000Z'),
    accountFactsDigest: 'account-facts-test-digest',
    marketFacts: [
      {
        id: 'fact-price',
        stockId: '600519.SH',
        metric: 'price',
        value: 102,
        unit: 'CNY',
        source: 'fixture',
        observedAt: new Date('2026-09-08T02:00:00.000Z'),
        fetchedAt: new Date('2026-09-08T02:00:01.000Z'),
        timestampSource: 'upstream',
        frequency: 'quote',
        status: 'available',
      },
    ],
    evidence: [
      {
        id: 'evidence-1',
        kind: 'market',
        source: 'fixture',
        observedAt: new Date('2026-09-08T02:00:00.000Z'),
        factIds: ['fact-price'],
        summary: '行情事实',
      },
    ],
    source: {
      strategyIds: [],
      strategyVersionIds: [],
      runIds: [],
      signalIds: [],
      adviceIds: ['advice-1'],
    },
    explanation: {
      supportingEvidenceIds: ['evidence-1'],
      counterEvidence: ['市场宽度未覆盖'],
      risks: ['价格波动'],
      unknowns: [],
    },
    confidence: 65,
    createdAt: new Date('2026-09-08T02:01:00.000Z'),
    ...overrides,
  });

describe('TradingPlan invariants and condition evaluation', () => {
  it('requires an entry range and target for active enter/add plans', () => {
    const invalid = plan({ status: 'active', entryPriceHigh: undefined });
    expect(() => assertTradingPlanInvariants(invalid)).toThrow(InvariantError);
  });

  it('allows a draft enter plan to retain missing prerequisites', () => {
    expect(() =>
      assertTradingPlanInvariants(
        plan({
          entryPriceLow: undefined,
          entryPriceHigh: undefined,
          position: { ...plan().position, targetPct: null, deltaPct: null },
        }),
      ),
    ).not.toThrow();
  });

  it('rejects active plans that contain unavailable market facts', () => {
    const invalid = plan({
      status: 'active',
      marketFacts: [{ ...plan().marketFacts[0], status: 'unavailable' }],
    });
    expect(() => assertTradingPlanInvariants(invalid)).toThrow('unavailable market fact');
  });

  it('rejects inverted between conditions', () => {
    expect(() =>
      plan({
        entryConditions: [
          {
            id: 'inverted',
            kind: 'price-range',
            phase: 'entry',
            metric: 'price',
            comparator: 'between',
            value: 110,
            valueTo: 100,
            description: '无效区间',
          },
        ],
      }),
    ).toThrow('between condition value must not exceed valueTo');
  });

  it('evaluates numeric conditions and returns null when the fact is missing', () => {
    const condition = plan().entryConditions[0];
    if (condition === undefined) throw new Error('fixture condition missing');
    expect(
      evaluateTradingPlanCondition(
        condition,
        new Map([['entry-price', { metric: 'price', value: 102 }]]),
      ),
    ).toBe(true);
    expect(
      evaluateTradingPlanCondition(
        condition,
        new Map([['entry-price', { metric: 'price', value: 108 }]]),
      ),
    ).toBe(false);
    expect(evaluateTradingPlanCondition(condition, new Map())).toBe(null);
  });

  it('keeps version identity stable and detects material changes', () => {
    const previous = plan();
    const next = TradingPlanSchema.parse({
      ...previous,
      version: 2,
      entryPriceHigh: 110,
      supersedesVersionId: tradingPlanVersionId(previous),
    });
    expect(tradingPlanVersionId(previous)).toBe('account:a:stock:600519.SH:v1');
    expect(isMaterialTradingPlanChange(previous, next, 0)).toBe(true);
  });
});
