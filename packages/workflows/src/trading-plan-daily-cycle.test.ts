import {
  AccountSnapshotSchema,
  type Advice,
  AdviceSchema,
  STANDARD_DISCLAIMERS,
} from '@luoome/core';
import { saveAccountSnapshotTool } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import {
  buildTradingPlanFromAdvice,
  tradingPlanDailyCycleWorkflow,
} from './trading-plan-daily-cycle.js';

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
      disclaimers: [...STANDARD_DISCLAIMERS],
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

  it('以完整账户快照中的持仓作为复核来源，即使没有 legacy Holding 也会分析', async () => {
    const now = new Date('2026-07-17T07:00:00.000Z');
    const ctx = await buildTestContext({ advices: [], clock: () => now });
    const snapshot = await saveAccountSnapshotTool.execute(
      {
        accountId: ctx.user.defaultAccountId,
        cashBalance: 900_000,
        positions: [{ stockId: '000858.SZ', quantity: 100, marketValue: 10_000 }],
      },
      ctx,
    );
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    let positionCalls = 0;
    let observedHolding: Record<string, unknown> | undefined;
    const llm = ctx.adapters.llm;
    const observedCtx = {
      ...ctx,
      adapters: {
        ...ctx.adapters,
        llm: {
          name: llm.name,
          generate: async <T = unknown>(
            request: Parameters<typeof llm.generate>[0],
          ): Promise<T> => {
            if (request.system === 'analyze_position') {
              positionCalls += 1;
              observedHolding = (request.data as { holding: Record<string, unknown> }).holding;
            }
            return llm.generate<T>(request);
          },
        },
      },
    };
    const result = await tradingPlanDailyCycleWorkflow.run({}, observedCtx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.holdingReviews).toBe(1);
    expect(positionCalls).toBe(1);
    expect(observedHolding).not.toHaveProperty('avgCost');
  });

  it('拒绝把其它账户的策略 Advice 变成目标账户的交易计划', async () => {
    const now = new Date('2026-07-17T07:00:00.000Z');
    const advice = AdviceSchema.parse({
      id: 'cross-account-advice',
      subjectKind: 'stock',
      subjectId: '000858.SZ',
      stockName: '五粮液',
      decision: 'watch',
      confidence: 80,
      horizon: 'short',
      reasoning: {
        premise: '跨账户测试候选',
        evidence: ['测试事实'],
        counterEvidence: ['仍需验证'],
      },
      risks: ['测试风险'],
      disclaimers: [...STANDARD_DISCLAIMERS],
      sourceTool: 'analyze_strategy_candidate',
      basedOn: {
        strategy: {
          strategyId: 'strategy-default',
          strategyVersionId: 'strategy-default-v1',
          runId: 'run-default',
          stockId: '000858.SZ',
          accountId: 'default-account',
          resultEvidence: [],
          signalIds: [],
          observationIds: [],
          recommendationTrigger: 'run',
        },
        dataAsOf: now,
      },
      validFrom: now,
      validUntil: new Date('2026-07-20T07:00:00.000Z'),
      createdAt: now,
    }) as Advice;
    const targetAccountId = 'a1b2c3d4-0001-4000-8000-000000000001';
    const ctx = await buildTestContext({ advices: [advice], clock: () => now });
    const snapshot = await saveAccountSnapshotTool.execute(
      { accountId: targetAccountId, cashBalance: 100_000, positions: [] },
      ctx,
    );
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    const result = await tradingPlanDailyCycleWorkflow.run(
      { accountId: targetAccountId, date: '2026-07-17' },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.candidateReviews).toBe(0);
    expect(result.data.plans).toHaveLength(0);
  });
});
