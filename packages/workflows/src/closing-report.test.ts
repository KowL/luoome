import {
  type AShareSentimentManagerLike,
  type AShareSentimentSnapshot,
  money,
  STANDARD_DISCLAIMERS,
  type StrategyDslV1,
  type StrategyVersion,
  strategyDefinitionHash,
  type ToolContext,
  type TradingPlanReview,
  TradingPlanSchema,
  tradingPlanVersionId,
} from '@luoome/core';
import {
  addTradeTool,
  getAccountFactsTool,
  getReportTool,
  recordWorkflowRunTool,
  saveWatchTriggerTool,
} from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { closingReportWorkflow } from './closing-report.js';
import { buildWorkflowTools } from './define-workflow.js';
import { executeReportWorkflow } from './internal/report-runner.js';

const now = new Date('2026-07-27T10:00:00.000Z');
const marketAsOf = new Date('2026-07-27T07:00:00.000Z');
const EMPTY_ACCOUNT_ID = 'a1b2c3d4-0001-4000-8000-000000000001';

const generateClosingSnapshot = (input: Record<string, unknown>, ctx: ToolContext) =>
  closingReportWorkflow.run({ planBatchStatus: 'complete', ...input }, ctx);

const planFixture = (digest: string, overrides: Record<string, unknown> = {}) =>
  TradingPlanSchema.parse({
    id: `account:${EMPTY_ACCOUNT_ID}:stock:600519.SH`,
    version: 1,
    accountId: EMPTY_ACCOUNT_ID,
    stockId: '600519.SH',
    stockName: '贵州茅台',
    status: 'active',
    action: 'observe',
    entryPriceLow: 100,
    entryPriceHigh: 105,
    entryConditions: [
      {
        id: 'entry',
        kind: 'price-range',
        phase: 'entry',
        metric: 'price',
        comparator: 'between',
        value: 100,
        valueTo: 105,
        description: '等待价格进入 100-105 元区间',
      },
    ],
    invalidEntryConditions: [],
    position: {
      currentPct: 0,
      targetPct: 10,
      deltaPct: 10,
      constraintStatus: 'passed',
      constraintReasons: [],
      prerequisiteActions: [],
    },
    holding: {
      minTradingDays: 1,
      maxTradingDays: 5,
      nextReviewAt: new Date('2026-07-24T10:00:00Z'),
      earlyExitConditions: [],
      extensionBasis: [],
    },
    exit: {
      stopLoss: 95,
      takeProfit: 120,
      conditions: ['跌破止损后暂停入场'],
      triggerConditions: [],
      canSellNow: false,
    },
    validFrom: new Date('2026-07-23T10:00:00Z'),
    validUntil: new Date('2026-07-31T10:00:00Z'),
    invalidationConditions: ['账户事实变化'],
    accountFactsAsOf: now,
    accountFactsDigest: digest,
    marketFacts: [],
    evidence: [],
    source: { strategyIds: [], strategyVersionIds: [], runIds: [], signalIds: [], adviceIds: [] },
    explanation: {
      supportingEvidenceIds: [],
      counterEvidence: ['成交量不足'],
      risks: ['波动风险'],
      unknowns: [],
    },
    confidence: 60,
    createdAt: new Date('2026-07-23T10:00:00Z'),
    ...overrides,
  });

const seedPlanReviews = async (
  ctx: ToolContext,
  accountId: string,
  reviewedAt: Date,
  reviews: TradingPlanReview[],
) => {
  const result = await recordWorkflowRunTool.execute(
    {
      run: {
        id: `plan-review:${accountId}:${reviewedAt.toISOString()}`,
        workflowName: 'trading-plan-daily-cycle',
        mode: 'manual',
        status: 'succeeded',
        startedAt: reviewedAt,
        finishedAt: reviewedAt,
        inputSummary: { accountId },
        outputSummary: { reviews },
        providerStatuses: [],
      },
    },
    ctx,
  );
  if (!result.ok) throw new Error('plan review fixture failed');
};

const snapshot = (): AShareSentimentSnapshot => ({
  date: '2026-07-27',
  coverage: 'CN_A_SHARES_SH_SZ',
  dataAsOf: marketAsOf,
  indexes: {
    status: 'complete',
    provenance: [
      {
        provider: 'fixture-index',
        observedAt: marketAsOf,
        fetchedAt: now,
        freshness: 'fresh',
      },
    ],
    warnings: [],
    values: [],
  },
  breadth: {
    status: 'unavailable',
    provenance: [
      {
        provider: 'fixture-breadth',
        observedAt: now,
        fetchedAt: now,
        freshness: 'unavailable',
        errorKind: 'incomplete_coverage',
      },
    ],
    warnings: ['breadth unavailable'],
  },
  limitUp: {
    status: 'complete',
    provenance: [
      {
        provider: 'fixture-limit-up',
        observedAt: marketAsOf,
        fetchedAt: now,
        freshness: 'fresh',
      },
    ],
    warnings: [],
    value: {
      sealedCount: 8,
      brokenCount: 2,
      brokenRate: 0.2,
      maxLadderLevel: 3,
      totalSealAmount: 600_000_000,
      boardDistribution: { '1': 6, '2': 1, '3': 1 },
      leaders: [],
    },
  },
  themes: {
    status: 'partial',
    provenance: [
      {
        provider: 'fixture-limit-up',
        observedAt: marketAsOf,
        fetchedAt: now,
        freshness: 'fresh',
      },
    ],
    warnings: ['concept themes unavailable'],
    value: { industries: [], concepts: [] },
  },
});

