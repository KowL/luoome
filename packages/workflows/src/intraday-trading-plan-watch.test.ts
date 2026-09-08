import { TradingPlanSchema } from '@luoome/core';
import { saveAccountSnapshotTool } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';
import { intradayTradingPlanWatchWorkflow } from './intraday-trading-plan-watch.js';

const NOW = new Date('2026-07-17T07:00:00.000Z');

const makePlan = (accountId: string, snapshotId: string) =>
  TradingPlanSchema.parse({
    id: `account:${accountId}:stock:002594.SZ`,
    version: 1,
    accountId,
    stockId: '002594.SZ',
    stockName: '比亚迪',
    industry: '汽车',
    status: 'active',
    action: 'enter',
    entryPriceLow: 1,
    entryPriceHigh: 1000,
    entryConditions: [
      {
        id: 'entry-now',
        kind: 'price-threshold',
        phase: 'entry',
        metric: 'price',
        comparator: 'gte',
        value: 0,
        description: '当前行情可观察',
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
      nextReviewAt: new Date('2026-07-22T00:00:00.000Z'),
      earlyExitConditions: [],
      extensionBasis: [],
    },
    exit: { conditions: [], triggerConditions: [], canSellNow: false },
    validFrom: new Date('2026-07-16T00:00:00.000Z'),
    validUntil: new Date('2026-07-20T00:00:00.000Z'),
    invalidationConditions: ['账户快照版本改变'],
    accountSnapshotId: snapshotId,
    accountSnapshotVersion: 1,
    marketFacts: [],
    evidence: [],
    source: { strategyIds: [], strategyVersionIds: [], runIds: [], signalIds: [], adviceIds: [] },
    explanation: { supportingEvidenceIds: [], counterEvidence: [], risks: [], unknowns: [] },
    confidence: 60,
    createdAt: NOW,
  });

describe('intraday trading plan watch', () => {
  it('uses fresh intraday evidence, persists an edge, and does not repeat it', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const snapshot = await saveAccountSnapshotTool.execute(
      { accountId: ctx.user.defaultAccountId, cashBalance: 1000, positions: [] },
      ctx,
    );
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    const plan = makePlan(ctx.user.defaultAccountId, snapshot.data.snapshot.id);
    await ctx.repos.tradingPlan.save(plan);

    const first = await intradayTradingPlanWatchWorkflow.run({ notify: false }, ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.status).toBe('complete');
    expect(first.data.freshQuotes).toBe(1);
    expect(first.data.triggers).toHaveLength(1);
    expect(first.data.triggers[0]?.deliveryStatus).toBe('not-requested');

    const second = await intradayTradingPlanWatchWorkflow.run({ notify: false }, ctx);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.data.triggers).toEqual([]);
  });

  it('blocks exact monitoring when the account snapshot needs reconciliation', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const snapshot = await saveAccountSnapshotTool.execute(
      {
        accountId: ctx.user.defaultAccountId,
        status: 'needs-reconciliation',
        cashBalance: 1000,
        positions: [],
      },
      ctx,
    );
    expect(snapshot.ok).toBe(true);
    const result = await intradayTradingPlanWatchWorkflow.run({}, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.status).toBe('blocked');
  });
});
