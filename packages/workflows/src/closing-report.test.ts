import {
  type AShareSentimentManagerLike,
  type AShareSentimentSnapshot,
  STANDARD_DISCLAIMERS,
  type StrategyDslV1,
  type StrategyVersion,
  strategyDefinitionHash,
  type ToolContext,
} from '@luoome/core';
import { createWatchlistTool, syncWatchlistSourceTool } from '@luoome/tools';
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
    decision: 'watch',
    confidence: 60,
    horizon: 'short',
    reasoning: {
      premise: '策略信号触发且量价配合，建议观察。',
      evidence: ['fixture evidence'],
      counterEvidence: ['fixture counter'],
    },
    risks: ['fixture risk'],
    disclaimers: [...STANDARD_DISCLAIMERS],
    sourceTool: 'analyze_strategy_candidate',
    basedOn: { dataAsOf: createdAt },
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
      'group-changes',
      'advice-expiry',
      'strategy-actions',
      'next-events',
    ]);
    expect(
      JSON.stringify(result.data.report.sections.flatMap((section) => section.blocks)),
    ).not.toContain('买入');
  });

  it('从真实 Watchlist 变化工具生成分组变化表', async () => {
    const ctx = await buildTestContext({
      clock: () => now,
      ashareSentiment: { status: () => [], fetch: async () => ({ ok: true, data: snapshot() }) },
    });
    const created = await createWatchlistTool.execute(
      {
        id: 'closing-watch',
        name: '收盘观察',
        kind: 'strategy',
        membershipPolicy: 'synced',
      },
      ctx,
    );
    expect(created.ok).toBe(true);
    const synced = await syncWatchlistSourceTool.execute(
      {
        watchlistId: 'closing-watch',
        sourceKind: 'ai',
        sourceKey: 'ai:closing',
        status: 'complete',
        candidates: [{ stockId: '600519.SH', reason: '收盘入选', evidence: ['fixture'] }],
      },
      ctx,
    );
    expect(synced.ok).toBe(true);

    const result = await closingReportWorkflow.run({ date: '2026-07-27', notify: false }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const groupChanges = result.data.report.sections.find(
      (section) => section.key === 'group-changes',
    );
    expect(groupChanges).toMatchObject({ status: 'complete', missingDimensions: [] });
    expect(groupChanges?.blocks[0]).toMatchObject({
      kind: 'table',
      rows: [
        { watchlist: '收盘观察', entered: 1, exited: 0, unchanged: 0, runs: 1, status: 'complete' },
      ],
    });
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
      { strategy: '收盘策略', selectedCount: 1, signalCount: 1 },
    ]);
    const list = section?.blocks.find((block) => block.kind === 'list');
    expect(list?.kind === 'list' ? list.items : []).toEqual([
      expect.objectContaining({
        title: '贵州茅台',
        entityKind: 'advice',
        entityId: 'closing-strategy-advice-2026-07-27',
      }),
    ]);
    const text = section?.blocks.find((block) => block.kind === 'text');
    expect(text?.kind === 'text' ? text.text : '').toContain('策略信号触发且量价配合');
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
    expect(text?.kind === 'text' ? text.text : '').toContain('无策略建议');
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