const seedStrategyWithPublishedRun = async (
  ctx: ToolContext,
  date: string,
  options: { readonly skipRun?: boolean; readonly runDataAsOf?: Date } = {},
): Promise<void> => {
  const definition: StrategyDslV1 = {
    schemaVersion: 1,
    metadata: {},
    universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
    selection: {
      logic: 'all',
      rules: [{ id: 'all', name: '全选', when: 'true', evidence: ['fixture'] }],
    },
    signals: {
      entry: [
        {
          id: 'entry',
          name: '测试入场',
          when: 'true',
          score: '80',
          direction: 'bullish' as const,
          evidence: ['fixture'],
        },
      ],
      exit: [],
      risk: [],
    },
  };
  const version: StrategyVersion = {
    id: 'closing-strategy-v1',
    strategyId: 'closing-strategy',
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: new Date(`${date}T01:00:00.000Z`),
    createdAt: new Date(`${date}T01:00:00.000Z`),
  };
  await ctx.repos.strategy.create({
    id: 'closing-strategy',
    name: '收盘策略',
    description: 'test',
    owner: 'user',
    status: 'active',
    currentVersionId: version.id,
    createdAt: new Date(`${date}T01:00:00.000Z`),
    updatedAt: new Date(`${date}T01:00:00.000Z`),
  });
  await ctx.repos.strategy.createVersion(version);
  if (options.skipRun === true) return;
  const startedAt = new Date(`${date}T07:30:00.000Z`);
  const finishedAt = new Date(`${date}T07:31:00.000Z`);
  const runId = `closing-strategy-run-${date}`;
  await ctx.repos.strategyRun.commitRun({
    run: {
      id: runId,
      strategyId: 'closing-strategy',
      strategyVersionId: version.id,
      mode: 'scheduled',
      coverage: 'CN_A_SHARES_SH_SZ',
      dataAsOf: options.runDataAsOf ?? new Date(`${date}T07:00:00.000Z`),
      startedAt,
      finishedAt,
      status: 'complete',
      scope: 'operational',
      inputSnapshot: {
        schemaVersion: 2,
        strategyVersionId: version.id,
        definitionHash: version.definitionHash,
        evaluatorVersion: 'test',
        coverage: 'CN_A_SHARES_SH_SZ',
        stockIds: ['600519.SH'],
        stockIdChecksum: '0'.repeat(64),
        requestedBy: 'scheduled',
      },
      providerStatuses: [],
      summary: {
        schemaVersion: 2,
        universeCount: 1,
        evaluatedCount: 1,
        selectedCount: 1,
        signalCount: 1,
        partialCount: 0,
        failedCount: 0,
        failureSamples: [],
      },
      publication: { status: 'published', reasons: [], decidedAt: finishedAt },
    },
    results: [
      {
        runId,
        stockId: '600519.SH',
        selected: true,
        score: 80,
        rank: 1,
        ruleEvaluations: [],
        evidence: ['fixture'],
        dataAsOf: options.runDataAsOf ?? new Date(`${date}T07:00:00.000Z`),
      },
    ],
    signals: [
      {
        id: `closing-strategy-signal-${date}`,
        strategyId: 'closing-strategy',
        strategyVersionId: version.id,
        runId,
        ruleId: 'entry',
        stockId: '600519.SH',
        ts: startedAt,
        score: 80,
        direction: 'bullish',
        evidence: ['fixture'],
        evaluationSnapshot: {},
      },
    ],
  });
};

const seedStrategyAdvice = async (ctx: ToolContext, date: string): Promise<void> => {
  const createdAt = new Date(`${date}T02:00:00.000Z`);
  await ctx.repos.advice.save({
    id: `closing-strategy-advice-${date}`,
    subjectKind: 'stock',
    subjectId: '600519.SH',
    stockName: '贵州茅台',
    decision: 'buy',
    confidence: 60,
    horizon: 'short',
    entryPrice: money(10.5),
    targetPrice: money(12),
    stopLoss: money(9.8),
    reasoning: {
      premise: '策略信号触发且量价配合，值得买入。',
      evidence: ['fixture evidence'],
      counterEvidence: ['fixture counter'],
    },
    risks: ['fixture risk'],
    disclaimers: [...STANDARD_DISCLAIMERS],
    sourceTool: 'analyze_strategy_candidate',
    basedOn: {
      dataAsOf: createdAt,
      strategy: {
        strategyId: 'closing-strategy',
        strategyVersionId: 'closing-strategy-v1',
        runId: `closing-strategy-run-${date}`,
        stockId: '600519.SH',
        resultEvidence: ['fixture'],
        signalIds: [`closing-strategy-signal-${date}`],
        observationIds: [],
        recommendationTrigger: 'run',
      },
    },
    validFrom: createdAt,
    validUntil: new Date(createdAt.getTime() + 3 * 86_400_000),
    createdAt,
  });
};

const sentimentManager = (): AShareSentimentManagerLike => ({
  status: () => [],
  fetch: async () => ({ ok: true, data: snapshot() }),
});

