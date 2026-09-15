import {
  type AShareSentimentManagerLike,
  type AShareSentimentSnapshot,
  money,
  STANDARD_DISCLAIMERS,
  type StrategyDslV1,
  type StrategyVersion,
  strategyDefinitionHash,
  type ToolContext,
  TradingPlanSchema,
} from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { closingReportWorkflow } from './closing-report.js';

const now = new Date('2026-07-27T10:00:00.000Z');
const marketAsOf = new Date('2026-07-27T07:00:00.000Z');

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

const seedStrategyWithPublishedRun = async (ctx: ToolContext, date: string): Promise<void> => {
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
      dataAsOf: new Date(`${date}T07:00:00.000Z`),
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
        dataAsOf: new Date(`${date}T07:00:00.000Z`),
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

    const result = await closingReportWorkflow.run({ date: '2026-07-27', notify: false }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(requestedDates).toEqual(['2026-07-27']);
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

  it('scheduled 模式对同键已投递报告幂等，不重复生成与投递', async () => {
    const ctx = await buildTestContext({ clock: () => now, ashareSentiment: sentimentManager() });
    const first = await closingReportWorkflow.run(
      { date: '2026-07-27', notify: false, mode: 'scheduled' },
      ctx,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.created).toBe(true);
    await ctx.repos.report.setDeliveryStatus(first.data.report.id, 'sent');

    const second = await closingReportWorkflow.run(
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

    const result = await closingReportWorkflow.run({ date: '2026-07-27', notify: false }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const section = result.data.report.sections.find((item) => item.key === 'trading-plans');
    expect(section?.status).toBe('complete');
    const list = section?.blocks.find((block) => block.kind === 'list');
    expect(list?.kind === 'list' ? list.items : []).toEqual([
      {
        title: '贵州茅台 · enter · v2',
        detail: '入场 98-103 · 目标 8% · active',
        entityKind: 'trading-plan',
        entityId: 'account:acc-1:stock:600519.SH:v2',
      },
    ]);
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
    const result = await closingReportWorkflow.run({ date: '2026-07-27', notify: false }, ctx);
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

    const result = await closingReportWorkflow.run({ date: '2026-07-27', notify: false }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const section = result.data.report.sections.find((item) => item.key === 'strategy-actions');
    expect(section).toMatchObject({
      title: '策略行动',
      required: false,
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

    const result = await closingReportWorkflow.run({ date: '2026-07-27', notify: false }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const section = result.data.report.sections.find((item) => item.key === 'strategy-actions');
    expect(section).toMatchObject({
      required: false,
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
    const result = await closingReportWorkflow.run({ date: '2026-07-27', notify: false }, ctx);
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

  it('策略数据读取失败时策略行动 section unavailable，且不改变整份报告状态', async () => {
    const controlCtx = await buildTestContext({
      clock: () => now,
      ashareSentiment: sentimentManager(),
    });
    const control = await closingReportWorkflow.run(
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

    const broken = await closingReportWorkflow.run(
      { date: '2026-07-27', notify: false },
      failingCtx,
    );

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
