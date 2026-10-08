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
  it.each(['active', 'revoked'] as const)(
    '旧生效版被 %s 替代后详情与历史列表都停止监控',
    async (status) => {
      const now = new Date('2026-09-09T02:00:00Z');
      const ctx = await buildTestContext({ clock: () => now });
      const facts = await deriveFacts(ctx);
      const active = {
        ...makePlan({ accountId: ACCOUNT_ID, accountFactsDigest: facts.digest }),
        entryConditions: [
          {
            id: 'entry-price',
            kind: 'price-range' as const,
            phase: 'entry' as const,
            metric: 'price' as const,
            comparator: 'between' as const,
            value: 70,
            valueTo: 72,
            description: '价格进入入场区间',
          },
        ],
      };
      await ctx.repos.tradingPlan.save(active);
      await ctx.repos.tradingPlan.save({ ...active, version: 2, status, createdAt: now });
      const read = await getTradingPlanTool.execute({ versionId: `${active.id}:v1` }, ctx);
      expect(read.ok && read.data.monitoring.status).toBe('inactive');
      const listed = await listTradingPlansTool.execute(
        { accountId: ACCOUNT_ID, activeOnly: false, includeMonitoring: true },
        ctx,
      );
      expect(
        listed.ok &&
          listed.data.monitoring?.find((item) => item.versionId === `${active.id}:v1`)?.status,
      ).toBe('inactive');
      const activeHistory = await listTradingPlansTool.execute(
        { accountId: ACCOUNT_ID, status: 'active', includeMonitoring: true },
        ctx,
      );
      expect(
        activeHistory.ok &&
          activeHistory.data.monitoring?.find((item) => item.versionId === `${active.id}:v1`)
            ?.status,
      ).toBe('inactive');
      const historical = await listTradingPlansTool.execute(
        {
          accountId: ACCOUNT_ID,
          currentOnly: true,
          includeMonitoring: true,
          createdUntil: new Date(now.getTime() - 1),
        },
        ctx,
      );
      expect(historical.ok && historical.data.monitoring?.[0]?.status).toBe('ready');
      const historicalList = await listTradingPlansTool.execute(
        {
          accountId: ACCOUNT_ID,
          status: 'active',
          includeMonitoring: true,
          createdUntil: new Date(now.getTime() - 1),
        },
        ctx,
      );
      expect(historicalList.ok && historicalList.data.monitoring?.[0]?.status).toBe('ready');
    },
  );

  it('当前视图保留原生效版与修订草案，过期后改为展示新草案', async () => {
    let now = new Date('2026-09-09T02:00:00Z');
    const ctx = await buildTestContext({ clock: () => now });
    const facts = await deriveFacts(ctx);
    const active = TradingPlanSchema.parse({
      ...makePlan({
        accountId: ACCOUNT_ID,
        accountFactsDigest: facts.digest,
        validUntil: new Date('2026-09-10T02:00:00Z'),
      }),
      entryConditions: [
        {
          id: 'entry-price',
          kind: 'price-range',
          phase: 'entry',
          metric: 'price',
          comparator: 'between',
          value: 70,
          valueTo: 72,
          description: '价格进入入场区间',
        },
      ],
    });
    const draft = {
      ...active,
      version: 2,
      status: 'draft' as const,
      createdAt: now,
      validUntil: new Date('2026-09-30T00:00:00Z'),
    };
    await ctx.repos.tradingPlan.save(active);
    await ctx.repos.tradingPlan.save(draft);
    const listed = await listTradingPlansTool.execute(
      { accountId: ACCOUNT_ID, currentOnly: true, includeMonitoring: true, limit: 1 },
      ctx,
    );
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data.plans).toHaveLength(2);
    expect(
      listed.data.monitoring?.find((item) => item.versionId === `${active.id}:v1`)?.status,
    ).toBe('ready');
    expect(
      listed.data.monitoring?.find((item) => item.versionId === `${active.id}:v2`)?.status,
    ).toBe('draft');
    const activeRead = await getTradingPlanTool.execute({ versionId: `${active.id}:v1` }, ctx);
    expect(activeRead.ok && activeRead.data.monitoring.status).toBe('ready');
    expect(listed.data.views?.[0]).toMatchObject({
      versionId: `${active.id}:v1`,
      draftVersionId: `${active.id}:v2`,
    });
    now = active.validUntil;
    const next = await listTradingPlansTool.execute(
      { accountId: ACCOUNT_ID, currentOnly: true, includeMonitoring: true },
      ctx,
    );
    expect(next.ok && next.data.views?.[0]).toMatchObject({
      versionId: `${active.id}:v2`,
      kind: 'draft',
    });
    now = new Date('2026-09-11T02:00:00Z');
    const expired = await getTradingPlanTool.execute({ versionId: `${active.id}:v2` }, ctx);
    expect(expired.ok && expired.data.monitoring).toMatchObject({
      status: 'expired',
      expiresAt: now,
    });
    expect(await ctx.repos.tradingPlan.findByVersionId(`${active.id}:v2`)).toEqual(
      TradingPlanSchema.parse(draft),
    );
  });

  it('持仓只有抓取时间报价时不能激活其它股票的精确仓位计划', async () => {
    const now = new Date('2026-07-17T06:00:00.000Z');
    const ctx = await buildTestContext({ clock: () => now });
    const added = await addHoldingTool.execute(
      { accountId: ACCOUNT_ID, stockId: '600519.SH', quantity: 10, avgCost: 1500 },
      ctx,
    );
    expect(added.ok).toBe(true);
    const quote = await ctx.adapters.market.fetchQuote('600519.SH');
    await ctx.repos.quote.save(quote);
    const facts = await deriveFacts(ctx);
    const result = await saveTradingPlanTool.execute(
      {
        plan: makePlan({
          accountId: ACCOUNT_ID,
          accountFactsDigest: facts.digest,
          validFrom: new Date(now.getTime() - 1000),
          validUntil: new Date(now.getTime() + 60_000),
        }),
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(JSON.stringify(result.error)).toContain('账户事实不可用');
    expect(await ctx.repos.tradingPlan.list({ accountId: ACCOUNT_ID })).toEqual([]);
  });

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
      targetPct: 31,
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

it('监控投影披露账户变化且不改写原计划历史', async () => {
  const now = new Date('2026-09-10T00:00:00Z');
  const ctx = await buildTestContext({ clock: () => now });
  const facts = await deriveFacts(ctx);
  const plan = makePlan({ accountId: ACCOUNT_ID, accountFactsDigest: facts.digest });
  await ctx.repos.tradingPlan.save(plan);
  const changed = await addHoldingTool.execute(
    { accountId: ACCOUNT_ID, stockId: '600519.SH', quantity: 1, avgCost: 100 },
    ctx,
  );
  expect(changed.ok).toBe(true);
  const result = await listTradingPlansTool.execute(
    { accountId: ACCOUNT_ID, includeMonitoring: true },
    ctx,
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.data.monitoring?.[0]?.status).toBe('account-changed');
    expect(result.data.plans[0]?.status).toBe('active');
  }
});
