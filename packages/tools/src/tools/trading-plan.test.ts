import { TradingPlanSchema } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';
import { getAccountFactsTool } from './account-facts.js';
import { addHoldingTool } from './add-holding.js';
import {
  evaluateTradingPlanBudgetTool,
  getTradingPlanTool,
  listTradingPlansTool,
  saveTradingPlanTool,
} from './trading-plan.js';

/**
 * 账户事实（现金字段 + 当前持仓 + 行情）替代快照：计划必须与当前 facts.digest 一致。
 * 用 fixtures 里的长期账户（无持仓、现金 50 万），保证事实可算且不掺其它持仓。
 */
const ACCOUNT_ID = 'a1b2c3d4-0001-4000-8000-000000000001';

const deriveFacts = async (ctx: Awaited<ReturnType<typeof buildTestContext>>) => {
  const result = await getAccountFactsTool.execute({ accountId: ACCOUNT_ID }, ctx);
  if (!result.ok) throw new Error(`facts failed: ${JSON.stringify(result.error)}`);
  return result.data.facts;
};

const makePlan = (input: {
  readonly accountId: string;
  readonly accountFactsDigest: string;
  readonly stockId?: string;
  readonly stockName?: string;
  readonly industry?: string;
  readonly targetPct?: number;
  readonly status?: 'draft' | 'active';
  readonly validFrom?: Date;
  readonly validUntil?: Date;
}) =>
  TradingPlanSchema.parse({
    id: `account:${input.accountId}:stock:${input.stockId ?? '601398.SH'}`,
    version: 1,
    accountId: input.accountId,
    stockId: input.stockId ?? '601398.SH',
    stockName: input.stockName ?? input.stockId ?? '601398',
    industry: input.industry ?? '银行',
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
    validFrom: input.validFrom ?? new Date('2026-09-08T00:00:00.000Z'),
    validUntil: input.validUntil ?? new Date('2026-09-30T00:00:00.000Z'),
    invalidationConditions: ['账户快照版本改变'],
    accountFactsAsOf: new Date('2026-09-08T00:00:00.000Z'),
    accountFactsDigest: input.accountFactsDigest,
    marketFacts: [],
    evidence: [],
    source: { strategyIds: [], strategyVersionIds: [], runIds: [], signalIds: [], adviceIds: [] },
    explanation: { supportingEvidenceIds: [], counterEvidence: [], risks: [], unknowns: [] },
    confidence: 60,
    createdAt: new Date('2026-09-08T02:00:00.000Z'),
  });

describe('trading plan tools', () => {
  it('saves an active plan only after account facts and budget validation', async () => {
    const ctx = await buildTestContext();
    const facts = await deriveFacts(ctx);
    const plan = makePlan({
      accountId: ACCOUNT_ID,
      accountFactsDigest: facts.digest,
    });
    const saved = await saveTradingPlanTool.execute({ plan }, ctx);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.data.versionId).toContain(':v1');

    const read = await getTradingPlanTool.execute({ versionId: saved.data.versionId }, ctx);
    expect(read.ok).toBe(true);
    const active = await listTradingPlansTool.execute(
      { accountId: ACCOUNT_ID, activeOnly: true },
      ctx,
    );
    expect(active.ok).toBe(true);
    if (active.ok) expect(active.data.plans).toHaveLength(1);

    const budget = await evaluateTradingPlanBudgetTool.execute({ accountId: ACCOUNT_ID }, ctx);
    expect(budget.ok).toBe(true);
    if (budget.ok) expect(budget.data.totalStatus).toBe('passed');
  });

  it('does not publish an active plan that breaches the single-stock default cap', async () => {
    const ctx = await buildTestContext();
    const facts = await deriveFacts(ctx);
    const plan = makePlan({
      accountId: ACCOUNT_ID,
      accountFactsDigest: facts.digest,
      targetPct: 16,
    });
    const result = await saveTradingPlanTool.execute({ plan }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid_input');
  });

  it('does not activate a plan whose account facts already changed', async () => {
    const ctx = await buildTestContext();
    const facts = await deriveFacts(ctx);
    // 计划生成后账户事实变化（新增持仓 → 现金与持仓都变），旧计划不能再激活。
    const changed = await addHoldingTool.execute(
      { accountId: ACCOUNT_ID, stockId: '600519.SH', quantity: 10, avgCost: 1500 },
      ctx,
    );
    expect(changed.ok).toBe(true);
    const result = await saveTradingPlanTool.execute(
      {
        plan: makePlan({
          accountId: ACCOUNT_ID,
          accountFactsDigest: facts.digest,
        }),
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(JSON.stringify(result.error)).toContain('账户事实已变化');
  });

  it('过期 active 计划不再占用预算', async () => {
    const now = new Date('2026-09-15T02:00:00.000Z');
    const ctx = await buildTestContext({ clock: () => now });
    const facts = await deriveFacts(ctx);
    const expiredUntil = new Date('2026-09-14T00:00:00.000Z');
    await ctx.repos.tradingPlan.save(
      makePlan({
        accountId: ACCOUNT_ID,
        accountFactsDigest: facts.digest,
        stockId: '600036.SH',
        validUntil: expiredUntil,
        targetPct: 15,
      }),
    );
    await ctx.repos.tradingPlan.save(
      makePlan({
        accountId: ACCOUNT_ID,
        accountFactsDigest: facts.digest,
        stockId: '601398.SH',
        validUntil: expiredUntil,
        targetPct: 15,
      }),
    );
    const result = await saveTradingPlanTool.execute(
      {
        plan: makePlan({
          accountId: ACCOUNT_ID,
          accountFactsDigest: facts.digest,
          stockId: '600519.SH',
          targetPct: 10,
        }),
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    const active = await listTradingPlansTool.execute(
      { accountId: ACCOUNT_ID, activeOnly: true, asOf: now },
      ctx,
    );
    expect(active.ok).toBe(true);
    if (active.ok) expect(active.data.plans.map((plan) => plan.stockId)).toEqual(['600519.SH']);
  });
});
