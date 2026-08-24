import {
  money,
  quantity,
  STANDARD_DISCLAIMERS,
  type Strategy,
  type StrategyDslV1,
  type StrategyVersion,
  strategyDefinitionHash,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { getStrategyDecisionCyclesTool } from './get-strategy-decision-cycles.js';

const NOW = new Date('2026-08-08T10:00:00.000Z');
const STRATEGY_ID = 'cycle-strategy';
const VERSION_ID = 'cycle-strategy-v1';
const RUN_ID = 'cycle-run-1';
const STOCK_ID = '002594.SZ';

const definition: StrategyDslV1 = {
  schemaVersion: 1,
  metadata: {},
  universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
  selection: {
    logic: 'all',
    rules: [
      { id: 'positive-price', name: '价格有效', when: 'quote.close > 0', evidence: ['价格有效'] },
    ],
  },
  scoring: {
    method: 'weighted-sum',
    components: [{ ruleId: 'positive-price', score: '50', weight: 1 }],
  },
  signals: {
    entry: [
      {
        id: 'entry',
        name: '研究信号',
        when: 'quote.close > 0',
        score: '60',
        direction: 'bullish',
        evidence: ['研究事实'],
      },
    ],
    exit: [],
    risk: [],
  },
};

const seedStrategy = async (ctx: Awaited<ReturnType<typeof buildTestContext>>) => {
  const version: StrategyVersion = {
    id: VERSION_ID,
    strategyId: STRATEGY_ID,
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: NOW,
    createdAt: NOW,
  };
  const strategy: Strategy = {
    id: STRATEGY_ID,
    name: '闭环测试策略',
    description: '测试候选闭环投影',
    owner: 'user',
    status: 'active',
    currentVersionId: VERSION_ID,
    createdAt: NOW,
    updatedAt: NOW,
  };
  await ctx.repos.strategy.create(strategy);
  await ctx.repos.strategy.createVersion(version);
  await ctx.repos.strategyRun.commitRun({
    run: {
      id: RUN_ID,
      strategyId: STRATEGY_ID,
      strategyVersionId: VERSION_ID,
      mode: 'scheduled',
      coverage: 'CN_A_SHARES_SH_SZ',
      dataAsOf: new Date('2026-08-07T10:00:00.000Z'),
      startedAt: new Date('2026-08-07T10:05:00.000Z'),
      finishedAt: new Date('2026-08-07T10:10:00.000Z'),
      status: 'complete',
      scope: 'operational',
      inputSnapshot: {},
      providerStatuses: [],
      summary: {},
      publication: { status: 'published', reasons: [], decidedAt: NOW },
    },
    results: [
      {
        runId: RUN_ID,
        stockId: STOCK_ID,
        selected: true,
        score: 82,
        rank: 1,
        ruleEvaluations: [],
        evidence: ['result-fact'],
        dataAsOf: new Date('2026-08-07T10:00:00.000Z'),
      },
    ],
    signals: [
      {
        id: 'cycle-signal-1',
        strategyId: STRATEGY_ID,
        strategyVersionId: VERSION_ID,
        runId: RUN_ID,
        ruleId: 'entry',
        stockId: STOCK_ID,
        ts: new Date('2026-08-07T10:00:00.000Z'),
        score: 80,
        direction: 'bullish',
        evidence: ['signal-fact'],
        evaluationSnapshot: { source: 'fixture' },
      },
    ],
  });
};

const provenance = {
  provider: 'fixture',
  observedAt: new Date('2026-08-07T10:00:00.000Z'),
  fetchedAt: NOW,
  freshness: 'fresh' as const,
};

const seedFacts = async (ctx: Awaited<ReturnType<typeof buildTestContext>>) => {
  await ctx.repos.signalObservation.save({
    id: 'cycle-observation-t1',
    sourceKind: 'strategy-signal',
    sourceId: 'cycle-signal-1',
    stockId: STOCK_ID,
    baselinePrice: 100,
    baselineAt: new Date('2026-08-07T10:00:00.000Z'),
    horizon: 't1',
    closePrice: 105,
    returnPct: 0.05,
    maxFavorableExcursionPct: 0.08,
    maxAdverseExcursionPct: -0.02,
    benchmarkReturnPct: 0.01,
    benchmarkStatus: 'complete',
    status: 'complete',
    provenance,
    observedAt: new Date('2026-08-08T10:00:00.000Z'),
    dueAt: new Date('2026-08-08T10:00:00.000Z'),
  });
  await ctx.repos.signalObservation.save({
    id: 'cycle-observation-t3',
    sourceKind: 'strategy-signal',
    sourceId: 'cycle-signal-1',
    stockId: STOCK_ID,
    baselinePrice: 100,
    baselineAt: new Date('2026-08-07T10:00:00.000Z'),
    horizon: 't3',
    benchmarkStatus: 'unavailable',
    status: 'pending',
    provenance: { ...provenance, freshness: 'unknown' as const },
    dueAt: new Date('2026-08-12T10:00:00.000Z'),
  });
  await ctx.repos.signalObservation.save({
    id: 'cycle-observation-t5',
    sourceKind: 'strategy-signal',
    sourceId: 'cycle-signal-1',
    stockId: STOCK_ID,
    horizon: 't5',
    benchmarkStatus: 'unavailable',
    status: 'unavailable',
    provenance: { ...provenance, freshness: 'unavailable' as const },
    unavailableReason: '缺少后续行情事实',
  });
};

const seedAdviceAndTrades = async (ctx: Awaited<ReturnType<typeof buildTestContext>>) => {
  const adviceId = 'cycle-advice-1';
  await ctx.repos.advice.save({
    id: adviceId,
    subjectKind: 'stock',
    subjectId: STOCK_ID,
    decision: 'watch',
    confidence: 76,
    horizon: 'short',
    reasoning: {
      premise: '等待事实确认',
      evidence: ['result-fact'],
      counterEvidence: ['样本有限'],
    },
    risks: ['市场风险'],
    disclaimers: [...STANDARD_DISCLAIMERS],
    sourceTool: 'analyze_strategy_candidate',
    basedOn: {
      dataAsOf: NOW,
      strategy: {
        strategyId: STRATEGY_ID,
        strategyVersionId: VERSION_ID,
        runId: RUN_ID,
        stockId: STOCK_ID,
        score: 82,
        rank: 1,
        resultEvidence: ['result-fact'],
        signalIds: ['cycle-signal-1'],
        observationIds: ['cycle-observation-t1', 'cycle-observation-t3'],
        recommendationTrigger: 'run',
      },
    },
    validFrom: NOW,
    validUntil: new Date('2026-08-12T10:00:00.000Z'),
    createdAt: NOW,
  });
  await ctx.repos.advice.recordOutcome(adviceId, {
    adviceId,
    tradeIds: ['cycle-trade-explicit'],
    outcome: 'followed',
    pnl: money(120),
    recordedAt: NOW,
  });
  await ctx.repos.trade.save({
    id: 'cycle-trade-explicit',
    accountId: ctx.user.defaultAccountId,
    stockId: STOCK_ID,
    side: 'buy',
    quantity: quantity(100),
    price: money(100),
    fee: money(1),
    executedAt: NOW,
    source: 'manual',
    adviceId,
    strategyVersionId: VERSION_ID,
    createdAt: NOW,
  });
  await ctx.repos.trade.save({
    id: 'cycle-trade-version-only',
    accountId: ctx.user.defaultAccountId,
    stockId: STOCK_ID,
    side: 'buy',
    quantity: quantity(100),
    price: money(100),
    fee: money(1),
    executedAt: NOW,
    source: 'manual',
    strategyVersionId: VERSION_ID,
    createdAt: NOW,
  });
};

describe('get_strategy_decision_cycles', () => {
  it('串联结果、信号、四个观察阶段、Advice 与显式 Trade，并保留 unknown', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedStrategy(ctx);
    await seedFacts(ctx);
    await seedAdviceAndTrades(ctx);

    const result = await getStrategyDecisionCyclesTool.execute(
      { strategyId: STRATEGY_ID, runId: RUN_ID, limit: 10 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.total).toBe(1);
    const cycle = result.data.cycles[0];
    expect(cycle).toBeDefined();
    expect(cycle?.observationProgress.map((item) => [item.horizon, item.status])).toEqual([
      ['t1', 'complete'],
      ['t3', 'pending'],
      ['t5', 'unavailable'],
      ['t20', 'unavailable'],
    ]);
    expect(cycle?.advices[0]?.basedOn.strategy).toMatchObject({
      runId: RUN_ID,
      recommendationTrigger: 'run',
    });
    expect(cycle?.trades.map((trade) => trade.id)).toEqual(['cycle-trade-explicit']);
    expect(cycle?.tradeLinks).toEqual([
      { tradeId: 'cycle-trade-explicit', adviceId: 'cycle-advice-1', relation: 'trade.adviceId' },
      {
        tradeId: 'cycle-trade-explicit',
        adviceId: 'cycle-advice-1',
        relation: 'advice.outcome.tradeIds',
      },
    ]);
    expect(result.data.evidenceIds).toEqual(
      expect.arrayContaining([
        'result-fact',
        'cycle-signal-1',
        'cycle-observation-t1',
        'cycle-advice-1',
        'cycle-trade-explicit',
      ]),
    );
    expect(result.data.unknowns.join('；')).toContain('strategyVersionId');
    expect(result.data.limitations.join('；')).toContain('不是回测');
  });

  it('不允许跨策略 run 关联，并排除 replay/evaluation/non-publishing 运行', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedStrategy(ctx);
    const otherStrategyId = 'other-strategy';
    const otherVersionId = 'other-strategy-v1';
    await ctx.repos.strategy.create({
      id: otherStrategyId,
      name: '另一策略',
      description: '跨策略关联测试',
      owner: 'user',
      status: 'active',
      currentVersionId: otherVersionId,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ctx.repos.strategy.createVersion({
      id: otherVersionId,
      strategyId: otherStrategyId,
      version: 1,
      definition,
      definitionHash: strategyDefinitionHash(definition),
      validationStatus: 'valid',
      validationErrors: [],
      publishedAt: NOW,
      createdAt: NOW,
    });
    const wrongRun = {
      id: 'cycle-run-wrong-strategy',
      strategyId: otherStrategyId,
      strategyVersionId: otherVersionId,
      mode: 'replay' as const,
      coverage: 'CN_A_SHARES_SH_SZ' as const,
      dataAsOf: NOW,
      startedAt: NOW,
      finishedAt: NOW,
      status: 'complete' as const,
      scope: 'evaluation' as const,
      inputSnapshot: {},
      providerStatuses: [],
      summary: {},
      publication: { status: 'non-publishing' as const, reasons: [], decidedAt: NOW },
    };
    await ctx.repos.strategyRun.commitRun({ run: wrongRun, results: [], signals: [] });
    await expect(
      getStrategyDecisionCyclesTool.execute({ strategyId: STRATEGY_ID, runId: wrongRun.id }, ctx),
    ).resolves.toMatchObject({ ok: false, error: { kind: 'invalid_input' } });

    await ctx.repos.strategyRun.commitRun({
      run: {
        ...wrongRun,
        id: 'cycle-run-evaluation',
        strategyId: STRATEGY_ID,
        strategyVersionId: VERSION_ID,
        scope: 'evaluation',
        publication: { status: 'non-publishing', reasons: [], decidedAt: NOW },
      },
      results: [],
      signals: [],
    });
    await ctx.repos.strategyRun.commitRun({
      run: {
        ...wrongRun,
        id: 'cycle-run-withheld',
        strategyId: STRATEGY_ID,
        strategyVersionId: VERSION_ID,
        mode: 'scheduled',
        scope: 'operational',
        publication: { status: 'withheld', reasons: [], decidedAt: NOW },
      },
      results: [],
      signals: [],
    });
    const listed = await getStrategyDecisionCyclesTool.execute(
      { strategyId: STRATEGY_ID, limit: 10 },
      ctx,
    );
    expect(listed).toMatchObject({
      ok: true,
      data: {
        excludedRuns: expect.arrayContaining([
          expect.objectContaining({ runId: 'cycle-run-evaluation' }),
          expect.objectContaining({ runId: 'cycle-run-withheld' }),
        ]),
      },
    });

    const missing = await getStrategyDecisionCyclesTool.execute(
      { strategyId: 'does-not-exist' },
      ctx,
    );
    expect(missing).toMatchObject({ ok: false, error: { kind: 'not_found', entity: 'strategy' } });
  });
});
