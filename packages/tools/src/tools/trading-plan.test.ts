import { TradingPlanSchema } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';
import { saveAccountSnapshotTool } from './account-snapshot.js';
import {
  evaluateTradingPlanBudgetTool,
  getTradingPlanTool,
  listTradingPlansTool,
  saveTradingPlanTool,
} from './trading-plan.js';

const makePlan = (input: {
  readonly accountId: string;
  readonly snapshotId: string;
  readonly snapshotVersion: number;
  readonly targetPct?: number;
  readonly status?: 'draft' | 'active';
}) =>
  TradingPlanSchema.parse({
    id: `account:${input.accountId}:stock:601398.SH`,
    version: 1,
    accountId: input.accountId,
    stockId: '601398.SH',
    stockName: '601398',
    industry: '银行',
    status: input.status ?? 'active',
    action: 'enter',
    entryPriceLow: 70,
    entryPriceHigh: 72,
    entryConditions: [],
    invalidEntryConditions: [],
    position: {
      currentPct: 0,
      targetPct: input.targetPct ?? 10,
      deltaPct: input.targetPct ?? 10,
      constraintStatus: 'passed',
      constraintReasons: [],
      prerequisiteActions: ['用户手动执行后更新账户快照'],
    },
    holding: {
      minTradingDays: 3,
      maxTradingDays: 10,
      nextReviewAt: new Date('2026-09-14T00:00:00.000Z'),
      earlyExitConditions: [],
      extensionBasis: [],
    },
    exit: { conditions: [], canSellNow: false },
    validFrom: new Date('2026-09-08T00:00:00.000Z'),
    validUntil: new Date('2026-09-30T00:00:00.000Z'),
    invalidationConditions: ['账户快照版本改变'],
    accountSnapshotId: input.snapshotId,
    accountSnapshotVersion: input.snapshotVersion,
    marketFacts: [],
    evidence: [],
    source: { strategyIds: [], strategyVersionIds: [], runIds: [], signalIds: [], adviceIds: [] },
    explanation: { supportingEvidenceIds: [], counterEvidence: [], risks: [], unknowns: [] },
    confidence: 60,
    createdAt: new Date('2026-09-08T02:00:00.000Z'),
  });

describe('trading plan tools', () => {
  it('saves an active plan only after account snapshot and budget validation', async () => {
    const ctx = await buildTestContext();
    const snapshot = await saveAccountSnapshotTool.execute(
      {
        accountId: ctx.user.defaultAccountId,
        cashBalance: 1000,
        positions: [],
      },
      ctx,
    );
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    const plan = makePlan({
      accountId: ctx.user.defaultAccountId,
      snapshotId: snapshot.data.snapshot.id,
      snapshotVersion: snapshot.data.snapshot.version,
    });
    const saved = await saveTradingPlanTool.execute({ plan }, ctx);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.data.versionId).toContain(':v1');

    const read = await getTradingPlanTool.execute({ versionId: saved.data.versionId }, ctx);
    expect(read.ok).toBe(true);
    const active = await listTradingPlansTool.execute(
      { accountId: ctx.user.defaultAccountId, activeOnly: true },
      ctx,
    );
    expect(active.ok).toBe(true);
    if (active.ok) expect(active.data.plans).toHaveLength(1);

    const budget = await evaluateTradingPlanBudgetTool.execute(
      { accountId: ctx.user.defaultAccountId },
      ctx,
    );
    expect(budget.ok).toBe(true);
    if (budget.ok) expect(budget.data.totalStatus).toBe('passed');
  });

  it('does not publish an active plan that breaches the single-stock default cap', async () => {
    const ctx = await buildTestContext();
    const snapshot = await saveAccountSnapshotTool.execute(
      { accountId: ctx.user.defaultAccountId, cashBalance: 1000, positions: [] },
      ctx,
    );
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    const plan = makePlan({
      accountId: ctx.user.defaultAccountId,
      snapshotId: snapshot.data.snapshot.id,
      snapshotVersion: snapshot.data.snapshot.version,
      targetPct: 16,
    });
    const result = await saveTradingPlanTool.execute({ plan }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_input');
  });

  it('does not activate a plan against an outdated account snapshot', async () => {
    const ctx = await buildTestContext();
    const first = await saveAccountSnapshotTool.execute(
      { accountId: ctx.user.defaultAccountId, cashBalance: 1000, positions: [] },
      ctx,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await saveAccountSnapshotTool.execute(
      { accountId: ctx.user.defaultAccountId, cashBalance: 900, positions: [] },
      ctx,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const result = await saveTradingPlanTool.execute(
      {
        plan: makePlan({
          accountId: ctx.user.defaultAccountId,
          snapshotId: first.data.snapshot.id,
          snapshotVersion: first.data.snapshot.version,
        }),
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(JSON.stringify(result.error)).toContain('当前快照');
  });
});
