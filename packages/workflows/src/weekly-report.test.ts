import {
  type AShareSentimentManagerLike,
  type AShareSentimentSnapshot,
  money,
  type SignalObservation,
  type StrategyDslV1,
  type StrategyVersion,
  strategyDefinitionHash,
  type ToolContext,
} from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { weeklyReportWorkflow } from './weekly-report.js';

const now = new Date('2026-07-31T11:00:00.000Z');

const snapshotFor = (date: string): AShareSentimentSnapshot => {
  const observedAt = new Date(`${date}T07:00:00.000Z`);
  return {
    date,
    coverage: 'CN_A_SHARES_SH_SZ',
    dataAsOf: observedAt,
    indexes: {
      status: 'complete',
      provenance: [
        {
          provider: 'fixture-index',
          observedAt,
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
          observedAt,
          fetchedAt: now,
          freshness: 'fresh',
        },
      ],
      warnings: [],
      value: {
        sealedCount: 10,
        brokenCount: 2,
        brokenRate: 1 / 6,
        maxLadderLevel: 3,
        totalSealAmount: 500_000_000,
        boardDistribution: { '1': 8, '2': 1, '3': 1 },
        leaders: [],
      },
    },
    themes: {
      status: 'partial',
      provenance: [
        {
          provider: 'fixture-limit-up',
          observedAt,
          fetchedAt: now,
          freshness: 'fresh',
        },
      ],
      warnings: ['concept themes unavailable'],
      value: { industries: [], concepts: [] },
    },
  };
};

const completeSignalObservation = (): SignalObservation => ({
  id: 'weekly-signal-complete',
  sourceKind: 'strategy-signal',
  sourceId: 'weekly-strategy-signal',
  stockId: '600519.SH',
  baselinePrice: 100,
  baselineAt: new Date('2026-07-28T08:00:00.000Z'),
  horizon: 't1',
  closePrice: 110,
  returnPct: 0.1,
  maxFavorableExcursionPct: 0.12,
  maxAdverseExcursionPct: -0.02,
  benchmarkReturnPct: 0.02,
  benchmarkStatus: 'complete',
  status: 'complete',
  provenance: {
    provider: 'weekly-fixture',
    observedAt: new Date('2026-07-29T08:00:00.000Z'),
    fetchedAt: now,
    freshness: 'fresh',
  },
  observedAt: new Date('2026-07-29T08:00:00.000Z'),
});

const pendingSignalObservation = (): SignalObservation => ({
  id: 'weekly-signal-pending',
  sourceKind: 'strategy-signal',
  sourceId: 'weekly-strategy-signal-pending',
  stockId: '002594.SZ',
  baselinePrice: 50,
  baselineAt: new Date('2026-07-29T08:00:00.000Z'),
  horizon: 't1',
  benchmarkStatus: 'unavailable',
  status: 'pending',
  provenance: {
    provider: 'weekly-fixture',
    observedAt: new Date('2026-07-29T08:00:00.000Z'),
    fetchedAt: now,
    freshness: 'unknown',
  },
});

