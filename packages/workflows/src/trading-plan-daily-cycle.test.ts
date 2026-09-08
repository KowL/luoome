import { AccountSnapshotSchema, type Advice, AdviceSchema } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTradingPlanFromAdvice } from './trading-plan-daily-cycle.js';

const NOW = new Date('2026-07-17T07:00:00.000Z');
const STOCK_ID = '600519.SH';
const ACCOUNT_ID = 'account-1';

describe('trading plan daily cycle', () => {
  it('persists the AI entry range instead of collapsing it to the representative price', () => {
    const snapshot = AccountSnapshotSchema.parse({
      id: 'snapshot-1',
      accountId: ACCOUNT_ID,
      version: 1,
      asOf: NOW,
      cashBalance: 9000,
      stockMarketValue: 1000,
      totalAssets: 10000,
      status: 'complete',
      positions: [
        {
          stockId: '000001.SZ',
          quantity: 100,
          availableQuantity: 100,
          marketValue: 1000,
          industry: '银行',
        },
      ],
      source: 'manual',
      createdAt: NOW,
    });
    const advice = AdviceSchema.parse({
      id: 'advice-1',
      subjectKind: 'stock',
      subjectId: STOCK_ID,
      stockName: '贵州茅台',
      decision: 'buy',
      confidence: 78,
      horizon: 'short',
      entryPrice: 102,
      entryPriceLow: 100,
      entryPriceHigh: 105,
      targetPositionPct: 10,
      targetPrice: 120,
      stopLoss: 95,
      reasoning: {
        premise: '趋势与回撤结构一致',
        evidence: ['价格站上短期均线'],
        counterEvidence: ['市场宽度仍有限'],
      },
      risks: ['波动扩大'],
      disclaimers: ['测试免责声明'],
      sourceTool: 'analyze_strategy_candidate',
      basedOn: {
        quotes: {
          [STOCK_ID]: {
            stockId: STOCK_ID,
            observedAt: new Date('2026-07-17T06:59:00.000Z'),
            fetchedAt: new Date('2026-07-17T06:59:30.000Z'),
            timestampSource: 'upstream',
            open: 101,
            high: 103,
            low: 99,
            close: 102,
            volume: 1000,
            source: 'fixture',
          },
        },
        dataAsOf: new Date('2026-07-17T06:59:30.000Z'),
      },
      validFrom: NOW,
      validUntil: new Date('2026-07-20T07:00:00.000Z'),
      createdAt: NOW,
    }) as Advice;

    const plan = buildTradingPlanFromAdvice({
      accountId: ACCOUNT_ID,
      snapshot,
      advice,
      previous: [],
      now: NOW,
    });

    expect(plan.status).toBe('active');
    expect(plan.entryPriceLow).toBe(100);
    expect(plan.entryPriceHigh).toBe(105);
    expect(plan.entryConditions[0]).toMatchObject({ value: 100, valueTo: 105 });
  });
});