describe('closing-report workflow', () => {
  it('计划复盘保留有效旧版，单列修订草案与已过期记录，展示实际截止时间', async () => {
    const ctx = await buildTestContext({ clock: () => now, ashareSentiment: sentimentManager() });
    const facts = await getAccountFactsTool.execute({ accountId: EMPTY_ACCOUNT_ID }, ctx);
    if (!facts.ok) throw new Error('facts fixture missing');
    const active = planFixture(facts.data.facts.digest);
    const draft = planFixture(facts.data.facts.digest, {
      version: 2,
      status: 'draft',
      createdAt: new Date('2026-07-27T08:00:00Z'),
      position: {
        ...active.position,
        constraintStatus: 'unavailable',
        constraintReasons: ['AI 推理不可用'],
      },
    });
    const expired = planFixture(facts.data.facts.digest, {
      id: `account:${EMPTY_ACCOUNT_ID}:stock:601398.SH`,
      stockId: '601398.SH',
      stockName: '工商银行',
      status: 'draft',
      createdAt: new Date('2026-07-20T08:00:00Z'),
      validUntil: new Date('2026-08-20T08:00:00Z'),
    });
    await ctx.repos.tradingPlan.save(active);
    await ctx.repos.tradingPlan.save(draft);
    await ctx.repos.tradingPlan.save(expired);
    const result = await generateClosingSnapshot(
      {
        date: '2026-07-27',
        scope: { kind: 'account', accountId: EMPTY_ACCOUNT_ID },
        notify: false,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const section = result.data.report.sections.find((s) => s.key === 'trading-plans');
    const table = section?.blocks.find((b) => b.kind === 'table');
    expect(table?.kind === 'table' ? table.rows : []).toMatchObject([
      { stock: '贵州茅台', version: 'v1', monitoringStatus: 'ready' },
    ]);
    const metrics = section?.blocks.find((b) => b.kind === 'metrics');
    expect(metrics).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ key: 'ready', value: 1 }),
        expect.objectContaining({ key: 'expired', value: 1 }),
        expect.objectContaining({ key: 'revisionDrafts', value: 1 }),
      ]),
    });
    const items = section?.blocks.flatMap((b) => (b.kind === 'list' ? b.items : [])) ?? [];
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: '贵州茅台 · 观察 · v1',
          entityId: tradingPlanVersionId(active),
        }),
        expect.objectContaining({
          entityId: tradingPlanVersionId(draft),
          detail: expect.stringContaining('AI 推理不可用'),
        }),
        expect.objectContaining({
          entityId: tradingPlanVersionId(expired),
          detail: expect.stringContaining('2026/07/22'),
        }),
      ]),
    );
    expect(JSON.stringify(section)).not.toContain('2026-08-20');
    expect(section?.status).toBe('partial');
  });

  it('复核按目标日和账户归属统计，重复维持只计一次，前一日也能看到未新增版本的复核', async () => {
    const ctx = await buildTestContext({
      clock: () => new Date('2026-07-28T10:00:00Z'),
      ashareSentiment: sentimentManager(),
    });
    const facts = await getAccountFactsTool.execute({ accountId: EMPTY_ACCOUNT_ID }, ctx);
    if (!facts.ok) throw new Error('facts fixture missing');
    const active = planFixture(facts.data.facts.digest);
    await ctx.repos.tradingPlan.save(active);
    for (const [accountId, at, outcome] of [
      [EMPTY_ACCOUNT_ID, '2026-07-24T08:00:00Z', 'maintained'],
      [EMPTY_ACCOUNT_ID, '2026-07-27T08:00:00Z', 'maintained'],
      [EMPTY_ACCOUNT_ID, '2026-07-27T09:00:00Z', 'maintained'],
      ['other-account', '2026-07-27T09:00:00Z', 'created'],
      [EMPTY_ACCOUNT_ID, '2026-07-28T08:00:00Z', 'created'],
    ] as const) {
      await seedPlanReviews(ctx, accountId, new Date(at), [
        {
          stockId: active.stockId,
          versionId: tradingPlanVersionId(active),
          outcome,
          reviewedAt: new Date(at),
          adviceIds: ['fixture-advice'],
          reasons: [],
        },
      ]);
    }
    const result = await generateClosingSnapshot(
      {
        date: '2026-07-27',
        scope: { kind: 'account', accountId: EMPTY_ACCOUNT_ID },
        notify: false,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const section = result.data.report.sections.find((s) => s.key === 'trading-plans');
    const metrics = section?.blocks.filter((b) => b.kind === 'metrics').flatMap((b) => b.items);
    expect(metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'reviewCreated', value: 0 }),
        expect.objectContaining({ key: 'reviewMaintained', value: 1 }),
      ]),
    );
    const prior = result.data.report.sections.find((s) => s.key === 'prior-day-review');
    expect(prior?.blocks.find((b) => b.kind === 'metrics')).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ key: 'planVersions', value: 0 }),
        expect.objectContaining({ key: 'reviewMaintained', value: 1 }),
      ]),
    });
    expect(prior?.blocks.flatMap((b) => (b.kind === 'list' ? b.items : []))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: expect.stringContaining('维持原计划'),
          entityId: tradingPlanVersionId(active),
        }),
      ]),
    );
  });

  it('本日新增版本再次复核只计新增，不能同时计为维持原版', async () => {
    const ctx = await buildTestContext({ clock: () => now, ashareSentiment: sentimentManager() });
    const facts = await getAccountFactsTool.execute({ accountId: EMPTY_ACCOUNT_ID }, ctx);
    if (!facts.ok) throw new Error('facts fixture missing');
    const active = planFixture(facts.data.facts.digest, {
      createdAt: new Date('2026-07-27T08:00:00Z'),
    });
    await ctx.repos.tradingPlan.save(active);
    for (const [at, outcome] of [
      ['2026-07-27T08:00:00Z', 'created'],
      ['2026-07-27T09:00:00Z', 'maintained'],
    ] as const) {
      const reviewedAt = new Date(at);
      await seedPlanReviews(ctx, EMPTY_ACCOUNT_ID, reviewedAt, [
        {
          stockId: active.stockId,
          versionId: tradingPlanVersionId(active),
          outcome,
          reviewedAt,
          adviceIds: [],
          reasons: [],
        },
      ]);
    }
    const result = await generateClosingSnapshot(
      {
        date: '2026-07-27',
        scope: { kind: 'account', accountId: EMPTY_ACCOUNT_ID },
        notify: false,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const section = result.data.report.sections.find((s) => s.key === 'trading-plans');
    const metrics = section?.blocks.filter((b) => b.kind === 'metrics').flatMap((b) => b.items);
    expect(metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'reviewCreated', value: 1 }),
        expect.objectContaining({ key: 'reviewMaintained', value: 0 }),
      ]),
    );
  });

  it('复核审计读取失败时保留未知数量，不能显示成零次复核', async () => {
    const ctx = await buildTestContext({ clock: () => now, ashareSentiment: sentimentManager() });
    ctx.repos.workflowRun.listRecent = async () => {
      throw new Error('复核审计暂不可用');
    };
    const result = await generateClosingSnapshot(
      {
        date: '2026-07-27',
        scope: { kind: 'account', accountId: EMPTY_ACCOUNT_ID },
        notify: false,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const key of ['trading-plans', 'prior-day-review']) {
      const section = result.data.report.sections.find((s) => s.key === key);
      const metrics = section?.blocks.filter((b) => b.kind === 'metrics').flatMap((b) => b.items);
      expect(metrics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'reviewCreated', value: null }),
          expect.objectContaining({ key: 'reviewMaintained', value: null }),
        ]),
      );
      expect(section?.status).toBe('partial');
      expect(section?.missingDimensions).toEqual(
        expect.arrayContaining([expect.objectContaining({ dimension: `${key}.reviews` })]),
      );
    }
  });

  it('报告发布后的复核记录不再生成版本或重复通知', async () => {
    const ctx = await buildTestContext({ clock: () => now, ashareSentiment: sentimentManager() });
    const facts = await getAccountFactsTool.execute({ accountId: EMPTY_ACCOUNT_ID }, ctx);
    if (!facts.ok) throw new Error('facts fixture missing');
    const active = planFixture(facts.data.facts.digest);
    await ctx.repos.tradingPlan.save(active);
    const input = {
      date: '2026-07-27',
      scope: { kind: 'account' as const, accountId: EMPTY_ACCOUNT_ID },
      notify: true,
      mode: 'scheduled' as const,
    };
    const first = await generateClosingSnapshot(input, ctx);
    expect(first.ok && first.data.notified).toBe(true);
    const reviewedAt = new Date('2026-07-27T09:00:00Z');
    await seedPlanReviews(ctx, EMPTY_ACCOUNT_ID, reviewedAt, [
      {
        stockId: active.stockId,
        versionId: tradingPlanVersionId(active),
        outcome: 'maintained',
        reviewedAt,
        adviceIds: ['fresh-advice'],
        reasons: [],
      },
    ]);
    const result = await generateClosingSnapshot({ ...input, supplement: true }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.report.version).toBe(1);
    expect(result.data.report.id).toBe(first.ok ? first.data.report.id : undefined);
    expect(result.data.created).toBe(false);
    expect(await ctx.repos.report.list({ kind: 'closing' })).toHaveLength(1);
    expect(result.data.notified).toBe(false);
    expect(await ctx.repos.notification.listRecent()).toHaveLength(1);
  });

  it('计划后续变化仍更新计划记录，已生成的报告和通知保持一份', async () => {
    const ctx = await buildTestContext({ clock: () => now, ashareSentiment: sentimentManager() });
    const facts = await getAccountFactsTool.execute({ accountId: EMPTY_ACCOUNT_ID }, ctx);
    if (!facts.ok) throw new Error('facts fixture missing');
    const plans = Array.from({ length: 21 }, (_, index) => {
      const stockId = `${600_000 + index}.SH`;
      return planFixture(facts.data.facts.digest, {
        id: `account:${EMPTY_ACCOUNT_ID}:stock:${stockId}`,
        stockId,
        stockName: `测试股票 ${index}`,
      });
    });
    for (const plan of plans) await ctx.repos.tradingPlan.save(plan);
    const input = {
      date: '2026-07-27',
      scope: { kind: 'account' as const, accountId: EMPTY_ACCOUNT_ID },
      notify: true,
      mode: 'scheduled' as const,
    };
    const first = await generateClosingSnapshot(input, ctx);
    expect(first.ok && first.data.notified).toBe(true);
    const last = plans.at(-1);
    if (last === undefined) throw new Error('plan fixture missing');
    await ctx.repos.tradingPlan.save({
      ...last,
      version: 2,
      createdAt: now,
      explanation: { ...last.explanation, risks: ['新增风险，需重新核对'] },
    });
    const result = await generateClosingSnapshot({ ...input, supplement: true }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const table = result.data.report.sections
      .find((section) => section.key === 'trading-plans')
      ?.blocks.find((block) => block.kind === 'table');
    expect(table?.kind === 'table' ? table.rows : []).toHaveLength(20);
    expect(table?.kind === 'table' ? table.rows.map((row) => row.stock) : []).not.toContain(
      last.stockName,
    );
    expect(result.data.created).toBe(false);
    expect(result.data.report).toEqual(first.ok ? first.data.report : undefined);
    expect(result.data.notified).toBe(false);
    expect(await ctx.repos.notification.listRecent()).toHaveLength(1);
  });

  it('账户报告只展示本账户的策略建议与有效期', async () => {
    const ctx = await buildTestContext({ clock: () => now, ashareSentiment: sentimentManager() });
    await seedStrategyWithPublishedRun(ctx, '2026-07-27');
    await seedStrategyAdvice(ctx, '2026-07-27');
    const template = await ctx.repos.advice.findById('closing-strategy-advice-2026-07-27');
    if (template === null || template.basedOn.strategy === undefined)
      throw new Error('missing advice fixture');
    const accounts = await ctx.repos.account.list();
    const [firstAccount, secondAccount] = accounts.slice(1);
    if (firstAccount === undefined || secondAccount === undefined)
      throw new Error('missing accounts');
    for (const [account, label] of [
      [firstAccount, '长期账户专属建议'],
      [secondAccount, '短线账户专属建议'],
    ] as const) {
      await ctx.repos.advice.save({
        ...template,
        id: `account-advice:${account.id}`,
        reasoning: { ...template.reasoning, premise: label },
        basedOn: {
          ...template.basedOn,
          strategy: { ...template.basedOn.strategy, accountId: account.id },
        },
        validUntil: new Date('2026-07-27T11:00:00.000Z'),
      });
    }

    const first = await generateClosingSnapshot(
      {
        date: '2026-07-27',
        scope: { kind: 'account', accountId: firstAccount.id },
        notify: false,
      },
      ctx,
    );
    const second = await generateClosingSnapshot(
      {
        date: '2026-07-27',
        scope: { kind: 'account', accountId: secondAccount.id },
        notify: false,
      },
      ctx,
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const firstContent = JSON.stringify(first.data.report.sections);
    const secondContent = JSON.stringify(second.data.report.sections);
    expect(firstContent).toContain('长期账户专属建议');
    expect(firstContent).not.toContain('短线账户专属建议');
    expect(secondContent).toContain('短线账户专属建议');
    expect(secondContent).not.toContain('长期账户专属建议');
  });

  it('账户计划批次阻断时，交易计划区块和整份报告保持 partial', async () => {
    const ctx = await buildTestContext({ clock: () => now, ashareSentiment: sentimentManager() });
    const result = await generateClosingSnapshot(
      { date: '2026-07-27', planBatchStatus: 'blocked', notify: false },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.data.report.sections.find((section) => section.key === 'trading-plans'),
    ).toMatchObject({
      required: true,
      status: 'partial',
      missingDimensions: [expect.objectContaining({ dimension: 'trading-plans.daily-cycle' })],
    });
    expect(result.data.report.status).toBe('partial');
  });

  it('飞书使用通知摘要，保留风险有效期而不发送完整表格和证据 ID', async () => {
    const ctx = await buildTestContext({ clock: () => now, ashareSentiment: sentimentManager() });
    await seedStrategyWithPublishedRun(ctx, '2026-07-27');
    await seedStrategyAdvice(ctx, '2026-07-27');
    const result = await generateClosingSnapshot({ date: '2026-07-27', notify: true }, ctx);
    expect(result.ok).toBe(true);
    const notifications = await ctx.repos.notification.listRecent();
    expect(notifications).toHaveLength(1);
    const payload = notifications[0]?.payload;
    expect(payload?.title).toBe('2026-07-27 收盘复盘');
    expect(payload?.content).toContain('贵州茅台');
    expect(payload?.content).toContain('反证：fixture counter');
    expect(payload?.content).toContain('风险：fixture risk');
    expect(payload?.content).toContain('有效至');
    expect(payload?.content).not.toContain('closing-strategy-advice');
    expect(payload?.content).not.toContain('| ---');
    expect(payload?.content).not.toMatch(/账户当日估值变化|交易计划|账本累计盈亏|目标仓位/);
    expect(payload?.content).not.toContain('# 2026-07-27');
    expect(payload?.content.length).toBeLessThan(4200);
  });

  it('使用当日市场证据并保存六个收盘事实 section', async () => {
    const requestedDates: string[] = [];
    const manager: AShareSentimentManagerLike = {
      status: () => [],
      fetch: async (input) => {
        requestedDates.push(input.date);
        return { ok: true, data: snapshot() };
      },
    };
    const ctx = await buildTestContext({ clock: () => now, ashareSentiment: manager });

    const result = await generateClosingSnapshot({ date: '2026-07-27', notify: false }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(requestedDates).toEqual(['2026-07-27']);
    expect(
      result.data.report.sections.find((section) => section.key === 'trading-plans'),
    ).toMatchObject({ status: 'complete', missingDimensions: [] });
    expect(result.data.report).toMatchObject({
      kind: 'closing',
      periodStart: '2026-07-27',
      periodEnd: '2026-07-27',
      status: 'partial',
      dataAsOf: marketAsOf,
    });
    expect(result.data.report.sections.map((section) => section.key)).toEqual([
      'market-pulse',
      'account-performance',
      'important-triggers',
      'advice-expiry',
      'strategy-actions',
      'trading-plans',
      'next-events',
    ]);
  });

  it('次日补发前一日收盘报告时只纳入目标日期触发，渠道受理不写成设备送达', async () => {
    const ctx = await buildTestContext({
      clock: () => new Date('2026-07-28T01:00:00.000Z'),
      ashareSentiment: sentimentManager(),
    });
    const accountId = ctx.user.defaultAccountId;
    const base = {
      poolId: `trading-plan-watch:${accountId}`,
      stockId: '002594.SZ',
      ruleId: 'entry',
      ruleKind: 'price-level' as const,
      direction: 'watch' as const,
      triggerType: 'triggered' as const,
      priority: 'important' as const,
      deliveryStatus: 'sent' as const,
      notified: true,
      evalSnapshot: { ruleId: 'entry' },
      reason: '计划价格条件',
      evidence: ['固定测试行情'],
    };
    for (const [id, createdAt] of [
      ['target-day-trigger', new Date('2026-07-27T10:00:00.000Z')],
      ['next-day-trigger', new Date('2026-07-27T16:15:00.000Z')],
    ] as const) {
      expect(
        await saveWatchTriggerTool.execute(
          { ...base, id, createdAt, deliveryCompletedAt: createdAt },
          ctx,
        ),
      ).toMatchObject({ ok: true });
    }

    const result = await generateClosingSnapshot(
      { date: '2026-07-27', scope: { kind: 'account', accountId }, notify: false },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const section = result.data.report.sections.find((item) => item.key === 'important-triggers');
    const items = section?.blocks.flatMap((block) => (block.kind === 'list' ? block.items : []));
    expect(items?.map((item) => item.entityId)).toEqual(['target-day-trigger']);
    expect(items?.[0]?.notificationSummary).toContain('渠道已受理，设备状态未知');
    expect(items?.[0]?.notificationSummary).not.toContain('已送达');
  });

  it('前一交易日提醒不视作成交，后补交易保留在账本且不改写已生成的复盘', async () => {
    const ctx = await buildTestContext({ clock: () => now, ashareSentiment: sentimentManager() });
    const accountId = ctx.user.defaultAccountId;
    const triggeredAt = new Date('2026-07-24T06:00:00.000Z');
    expect(
      await saveWatchTriggerTool.execute(
        {
          id: 'prior-day-unexecuted-signal',
          poolId: `trading-plan-watch:${accountId}`,
          stockId: '002594.SZ',
          ruleId: 'entry',
          ruleKind: 'price-level',
          direction: 'watch',
          reason: '价格满足计划条件',
          evidence: ['测试行情'],
          priority: 'normal',
          deliveryStatus: 'not-requested',
          notified: false,
          evalSnapshot: { ruleId: 'entry' },
          createdAt: triggeredAt,
        },
        ctx,
      ),
    ).toMatchObject({ ok: true });

    const scope = { kind: 'account' as const, accountId };
    const main = await generateClosingSnapshot({ date: '2026-07-27', scope, notify: false }, ctx);
    expect(main.ok).toBe(true);
    if (!main.ok) return;
    const reviewOf = (report: typeof main.data.report) => {
      const section = report.sections.find((item) => item.key === 'prior-day-review');
      const metrics = section?.blocks.find((block) => block.kind === 'metrics');
      const tradeTable = section?.blocks.find((block) => block.kind === 'table');
      return { section, metrics, tradeTable };
    };
    const first = reviewOf(main.data.report);
    expect(first.section?.title).toContain('2026-07-24');
    expect(first.metrics?.kind === 'metrics' ? first.metrics.items : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'triggerCount', value: 1 }),
        expect.objectContaining({ key: 'registeredTrades', value: 0 }),
      ]),
    );
    expect(first.tradeTable?.kind === 'table' ? first.tradeTable.rows : []).toEqual([]);
    expect(JSON.stringify(first.section)).toContain('没有已登记交易不等于实际没有交易');

    const registered = await addTradeTool.execute(
      {
        stockId: '002594.SZ',
        side: 'buy',
        quantity: 1,
        price: 100,
        executedAt: new Date('2026-07-24T07:00:00.000Z'),
      },
      ctx,
    );
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const supplement = await generateClosingSnapshot(
      { date: '2026-07-27', scope, notify: false, supplement: true },
      ctx,
    );
    expect(supplement.ok).toBe(true);
    if (!supplement.ok) return;
    const second = reviewOf(supplement.data.report);
    expect(supplement.data.created).toBe(false);
    expect(supplement.data.report.id).toBe(main.data.report.id);
    expect(supplement.data.report.version).toBe(1);
    expect(second).toEqual(first);
    expect(await ctx.repos.trade.findById(registered.data.trade.id)).not.toBeNull();
    expect(await ctx.repos.report.list({ kind: 'closing' })).toHaveLength(1);
    const savedMain = await ctx.repos.report.findById(main.data.report.id);
    expect(savedMain?.version).toBe(1);
    expect(reviewOf(savedMain ?? main.data.report).metrics).toEqual(first.metrics);
  });

  it('单日报告补取上一交易日作为收益基点，未配置的基准不生成空占位', async () => {
    const ctx = await buildTestContext({ clock: () => now, ashareSentiment: sentimentManager() });
    const result = await generateClosingSnapshot({ date: '2026-07-27', notify: false }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const snapshots = await ctx.repos.portfolioPerformanceSnapshot.listByAccount(
      ctx.user.defaultAccountId,
    );
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[0]).toMatchObject({
      from: new Date('2026-07-24T00:00:00.000Z'),
      to: new Date('2026-07-27T00:00:00.000Z'),
    });
    const performance = result.data.report.sections.find(
      (section) => section.key === 'account-performance',
    );
    const metrics =
      performance?.blocks.flatMap((block) => (block.kind === 'metrics' ? block.items : [])) ?? [];
    expect(metrics.some((metric) => metric.key === 'benchmarkTwrPct')).toBe(false);
    expect(
      metrics.filter((metric) => metric.key === 'twrPct').every((metric) => metric.value !== null),
    ).toBe(true);
  });

  it('scheduled 模式对同键已投递报告幂等，不重复生成与投递', async () => {
    const ctx = await buildTestContext({ clock: () => now, ashareSentiment: sentimentManager() });
    const first = await generateClosingSnapshot(
      { date: '2026-07-27', notify: false, mode: 'scheduled' },
      ctx,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.created).toBe(true);
    await ctx.repos.report.setDeliveryStatus(first.data.report.id, 'sent');

    const second = await generateClosingSnapshot(
      { date: '2026-07-27', notify: false, mode: 'scheduled' },
      ctx,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.created).toBe(false);
    expect(second.data.notified).toBe(false);
    expect(second.data.report.id).toBe(first.data.report.id);
    expect(await ctx.repos.report.list({ kind: 'closing' })).toHaveLength(1);
    expect(await ctx.repos.workflowRun.listRecent({ workflowName: 'closing-report' })).toHaveLength(
      1,
    );
  });

  it('并发生成同一账户主报告时只保存并通知一次', async () => {
    const ctx = await buildTestContext({ clock: () => now, ashareSentiment: sentimentManager() });
    const input = {
      date: '2026-07-27',
      scope: { kind: 'account' as const, accountId: ctx.user.defaultAccountId },
      mode: 'scheduled' as const,
      notify: true,
    };
    const results = await Promise.all([
      generateClosingSnapshot(input, ctx),
      generateClosingSnapshot(input, ctx),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && result.data.created)).toHaveLength(1);
    expect(await ctx.repos.report.list({ kind: 'closing' })).toHaveLength(1);
    expect(await ctx.repos.notification.listRecent()).toHaveLength(1);
  });

  it('报告已保存但通知失败时按同一版本重试，成功后不再重复投递', async () => {
    let current = now;
    let sends = 0;
    const base = await buildTestContext({
      clock: () => current,
      ashareSentiment: sentimentManager(),
    });
    const ctx: ToolContext = {
      ...base,
      notification: {
        send: async (input) => {
          sends += 1;
          const failed = sends === 1;
          const notification = {
            id: input.id ?? `test-notification-${sends}`,
            channel: input.channel,
            payload: input.payload,
            result: failed ? ('failed' as const) : ('success' as const),
            ...(failed ? { errorMessage: 'fixture delivery failure' } : {}),
            sentAt: current,
          };
          await base.repos.notification.save(notification);
          return { notification };
        },
      },
    };
    const input = { date: '2026-07-27', mode: 'scheduled' as const, notify: true };
    const first = await generateClosingSnapshot(input, ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.report.deliveryStatus).toBe('failed');
    expect(sends).toBe(1);

    current = new Date(now.getTime() + 10 * 60_000);
    const cooling = await generateClosingSnapshot(input, ctx);
    expect(cooling.ok && cooling.data.notified).toBe(false);
    expect(sends).toBe(1);

    current = new Date(now.getTime() + 16 * 60_000);
    const retried = await generateClosingSnapshot(input, ctx);
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.data.report.id).toBe(first.data.report.id);
    expect(retried.data.report.deliveryStatus).toBe('sent');
    expect(retried.data.notified).toBe(true);
    expect(sends).toBe(2);
    expect(await ctx.repos.report.list({ kind: 'closing' })).toHaveLength(1);
    const notifications = await ctx.repos.notification.listRecent();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.id).toBe(`report-notification:${first.data.report.id}`);
    expect(notifications[0]?.result).toBe('success');

    await generateClosingSnapshot(input, ctx);
    expect(sends).toBe(2);
  });

  it('截止重试只投递主版，不投递标记 never 的后补版本', async () => {
    const ctx = await buildTestContext({ clock: () => now, ashareSentiment: sentimentManager() });
    const input = { date: '2026-07-27', mode: 'scheduled' as const, notify: false };
    const first = await generateClosingSnapshot(input, ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const main = first.data.report;
    const supplement = await ctx.repos.report.upsertForPeriod({
      ...main,
      id: 'review-supplement-never',
      version: 2,
      supersedesReportId: main.id,
      notificationPolicy: 'never',
      deliveryStatus: 'not-requested',
    });
    expect(
      await ctx.repos.report.claimDelivery({
        id: supplement.id,
        attemptId: 'forbidden',
        now,
        stalePendingBefore: now,
        failedRetryBefore: now,
      }),
    ).toBe(false);
    const retried = await generateClosingSnapshot({ ...input, notify: true }, ctx);
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.data.notified).toBe(true);
    expect((await ctx.repos.report.findById(main.id))?.deliveryStatus).toBe('sent');
    expect((await ctx.repos.report.findById(supplement.id))?.deliveryStatus).toBe('not-requested');
    expect(await ctx.repos.notification.listRecent()).toHaveLength(1);
    const again = await generateClosingSnapshot({ ...input, notify: true }, ctx);
    expect(again.ok && again.data.notified).toBe(false);
    expect(await ctx.repos.notification.listRecent()).toHaveLength(1);
  });

  it('认领结果禁止通知时按策略跳过，不记为投递失败或渠道成功', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    const tools = buildWorkflowTools(ctx);
    let claims = 0;
    const result = await executeReportWorkflow(
      {
        workflowName: 'closing-report',
        kind: 'closing',
        template: 'closing-v1',
        mode: 'manual',
        notify: true,
        scope: { kind: 'all-accounts' },
        periodStart: '2026-07-27',
        periodEnd: '2026-07-27',
        title: '收盘报告',
        buildSections: async () => [
          {
            section: {
              key: 'summary',
              title: '账户事实',
              required: true,
              status: 'complete',
              blocks: [],
              evidenceIds: [],
              missingDimensions: [],
            },
            evidence: [],
          },
        ],
      },
      {
        ...ctx,
        tools: {
          ...tools,
          save_report: {
            execute: async (input) => {
              const saved = await tools.save_report.execute({ report: input.report });
              if (!saved.ok || input.deliveryAttemptId === undefined) return saved;
              claims += 1;
              return {
                ok: true,
                data: {
                  report: { ...saved.data.report, notificationPolicy: 'never' },
                  created: false,
                  deliveryClaimed: true,
                },
              };
            },
          },
        },
      },
    );
    expect(result).toMatchObject({
      notified: false,
      report: { notificationPolicy: 'never', deliveryStatus: 'not-requested' },
    });
    expect(claims).toBe(1);
    expect(await ctx.repos.notification.listRecent()).toEqual([]);
    const [run] = await ctx.repos.workflowRun.listRecent({ workflowName: 'closing-report' });
    expect(run).toMatchObject({
      status: 'succeeded',
      outputSummary: {
        notified: false,
        notificationSkippedByPolicy: true,
        deliveryStatus: 'not-requested',
      },
      providerStatuses: [],
    });
  });

  it('进程中断留下 pending 投递后，超时接管同一报告版本', async () => {
    let current = now;
    const ctx = await buildTestContext({
      clock: () => current,
      ashareSentiment: sentimentManager(),
    });
    const first = await generateClosingSnapshot(
      { date: '2026-07-27', mode: 'scheduled', notify: false },
      ctx,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(
      await ctx.repos.report.claimDelivery({
        id: first.data.report.id,
        attemptId: 'interrupted-worker',
        now,
        stalePendingBefore: new Date(now.getTime() - 5 * 60_000),
        failedRetryBefore: new Date(now.getTime() - 15 * 60_000),
      }),
    ).toBe(true);
    current = new Date(now.getTime() + 6 * 60_000);
    const recovered = await generateClosingSnapshot(
      { date: '2026-07-27', mode: 'scheduled', notify: true },
      ctx,
    );
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.data.report.id).toBe(first.data.report.id);
    expect(recovered.data.report.deliveryStatus).toBe('sent');
    expect(await ctx.repos.notification.listRecent()).toHaveLength(1);
    expect(
      await ctx.repos.report.finishDelivery({
        id: first.data.report.id,
        attemptId: 'interrupted-worker',
        status: 'failed',
        now: current,
      }),
    ).toBe(false);
  });

  it('手动重跑、定时重跑与旧补充请求都复用同一报告', async () => {
    const ctx = await buildTestContext({ clock: () => now, ashareSentiment: sentimentManager() });
    const first = await generateClosingSnapshot(
      { date: '2026-07-27', mode: 'scheduled', notify: true, planBatchStatus: 'partial' },
      ctx,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    for (const mode of ['manual', 'scheduled'] as const) {
      const repeated = await generateClosingSnapshot(
        { date: '2026-07-27', mode, notify: true, supplement: true, planBatchStatus: 'complete' },
        ctx,
      );
      expect(repeated).toMatchObject({ ok: true, data: { created: false, notified: false } });
      if (repeated.ok) expect(repeated.data.report).toEqual(first.data.report);
    }
    const saved = await getReportTool.execute(
      { kind: 'closing', periodEnd: '2026-07-27', version: 1 },
      ctx,
    );
    expect(saved.ok && saved.data.report.id).toBe(first.data.report.id);
    expect(await ctx.repos.notification.listRecent()).toHaveLength(1);
    expect(await ctx.repos.report.list({ kind: 'closing' })).toHaveLength(1);
    expect(await ctx.repos.workflowRun.listRecent({ workflowName: 'closing-report' })).toHaveLength(
      1,
    );
  });

  it('交易计划段带可点击引用（entityKind=trading-plan + 确切版本 id）', async () => {
    const ctx = await buildTestContext({ clock: () => now, ashareSentiment: sentimentManager() });
    const plan = TradingPlanSchema.parse({
      id: 'account:acc-1:stock:600519.SH',
      version: 2,
      accountId: 'acc-1',
      stockId: '600519.SH',
      stockName: '贵州茅台',
      industry: '白酒',
      status: 'active',
      action: 'enter',
      entryPriceLow: 98,
      entryPriceHigh: 103,
      entryConditions: [
        {
          id: 'entry',
          kind: 'price-range',
          phase: 'entry',
          metric: 'price',
          comparator: 'between',
          value: 98,
          valueTo: 103,
          description: '价格处于入场区间 98-103',
        },
      ],
      invalidEntryConditions: [],
      position: {
        currentPct: 0,
        targetPct: 8,
        deltaPct: 8,
        constraintStatus: 'passed',
        constraintReasons: [],
        prerequisiteActions: [],
      },
      holding: {
        minTradingDays: 1,
        maxTradingDays: 5,
        nextReviewAt: new Date('2026-07-28T00:00:00.000Z'),
        earlyExitConditions: [],
        extensionBasis: [],
      },
      exit: { conditions: [], triggerConditions: [], canSellNow: false },
      validFrom: new Date('2026-07-27T00:00:00.000Z'),
      validUntil: new Date('2026-08-02T00:00:00.000Z'),
      invalidationConditions: ['账户快照版本改变'],
      accountFactsAsOf: new Date('2026-07-27T00:00:00.000Z'),
      accountFactsDigest: 'closing-report-plan-digest',
      marketFacts: [],
      evidence: [],
      source: {
        strategyIds: [],
        strategyVersionIds: [],
        runIds: [],
        signalIds: [],
        adviceIds: [],
      },
      explanation: {
        supportingEvidenceIds: [],
        counterEvidence: [],
        risks: [],
        unknowns: [],
      },
      confidence: 60,
      createdAt: new Date('2026-07-27T00:00:00.000Z'),
    });
    await ctx.repos.tradingPlan.save(plan);

    const result = await generateClosingSnapshot({ date: '2026-07-27', notify: false }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const section = result.data.report.sections.find((item) => item.key === 'trading-plans');
    expect(section?.status).toBe('complete');
    const list = section?.blocks.find((block) => block.kind === 'list');
    expect(list?.kind === 'list' ? list.items : []).toEqual([
      {
        title: '贵州茅台 · 建仓 · v2',
        detail: expect.stringContaining('等待数据 · 条件：价格处于入场区间 98-103'),
        entityKind: 'trading-plan',
        entityId: 'account:acc-1:stock:600519.SH:v2',
      },
    ]);

    const priorDayPlanId = `account:${ctx.user.defaultAccountId}:stock:600519.SH`;
    await ctx.repos.tradingPlan.save({
      ...plan,
      id: priorDayPlanId,
      accountId: ctx.user.defaultAccountId,
      createdAt: new Date('2026-07-24T08:00:00.000Z'),
    });
    const accountReport = await generateClosingSnapshot(
      {
        date: '2026-07-27',
        scope: { kind: 'account', accountId: ctx.user.defaultAccountId },
        notify: false,
      },
      ctx,
    );
    expect(accountReport.ok).toBe(true);
    if (!accountReport.ok) return;
    const priorDay = accountReport.data.report.sections.find(
      (item) => item.key === 'prior-day-review',
    );
    expect(priorDay?.blocks.find((block) => block.kind === 'metrics')).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ key: 'planVersions', value: 1 })]),
    });
    expect(priorDay?.blocks.find((block) => block.kind === 'list')).toMatchObject({
      items: [expect.objectContaining({ entityId: `${priorDayPlanId}:v2` })],
    });
  });

  it('分析失败批次保留候选，报告如实呈现失败而非无机会', async () => {
    const ctx = await buildTestContext({ clock: () => now, ashareSentiment: sentimentManager() });
    await seedStrategyWithPublishedRun(ctx, '2026-07-27');
    await ctx.repos.workflowRun.save({
      id: 'failed-analysis-batch',
      workflowName: 'strategy-recommendations',
      mode: 'scheduled',
      status: 'partial',
      startedAt: now,
      finishedAt: now,
      providerStatuses: [],
      outputSummary: {
        strategyId: 'closing-strategy',
        runId: 'closing-strategy-run-2026-07-27',
        accountId: ctx.user.defaultAccountId,
        adviceCount: 0,
        attempted: 1,
        generationFailed: 1,
        skippedCooldown: 0,
        notificationFailed: 0,
      },
    });
    const result = await generateClosingSnapshot({ date: '2026-07-27', notify: false }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const section = result.data.report.sections.find((item) => item.key === 'strategy-actions');
    expect(section?.status).toBe('partial');
    expect(JSON.stringify(section)).toContain('生成失败 1 条');
    expect(JSON.stringify(section)).toContain('600519.SH');
    expect(JSON.stringify(section)).not.toContain('无值得买入');
  });

  it('策略行动 section 汇总当日 published 运行概览并以链接引用策略 Advice', async () => {
    const ctx = await buildTestContext({ clock: () => now, ashareSentiment: sentimentManager() });
    await seedStrategyWithPublishedRun(ctx, '2026-07-27');
    await seedStrategyAdvice(ctx, '2026-07-27');

    const result = await generateClosingSnapshot({ date: '2026-07-27', notify: false }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const section = result.data.report.sections.find((item) => item.key === 'strategy-actions');
    expect(section).toMatchObject({
      title: '策略行动',
      required: true,
      status: 'complete',
      missingDimensions: [],
    });
    const table = section?.blocks.find((block) => block.kind === 'table');
    expect(table?.kind === 'table' ? table.rows : []).toEqual([
      {
        strategy: '收盘策略',
        selectedCount: 1,
        signalCount: 1,
        analysis: '已有 1 条建议；无批次审计',
      },
    ]);
    const list = section?.blocks.find((block) => block.kind === 'list');
    expect(list?.kind === 'list' ? list.items : []).toEqual([
      expect.objectContaining({
        title: '贵州茅台',
        entityKind: 'advice',
        entityId: 'closing-strategy-advice-2026-07-27',
      }),
    ]);
    const item = list?.kind === 'list' ? list.items[0] : undefined;
    expect(item?.detail).toContain('买入');
    expect(item?.detail).toContain('买点 10.5');
    expect(item?.detail).toContain('卖点 12');
    expect(item?.detail).toContain('止损 9.8');
    expect(item?.detail).toContain('策略信号触发且量价配合');
    const text = section?.blocks.find((block) => block.kind === 'text');
    expect(text?.kind === 'text' ? text.text : '').toContain('AI 买入判断');
    const serialized = JSON.stringify(section?.blocks);
    for (const field of [
      '"decision"',
      '"positionSize"',
      '"stopLoss"',
      '"takeProfit"',
      '"confidence"',
    ]) {
      expect(serialized).not.toContain(field);
    }
  });

  it('当日无策略运行且无策略 Advice 时退化为事实说明，不算缺失', async () => {
    const ctx = await buildTestContext({ clock: () => now, ashareSentiment: sentimentManager() });

    const result = await generateClosingSnapshot({ date: '2026-07-27', notify: false }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const section = result.data.report.sections.find((item) => item.key === 'strategy-actions');
    expect(section).toMatchObject({
      required: true,
      status: 'complete',
      missingDimensions: [],
    });
    const table = section?.blocks.find((block) => block.kind === 'table');
    expect(table?.kind === 'table' ? table.rows : []).toEqual([]);
    const list = section?.blocks.find((block) => block.kind === 'list');
    expect(list?.kind === 'list' ? list.items : []).toEqual([]);
    const text = section?.blocks.find((block) => block.kind === 'text');
    expect(text?.kind === 'text' ? text.text : '').toContain('今日尚无策略建议');
  });

  it('有信号但未生成建议时显示待分析事实，不推断不存在买入机会', async () => {
    const ctx = await buildTestContext({ clock: () => now, ashareSentiment: sentimentManager() });
    await seedStrategyWithPublishedRun(ctx, '2026-07-27');
    const result = await generateClosingSnapshot({ date: '2026-07-27', notify: false }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const section = result.data.report.sections.find((item) => item.key === 'strategy-actions');
    expect(JSON.stringify(section?.blocks)).not.toContain('无值得买入');
    expect(JSON.stringify(section?.blocks)).toContain('未分析');
    expect(
      section?.blocks.some(
        (block) => block.kind === 'list' && block.items.some((item) => item.entityKind === 'stock'),
      ),
    ).toBe(true);
  });

  it('已启用调度但当天没有正式运行时，策略研究缺失使报告保持 partial', async () => {
    const ctx = await buildTestContext({ clock: () => now, ashareSentiment: sentimentManager() });
    await seedStrategyWithPublishedRun(ctx, '2026-07-27', { skipRun: true });
    await ctx.repos.strategySchedule.save({
      id: 'strategy-schedule:closing-strategy',
      strategyId: 'closing-strategy',
      cron: '30 16 * * 1-5',
      timezone: 'Asia/Shanghai',
      enabled: true,
      nextRunAt: new Date('2026-07-28T08:30:00.000Z'),
      createdAt: new Date('2026-07-27T01:00:00.000Z'),
      updatedAt: now,
    });

    const result = await generateClosingSnapshot({ date: '2026-07-27', notify: false }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const section = result.data.report.sections.find((item) => item.key === 'strategy-actions');
    expect(section).toMatchObject({ required: true, status: 'partial' });
    expect(section?.missingDimensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dimension: 'strategy-actions.run.closing-strategy' }),
      ]),
    );
    expect(result.data.report.status).toBe('partial');
  });

  it('正式运行使用上一交易日收盘数据时，仍归属运行当日', async () => {
    const ctx = await buildTestContext({ clock: () => now, ashareSentiment: sentimentManager() });
    await seedStrategyWithPublishedRun(ctx, '2026-07-27', {
      runDataAsOf: new Date('2026-07-24T07:00:00.000Z'),
    });
    await ctx.repos.strategySchedule.save({
      id: 'strategy-schedule:closing-strategy',
      strategyId: 'closing-strategy',
      cron: '30 16 * * 1-5',
      timezone: 'Asia/Shanghai',
      enabled: true,
      nextRunAt: new Date('2026-07-28T08:30:00.000Z'),
      createdAt: new Date('2026-07-27T01:00:00.000Z'),
      updatedAt: now,
    });

    const result = await generateClosingSnapshot({ date: '2026-07-27', notify: false }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const section = result.data.report.sections.find((item) => item.key === 'strategy-actions');
    const table = section?.blocks.find((block) => block.kind === 'table');
    expect(table?.kind === 'table' ? table.rows[0]?.selectedCount : null).toBe(1);
    expect(
      section?.missingDimensions.some(
        (gap) => gap.dimension === 'strategy-actions.run.closing-strategy',
      ),
    ).toBe(false);
  });

  it('预定运行时间尚未到达时，将策略研究标为待运行的 partial', async () => {
    const beforeSchedule = new Date('2026-07-27T08:00:00.000Z');
    const ctx = await buildTestContext({
      clock: () => beforeSchedule,
      ashareSentiment: sentimentManager(),
    });
    await seedStrategyWithPublishedRun(ctx, '2026-07-27', { skipRun: true });
    await ctx.repos.strategySchedule.save({
      id: 'strategy-schedule:closing-strategy',
      strategyId: 'closing-strategy',
      cron: '30 16 * * 1-5',
      timezone: 'Asia/Shanghai',
      enabled: true,
      nextRunAt: new Date('2026-07-27T08:30:00.000Z'),
      createdAt: new Date('2026-07-27T01:00:00.000Z'),
      updatedAt: beforeSchedule,
    });

    const result = await generateClosingSnapshot({ date: '2026-07-27', notify: false }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const section = result.data.report.sections.find((item) => item.key === 'strategy-actions');
    expect(section).toMatchObject({ required: true, status: 'partial' });
    expect(section?.missingDimensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: 'strategy-actions.run.closing-strategy',
          reason: '预期策略今日尚未到运行时间',
        }),
      ]),
    );
  });

  it('策略数据读取失败时策略行动 section unavailable，且不改变整份报告状态', async () => {
    const controlCtx = await buildTestContext({
      clock: () => now,
      ashareSentiment: sentimentManager(),
    });
    const control = await generateClosingSnapshot(
      { date: '2026-07-27', notify: false },
      controlCtx,
    );
    const baseCtx = await buildTestContext({
      clock: () => now,
      ashareSentiment: sentimentManager(),
    });
    const failingStrategyRepo = new Proxy(baseCtx.repos.strategy, {
      get: (target, property, receiver) => {
        if (property === 'list') {
          return async () => {
            throw new Error('strategy store down');
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const failingCtx: ToolContext = {
      ...baseCtx,
      repos: { ...baseCtx.repos, strategy: failingStrategyRepo },
    };

    const broken = await generateClosingSnapshot({ date: '2026-07-27', notify: false }, failingCtx);

    expect(control.ok).toBe(true);
    expect(broken.ok).toBe(true);
    if (!control.ok || !broken.ok) return;
    const controlSection = control.data.report.sections.find(
      (item) => item.key === 'strategy-actions',
    );
    expect(controlSection?.status).toBe('complete');
    const section = broken.data.report.sections.find((item) => item.key === 'strategy-actions');
    expect(section?.status).toBe('unavailable');
    expect(
      section?.blocks.every((block) => block.kind === 'text' && block.tone === 'warning'),
    ).toBe(true);
    expect(broken.data.report.missingDimensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dimension: 'strategy-actions.strategies' }),
      ]),
    );
    expect(broken.data.report.status).toBe(control.data.report.status);
  });
});