const seedStrategyWithPublishedRun = async (ctx: ToolContext): Promise<void> => {
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
    id: 'weekly-strategy-v1',
    strategyId: 'weekly-strategy',
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: new Date('2026-07-27T01:00:00.000Z'),
    createdAt: new Date('2026-07-27T01:00:00.000Z'),
  };
  await ctx.repos.strategy.create({
    id: 'weekly-strategy',
    name: '周复盘策略',
    description: 'test',
    owner: 'user',
    status: 'active',
    currentVersionId: version.id,
    createdAt: new Date('2026-07-27T01:00:00.000Z'),
    updatedAt: new Date('2026-07-27T01:00:00.000Z'),
  });
  await ctx.repos.strategy.createVersion(version);
  const startedAt = new Date('2026-07-28T07:30:00.000Z');
  const finishedAt = new Date('2026-07-28T07:31:00.000Z');
  await ctx.repos.strategyRun.commitRun({
    run: {
      id: 'weekly-strategy-run-1',
      strategyId: 'weekly-strategy',
      strategyVersionId: version.id,
      mode: 'scheduled',
      coverage: 'CN_A_SHARES_SH_SZ',
      dataAsOf: new Date('2026-07-28T07:00:00.000Z'),
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
        runId: 'weekly-strategy-run-1',
        stockId: '600519.SH',
        selected: true,
        score: 80,
        rank: 1,
        ruleEvaluations: [],
        evidence: ['fixture'],
        dataAsOf: new Date('2026-07-28T07:00:00.000Z'),
      },
    ],
    signals: [
      {
        id: 'weekly-review-signal-1',
        strategyId: 'weekly-strategy',
        strategyVersionId: version.id,
        runId: 'weekly-strategy-run-1',
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
  const observationBase: Omit<SignalObservation, 'id' | 'horizon' | 'benchmarkStatus'> = {
    sourceKind: 'strategy-signal',
    sourceId: 'weekly-review-signal-1',
    stockId: '600519.SH',
    baselinePrice: 100,
    baselineAt: new Date('2026-07-28T08:00:00.000Z'),
    closePrice: 110,
    returnPct: 0.1,
    maxFavorableExcursionPct: 0.12,
    maxAdverseExcursionPct: -0.02,
    status: 'complete',
    provenance: {
      provider: 'weekly-fixture',
      observedAt: new Date('2026-07-29T08:00:00.000Z'),
      fetchedAt: now,
      freshness: 'fresh',
    },
    observedAt: new Date('2026-07-29T08:00:00.000Z'),
  };
  await ctx.repos.signalObservation.save({
    ...observationBase,
    id: 'weekly-review-observation-t1',
    horizon: 't1',
    benchmarkReturnPct: 0.02,
    benchmarkStatus: 'complete',
  });
  await ctx.repos.signalObservation.save({
    ...observationBase,
    id: 'weekly-review-observation-t3',
    horizon: 't3',
    benchmarkStatus: 'unavailable',
  });
};

describe('weekly-report workflow', () => {
  it('按本周真实交易日生成趋势，不把自然日周末纳入周期', async () => {
    const requestedDates: string[] = [];
    const manager: AShareSentimentManagerLike = {
      status: () => [],
      fetch: async (input) => {
        requestedDates.push(input.date);
        return { ok: true, data: snapshotFor(input.date) };
      },
    };
    const ctx = await buildTestContext({ clock: () => now, ashareSentiment: manager });

    const result = await weeklyReportWorkflow.run({ periodEnd: '2026-07-31', notify: false }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(requestedDates).toEqual([
      '2026-07-27',
      '2026-07-28',
      '2026-07-29',
      '2026-07-30',
      '2026-07-31',
    ]);
    expect(result.data.report).toMatchObject({
      kind: 'weekly',
      periodStart: '2026-07-27',
      periodEnd: '2026-07-31',
      status: 'partial',
      dataAsOf: new Date('2026-07-27T07:00:00.000Z'),
    });
    expect(result.data.report.sections.map((section) => section.key)).toEqual([
      'market-week',
      'account-week',
      'alert-feedback',
      'signal-outcomes',
      'strategy-review',
      'strategy-autonomy-actions',
      'advice-outcomes',
      'trade-attribution',
      'behavior-patterns',
      'data-quality',
      'research-changes',
      'next-week-events',
    ]);
    const marketWeek = result.data.report.sections.find((section) => section.key === 'market-week');
    const table = marketWeek?.blocks.find((block) => block.kind === 'table');
    // 表格列无 unit 元数据，炸板率在构建期已格式化为百分比字符串
    expect(table?.kind === 'table' ? table.rows[0]?.brokenRate : undefined).toBe('16.7%');
    const accountWeek = result.data.report.sections.find(
      (section) => section.key === 'account-week',
    );
    const accountMetrics = accountWeek?.blocks.find((block) => block.kind === 'metrics');
    expect(
      accountWeek?.missingDimensions.some((item) => item.errorKind === 'not_implemented'),
    ).toBe(false);
    expect(
      accountMetrics?.kind === 'metrics' ? accountMetrics.items.map((item) => item.key) : [],
    ).toEqual(expect.arrayContaining(['periodStartValue', 'periodTwrPct', 'maxDrawdownPct']));
    const signalOutcomes = result.data.report.sections.find(
      (section) => section.key === 'signal-outcomes',
    );
    expect(signalOutcomes?.status).toBe('partial');
    expect(signalOutcomes?.missingDimensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: 'signal-outcomes.samples',
          errorKind: 'no_data',
        }),
      ]),
    );
    const signalMetrics = signalOutcomes?.blocks.find((block) => block.kind === 'metrics');
    expect(
      signalMetrics?.kind === 'metrics'
        ? signalMetrics.items.find((item) => item.key === 'missingRate')?.value
        : undefined,
    ).toBeNull();
    const adviceOutcomes = result.data.report.sections.find(
      (section) => section.key === 'advice-outcomes',
    );
    expect(adviceOutcomes?.status).toBe('partial');
    expect(adviceOutcomes?.missingDimensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: 'advice-outcomes.pending',
          errorKind: 'outcome_pending',
        }),
      ]),
    );
    const adviceMetrics = adviceOutcomes?.blocks.find((block) => block.kind === 'metrics');
    expect(
      adviceMetrics?.kind === 'metrics'
        ? adviceMetrics.items.find((item) => item.key === 'totalAdvices')?.value
        : undefined,
    ).toBe(2);
    expect(
      adviceMetrics?.kind === 'metrics'
        ? adviceMetrics.items.find((item) => item.key === 'outcomeMissingRate')?.value
        : undefined,
    ).toBe(1);
    const tradeAttribution = result.data.report.sections.find(
      (section) => section.key === 'trade-attribution',
    );
    expect(tradeAttribution?.status).toBe('partial');
    expect(tradeAttribution?.missingDimensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: 'trade-attribution.samples',
          errorKind: 'no_data',
        }),
      ]),
    );
    const tradeMetrics = tradeAttribution?.blocks.find((block) => block.kind === 'metrics');
    expect(
      tradeMetrics?.kind === 'metrics'
        ? tradeMetrics.items.find((item) => item.key === 'attributionRate')?.value
        : undefined,
    ).toBeNull();
    const behaviorPatterns = result.data.report.sections.find(
      (section) => section.key === 'behavior-patterns',
    );
    expect(behaviorPatterns?.status).toBe('partial');
    expect(behaviorPatterns?.missingDimensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: 'behavior-patterns.account-scope',
          errorKind: 'scope_unavailable',
        }),
      ]),
    );
    const dataQuality = result.data.report.sections.find(
      (section) => section.key === 'data-quality',
    );
    expect(dataQuality?.status).toBe('partial');
    expect(dataQuality?.missingDimensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: 'data-quality.signal-account-scope',
          errorKind: 'scope_unavailable',
        }),
      ]),
    );
    const researchChanges = result.data.report.sections.find(
      (section) => section.key === 'research-changes',
    );
    expect(researchChanges?.missingDimensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          errorKind: 'global_version_query_unavailable',
          reason: expect.stringContaining('可靠的全局研究版本查询能力'),
        }),
      ]),
    );
  });

  it('将 signal observation 和 Advice outcome 以描述性统计写入周报', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await ctx.repos.signalObservation.save(completeSignalObservation());
    await ctx.repos.signalObservation.save(pendingSignalObservation());
    const advices = await ctx.repos.advice.query({ includeExpired: true, limit: 500 });
    const [followed, ignored] = advices;
    if (followed === undefined || ignored === undefined) throw new Error('fixture advice missing');
    await ctx.repos.advice.recordOutcome(followed.id, {
      adviceId: followed.id,
      tradeIds: [],
      outcome: 'followed',
      pnl: money(100),
      benchmarkPnl: money(20),
      recordedAt: now,
    });
    await ctx.repos.advice.recordOutcome(ignored.id, {
      adviceId: ignored.id,
      tradeIds: [],
      outcome: 'ignored',
      recordedAt: now,
    });

    const result = await weeklyReportWorkflow.run({ periodEnd: '2026-07-31', notify: false }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const signal = result.data.report.sections.find((section) => section.key === 'signal-outcomes');
    expect(signal?.status).toBe('partial');
    const signalMetrics = signal?.blocks.find((block) => block.kind === 'metrics');
    expect(signalMetrics?.kind === 'metrics' ? signalMetrics.items : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'total', value: 2 }),
        expect.objectContaining({ key: 'complete', value: 1 }),
        expect.objectContaining({ key: 'missingRate', value: 0.5 }),
      ]),
    );
    const signalTable = signal?.blocks.find((block) => block.kind === 'table');
    expect(signalTable?.kind === 'table' ? signalTable.rows : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          horizon: 't1',
          averageReturnPct: 0.1,
          averageBenchmarkReturnPct: 0.02,
          averageExcessReturnPct: 0.08,
        }),
      ]),
    );
    expect(signal?.evidenceIds).toContain('signal-outcomes:stats');

    const advice = result.data.report.sections.find((section) => section.key === 'advice-outcomes');
    expect(advice?.status).toBe('complete');
    const adviceMetrics = advice?.blocks.find((block) => block.kind === 'metrics');
    expect(adviceMetrics?.kind === 'metrics' ? adviceMetrics.items : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'withOutcome', value: 2 }),
        expect.objectContaining({ key: 'pendingOutcome', value: 0 }),
        expect.objectContaining({ key: 'outcomeMissingRate', value: 0 }),
        expect.objectContaining({ key: 'knownPnlSamples', value: 1 }),
        expect.objectContaining({ key: 'knownBenchmarkPnlSamples', value: 1 }),
      ]),
    );
    expect(advice?.evidenceIds).toEqual(
      expect.arrayContaining(['advice-outcomes:advice', 'advice-outcomes:stats']),
    );
  });

  it('账户范围周报只投影指定账户的交易归因', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    const advice = (await ctx.repos.advice.query({ includeExpired: true, limit: 500 }))[0];
    const seedTrade = (await ctx.repos.trade.listByAccount(ctx.user.defaultAccountId))[0];
    if (advice === undefined || seedTrade === undefined) throw new Error('fixture fact missing');
    await ctx.repos.trade.save({
      ...seedTrade,
      id: 'weekly-attributed-trade',
      executedAt: new Date('2026-07-30T02:30:00.000Z'),
      adviceId: advice.id,
    });

    const result = await weeklyReportWorkflow.run(
      {
        periodEnd: '2026-07-31',
        scope: { kind: 'account', accountId: ctx.user.defaultAccountId },
        notify: false,
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tradeAttribution = result.data.report.sections.find(
      (section) => section.key === 'trade-attribution',
    );
    expect(tradeAttribution?.status).toBe('complete');
    const tradeMetrics = tradeAttribution?.blocks.find((block) => block.kind === 'metrics');
    expect(tradeMetrics?.kind === 'metrics' ? tradeMetrics.items : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'accountsRequested', value: 1 }),
        expect.objectContaining({ key: 'totalTrades', value: 1 }),
        expect.objectContaining({ key: 'attributedTrades', value: 1 }),
        expect.objectContaining({ key: 'attributionRate', value: 1 }),
        expect.objectContaining({ key: 'unattributedTrades', value: 0 }),
      ]),
    );
    const tradeTable = tradeAttribution?.blocks.find((block) => block.kind === 'table');
    expect(tradeTable?.kind === 'table' ? tradeTable.rows : []).toHaveLength(0);
  });

  it('策略复盘 section 汇总策略级 T+N 观察统计并复用 AI 洞察文本', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedStrategyWithPublishedRun(ctx);

    const result = await weeklyReportWorkflow.run({ periodEnd: '2026-07-31', notify: false }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const section = result.data.report.sections.find((item) => item.key === 'strategy-review');
    expect(section).toMatchObject({
      title: '策略复盘',
      required: false,
      status: 'complete',
      missingDimensions: [],
    });
    const table = section?.blocks.find((block) => block.kind === 'table');
    const rows = table?.kind === 'table' ? table.rows : [];
    const t1 = rows.find((row) => row.horizon === 't1');
    expect(t1).toMatchObject({
      strategy: '周复盘策略',
      total: 1,
      complete: 1,
      benchmarkStatus: 'complete',
    });
    expect(
      typeof t1?.averageExcessReturnPct === 'number' ? t1.averageExcessReturnPct : 0,
    ).toBeCloseTo(0.08, 12);
    expect(rows.find((row) => row.horizon === 't3')).toMatchObject({
      strategy: '周复盘策略',
      complete: 1,
      averageExcessReturnPct: null,
      benchmarkStatus: 'unavailable',
    });
    const text = section?.blocks.find((block) => block.kind === 'text');
    const textValue = text?.kind === 'text' ? text.text : '';
    expect(textValue).toContain('策略事实观察');
    expect(textValue).toContain('样本不足');
    expect(textValue).toContain('benchmark 不可用');
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

  it('AI 不可用时策略复盘退化为 facts-only 摘要且 section 保持 complete', async () => {
    const baseCtx = await buildTestContext({ clock: () => now });
    await seedStrategyWithPublishedRun(baseCtx);
    const failingCtx: ToolContext = {
      ...baseCtx,
      adapters: {
        ...baseCtx.adapters,
        llm: {
          name: 'failing-llm',
          generate: async () => {
            throw new Error('provider unavailable');
          },
        },
      },
    };

    const result = await weeklyReportWorkflow.run(
      { periodEnd: '2026-07-31', notify: false },
      failingCtx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const section = result.data.report.sections.find((item) => item.key === 'strategy-review');
    expect(section).toMatchObject({
      required: false,
      status: 'complete',
      missingDimensions: [],
    });
    const text = section?.blocks.find((block) => block.kind === 'text');
    const textValue = text?.kind === 'text' ? text.text : '';
    expect(textValue).toContain('事实摘要');
    expect(textValue).toContain('AI 不可用');
  });

  it('策略运行读取失败时策略复盘 section unavailable，且不改变整份报告状态', async () => {
    const controlCtx = await buildTestContext({ clock: () => now });
    const control = await weeklyReportWorkflow.run(
      { periodEnd: '2026-07-31', notify: false },
      controlCtx,
    );
    const baseCtx = await buildTestContext({ clock: () => now });
    const failingRunRepo = new Proxy(baseCtx.repos.strategyRun, {
      get: (target, property, receiver) => {
        if (property === 'listRuns') {
          return async () => {
            throw new Error('strategy run store down');
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const failingCtx: ToolContext = {
      ...baseCtx,
      repos: { ...baseCtx.repos, strategyRun: failingRunRepo },
    };

    const broken = await weeklyReportWorkflow.run(
      { periodEnd: '2026-07-31', notify: false },
      failingCtx,
    );

    expect(control.ok).toBe(true);
    expect(broken.ok).toBe(true);
    if (!control.ok || !broken.ok) return;
    const controlSection = control.data.report.sections.find(
      (item) => item.key === 'strategy-review',
    );
    expect(controlSection?.status).toBe('complete');
    const section = broken.data.report.sections.find((item) => item.key === 'strategy-review');
    expect(section?.status).toBe('unavailable');
    expect(
      section?.blocks.every((block) => block.kind === 'text' && block.tone === 'warning'),
    ).toBe(true);
    expect(broken.data.report.missingDimensions).toEqual(
      expect.arrayContaining([expect.objectContaining({ dimension: 'strategy-review.runs' })]),
    );
    expect(broken.data.report.status).toBe(control.data.report.status);
  });

  it('AI 管理动作 section 列出本周动作与指标摘要，插在策略复盘之后', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    const createdAt = new Date('2026-07-29T02:00:00.000Z');
    await ctx.repos.strategyAutonomyAction.save({
      id: 'weekly-autonomy-pause-1',
      kind: 'pause',
      status: 'executed',
      strategyId: 'weekly-autonomy-strategy',
      trigger: 'weekly-review',
      ruleSnapshot: {
        sampleCount: 25,
        benchmarkCoverage: 0.96,
        avgExcessReturn: -0.012,
        medianExcessReturn: -0.008,
        thresholds: { minSampleCount: 20, minBenchmarkCoverage: 0.9 },
      },
      factReferences: [],
      attempts: 0,
      createdAt,
      updatedAt: createdAt,
      completedAt: createdAt,
    });

    const result = await weeklyReportWorkflow.run({ periodEnd: '2026-07-31', notify: false }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const keys = result.data.report.sections.map((item) => item.key);
    expect(keys.indexOf('strategy-autonomy-actions')).toBe(keys.indexOf('strategy-review') + 1);
    const section = result.data.report.sections.find(
      (item) => item.key === 'strategy-autonomy-actions',
    );
    expect(section).toMatchObject({
      title: 'AI 管理动作',
      required: false,
      status: 'complete',
    });
    const list = section?.blocks.find((block) => block.kind === 'list');
    const items = list?.kind === 'list' ? list.items : [];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      entityKind: 'strategy',
      entityId: 'weekly-autonomy-strategy',
    });
    expect(items[0]?.title).toContain('自动暂停');
    expect(items[0]?.detail).toContain('weekly-autonomy-strategy');
    expect(items[0]?.detail).toContain('完整样本 25');
    expect(items[0]?.detail).toContain('平均超额 -1.20%');
  });

  it('本周无动作时 AI 管理动作 section 输出 factual 空态文本', async () => {
    const ctx = await buildTestContext({ clock: () => now });

    const result = await weeklyReportWorkflow.run({ periodEnd: '2026-07-31', notify: false }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const section = result.data.report.sections.find(
      (item) => item.key === 'strategy-autonomy-actions',
    );
    expect(section).toMatchObject({ required: false, status: 'complete' });
    const list = section?.blocks.find((block) => block.kind === 'list');
    expect(list?.kind === 'list' ? list.items : []).toHaveLength(0);
    const text = section?.blocks.find((block) => block.kind === 'text');
    expect(text?.kind === 'text' ? text.text : '').toContain('本周没有 AI 管理动作');
  });
});
