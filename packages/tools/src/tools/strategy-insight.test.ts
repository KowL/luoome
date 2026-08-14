import { money, type StrategyDslV1, strategyDefinitionHash, type ToolContext } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext, seedTestStockUniverse } from '../testing/context.js';
import { generateStrategyInsightTool, getStrategyInsightFactsTool } from './strategy-insight.js';

const now = new Date('2026-08-08T10:00:00.000Z');
const definition: StrategyDslV1 = {
  schemaVersion: 1,
  metadata: { style: 'quality', horizon: 'short' },
  universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
  selection: {
    logic: 'all',
    rules: [{ id: 'quality', name: '质量门槛', when: 'quote.close > 10', evidence: ['收盘价'] }],
  },
  signals: { entry: [], exit: [], risk: [] },
};

const seedInsight = async (ctx: ToolContext): Promise<void> => {
  await seedTestStockUniverse(ctx);
  await ctx.repos.strategy.create({
    id: 'insight-strategy',
    name: '洞察策略',
    description: '洞察测试',
    owner: 'user',
    status: 'active',
    currentVersionId: 'insight-strategy:v1',
    createdAt: now,
    updatedAt: now,
  });
  await ctx.repos.strategy.createVersion({
    id: 'insight-strategy:v1',
    strategyId: 'insight-strategy',
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: now,
    createdAt: now,
  });
  const evaluation = (stockId: string, status: 'matched' | 'not-matched') => ({
    schemaVersion: 2 as const,
    scope: 'selection' as const,
    ruleId: 'quality',
    status,
    expression: 'quote.close > 10',
    inputs: [
      {
        path: 'quote.close',
        status: 'available' as const,
        value: stockId === '600519.SH' ? 20 : 8,
      },
    ],
    evidence: ['收盘价'],
    explanation: {
      code: status,
      message: status === 'matched' ? '满足质量门槛' : '未满足质量门槛',
    },
  });
  await ctx.repos.strategyRun.commitRun({
    run: {
      id: 'insight-run-1',
      strategyId: 'insight-strategy',
      strategyVersionId: 'insight-strategy:v1',
      mode: 'scheduled',
      coverage: 'CN_A_SHARES_SH_SZ',
      dataAsOf: now,
      startedAt: new Date(now.getTime() - 60_000),
      finishedAt: now,
      status: 'complete',
      inputSnapshot: {},
      providerStatuses: [],
      summary: {
        schemaVersion: 3,
        dataHealth: 'complete',
        universeCount: 2,
        evaluatedCount: 2,
        selectedCount: 1,
        signalCount: 1,
        incompleteCount: 0,
        failedCount: 0,
        failureSamples: [],
      },
    },
    results: [
      {
        runId: 'insight-run-1',
        stockId: '600519.SH',
        selected: true,
        score: 82,
        rank: 1,
        ruleEvaluations: [evaluation('600519.SH', 'matched')],
        evidence: ['命中'],
        dataAsOf: now,
      },
      {
        runId: 'insight-run-1',
        stockId: '002594.SZ',
        selected: false,
        ruleEvaluations: [evaluation('002594.SZ', 'not-matched')],
        evidence: ['阻断'],
        dataAsOf: now,
      },
    ],
    signals: [
      {
        id: 'insight-signal-1',
        strategyId: 'insight-strategy',
        strategyVersionId: 'insight-strategy:v1',
        runId: 'insight-run-1',
        ruleId: 'quality',
        stockId: '600519.SH',
        ts: now,
        score: 82,
        direction: 'bullish',
        evidence: ['命中'],
        evaluationSnapshot: {},
      },
    ],
  });
  await ctx.repos.signalObservation.save({
    id: 'observation-1',
    sourceKind: 'strategy-signal',
    sourceId: 'insight-signal-1',
    stockId: '600519.SH',
    baselinePrice: money(100),
    baselineAt: new Date('2026-08-01T00:00:00.000Z'),
    horizon: 't1',
    closePrice: money(105),
    returnPct: 0.05,
    maxFavorableExcursionPct: 0.08,
    maxAdverseExcursionPct: -0.02,
    benchmarkStatus: 'unavailable',
    status: 'complete',
    provenance: {
      provider: 'fixture',
      observedAt: new Date('2026-08-02T00:00:00.000Z'),
      fetchedAt: now,
      freshness: 'fresh',
    },
    observedAt: new Date('2026-08-02T00:00:00.000Z'),
  });
  await ctx.repos.alertPlan.save({
    id: 'insight-alert',
    name: '洞察预警',
    watchlistId: 'watchlist-1',
    rules: [
      {
        id: 'strategy-signal-rule',
        kind: 'strategy-signal',
        strategyId: 'insight-strategy',
        minScore: 60,
      },
    ],
    logic: 'ANY',
    triggerMode: 'on-enter',
    cooldownMinutes: 30,
    dailyNotificationLimit: 10,
    notifyOnRecovery: false,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
};

describe('strategy insight', () => {
  it('汇总运行、阻断、真实表现和关联预警事实', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedInsight(ctx);

    const result = await getStrategyInsightFactsTool.execute(
      { strategyId: 'insight-strategy' },
      ctx,
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        runs: { total: 1, usable: 1, failed: 0 },
        currentSelection: { selectedCount: 1, averageScore: 82 },
        blockers: [{ ruleId: 'quality', count: 1 }],
        alertPlans: [{ id: 'insight-alert', enabled: true }],
      },
    });
    expect(
      result.ok && result.data.observations.find((item) => item.horizon === 't1'),
    ).toMatchObject({
      sampleUnit: 'stock-day-horizon',
      complete: 1,
      averageReturnPct: 0.05,
      benchmarkStatus: 'unavailable',
    });
    expect(
      result.ok &&
        result.data.groupedObservations.some(
          (item) => item.dimension === 'market-state' && item.group === 'benchmark-unavailable',
        ),
    ).toBe(true);
  });

  it('AI 输出只能引用事实层提供的 fact id', async () => {
    const base = await buildTestContext({ clock: () => now });
    await seedInsight(base);
    const ctx: ToolContext = {
      ...base,
      adapters: {
        ...base.adapters,
        llm: {
          name: 'fixture-insight',
          generate: async <T>() =>
            ({
              headline: '质量门槛是主要阻断',
              summary: '依据运行事实进行解释。',
              findings: [
                {
                  kind: 'risk',
                  title: '阻断集中',
                  detail: '质量门槛出现一次阻断。',
                  factRefs: ['blocker:quality'],
                },
              ],
              risks: ['样本较少'],
              limitations: ['不是回测'],
              disclaimer: '仅供研究，不构成投资建议。',
            }) as T,
        },
      },
    };

    const result = await generateStrategyInsightTool.execute(
      { strategyId: 'insight-strategy' },
      ctx,
    );

    expect(result).toMatchObject({
      ok: true,
      data: { insight: { findings: [{ factRefs: ['blocker:quality'] }] } },
    });
  });

  it('AI 两次虚构事实引用后降级 facts-only', async () => {
    const base = await buildTestContext({ clock: () => now });
    await seedInsight(base);
    const ctx: ToolContext = {
      ...base,
      adapters: {
        ...base.adapters,
        llm: {
          name: 'bad-insight',
          generate: async <T>() =>
            ({
              headline: '虚构结论',
              summary: '无依据',
              findings: [
                { kind: 'trend', title: '虚构', detail: '无依据', factRefs: ['invented:fact'] },
              ],
              risks: [],
              limitations: [],
              disclaimer: '仅供研究，不构成投资建议。',
            }) as T,
        },
      },
    };

    expect(
      await generateStrategyInsightTool.execute({ strategyId: 'insight-strategy' }, ctx),
    ).toMatchObject({ ok: true, data: { provider: 'facts-only' } });
  });

  it('模型调用失败后降级为 facts-only', async () => {
    const base = await buildTestContext({ clock: () => now });
    await seedInsight(base);
    const ctx: ToolContext = {
      ...base,
      adapters: {
        ...base.adapters,
        llm: {
          name: 'offline-insight',
          generate: async <T>() => Promise.reject<T>(new Error('provider unavailable')),
        },
      },
    };

    expect(
      await generateStrategyInsightTool.execute({ strategyId: 'insight-strategy' }, ctx),
    ).toMatchObject({ ok: true, data: { provider: 'facts-only' } });
  });
});
