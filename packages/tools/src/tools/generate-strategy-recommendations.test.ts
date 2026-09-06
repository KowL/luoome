import { testAdviceFor } from '@luoome/adapters/testing';
import {
  money,
  quantity,
  type Strategy,
  type StrategyDslV1,
  type StrategyVersion,
  strategyDefinitionHash,
} from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';

import { buildTestContext, seedTestStockUniverse } from '../testing/context.js';
import { analyzeStrategyCandidateTool } from './analyze-strategy-candidate.js';
import { generateStrategyRecommendationsTool } from './generate-strategy-recommendations.js';
import { prepareStrategyDataTool } from './prepare-strategy-data.js';
import { runStrategyTool } from './run-strategy.js';

const NOW = new Date('2026-08-10T10:00:00.000Z');

const seedRun = async (stockCount: number) => {
  const ctx = await buildTestContext({ clock: () => NOW, advices: [] });
  await seedTestStockUniverse(ctx, { limit: stockCount });
  const definition: StrategyDslV1 = {
    schemaVersion: 1,
    metadata: { horizon: 'short' },
    universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
    selection: {
      logic: 'all',
      rules: [
        {
          id: 'selected',
          name: '入选',
          when: 'quote.close > 0',
          evidence: ['策略入选'],
        },
      ],
    },
    scoring: {
      method: 'weighted-sum',
      components: [{ ruleId: 'selected', score: '80', weight: 1 }],
      top: 10,
    },
    signals: {
      entry: [
        {
          id: 'entry',
          name: '入场信号',
          when: 'quote.close > 0',
          score: '80',
          direction: 'bullish',
          evidence: ['信号确认'],
        },
      ],
      exit: [],
      risk: [],
    },
  };
  const version: StrategyVersion = {
    id: 'recommend-v2',
    strategyId: 'recommend-v2',
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: NOW,
    createdAt: NOW,
  };
  const strategy: Strategy = {
    id: 'recommend-v2',
    name: 'V2 推荐策略',
    description: 'test',
    owner: 'user',
    status: 'active',
    currentVersionId: version.id,
    createdAt: NOW,
    updatedAt: NOW,
  };
  await ctx.repos.strategy.create(strategy);
  await ctx.repos.strategy.createVersion(version);
  const prepared = await prepareStrategyDataTool.execute({ strategyId: strategy.id }, ctx);
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
  const ran = await runStrategyTool.execute(
    {
      strategyId: strategy.id,
      mode: 'scheduled',
      dataCheckpointId: prepared.data.checkpoint.id,
      persist: true,
    },
    ctx,
  );
  if (!ran.ok) throw new Error(JSON.stringify(ran.error));
  return { ctx, run: ran.data.run };
};

const v2Policy = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 2 as const,
  enabled: true,
  minScore: 70,
  maxRank: 10,
  maxPerRun: 3,
  cooldownHours: 72,
  notify: false,
  channel: 'log' as const,
  observationHorizons: ['t3', 't5'] as const,
  portfolioPreflight: {
    skipExistingHolding: true,
    requireLiquidityFacts: false,
    maxDataAgeTradingDays: 30,
    rejectOnExitSignal: true,
    rejectOnRiskSignal: true,
    ...overrides,
  },
});

describe('generate_strategy_recommendations V2 preflight', () => {
  it('fills Top N from eligible candidates after skipping a higher-ranked holding', async () => {
    const { ctx, run } = await seedRun(5);
    const rows = (await ctx.repos.strategyRun.listResults(run.id))
      .filter((row) => row.selected)
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    const first = rows[0];
    const second = rows[1];
    if (first === undefined || second === undefined) throw new Error('two candidates required');
    await ctx.repos.holding.save({
      id: 'top-ranked-holding',
      accountId: ctx.user.defaultAccountId,
      stockId: first.stockId,
      quantity: 100,
      availableQuantity: 100,
      avgCost: money(10),
      openedAt: NOW,
      closedAt: null,
    });
    const holding = await ctx.repos.holding.findByAccountAndStock(
      ctx.user.defaultAccountId,
      second.stockId,
    );
    if (holding !== null) await ctx.repos.holding.remove(holding.id);
    const result = await generateStrategyRecommendationsTool.execute(
      {
        strategyId: 'recommend-v2',
        runId: run.id,
        policy: { ...v2Policy(), maxPerRun: 1 },
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.advices.map((advice) => advice.subjectId)).toEqual([second.stockId]);
  });

  it('rejects stale fallback quotes before calling the LLM at the single-candidate entry point', async () => {
    const { ctx, run } = await seedRun(5);
    await ctx.repos.quote.save(await ctx.adapters.market.fetchQuote('000858.SZ'));
    vi.spyOn(ctx.adapters.market, 'fetchQuote').mockRejectedValue(new Error('offline'));
    vi.spyOn(ctx.adapters.market, 'fetchDailyBars').mockResolvedValue([]);
    const llm = vi.spyOn(ctx.adapters.llm, 'generate');
    const result = await analyzeStrategyCandidateTool.execute(
      {
        strategyId: 'recommend-v2',
        runId: run.id,
        stockId: '000858.SZ',
      },
      { ...ctx, clock: () => new Date('2026-09-02T10:00:00Z') },
    );
    expect(result.ok).toBe(false);
    expect(llm).not.toHaveBeenCalled();
    expect(await ctx.repos.advice.query({ includeExpired: true })).toHaveLength(0);
  });

  it('does not persist contradictory prices or empty risk evidence returned by the LLM', async () => {
    const { ctx, run } = await seedRun(5);
    vi.spyOn(ctx.adapters.llm, 'generate').mockResolvedValue({
      decision: 'buy',
      confidence: 85,
      horizon: 'short',
      entryPrice: 10,
      targetPrice: 9,
      stopLoss: 12,
      reasoning: { premise: 'test', evidence: ['test'], counterEvidence: [] },
      risks: [],
    });
    const result = await analyzeStrategyCandidateTool.execute(
      {
        strategyId: 'recommend-v2',
        runId: run.id,
        stockId: '000858.SZ',
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('llm_error');
    expect(await ctx.repos.advice.query({ includeExpired: true })).toHaveLength(0);
  });

  it('records a failed scheduled batch without presenting failure as no opportunity', async () => {
    const { ctx, run } = await seedRun(5);
    vi.spyOn(ctx.adapters.llm, 'generate').mockRejectedValue(new Error('fixture LLM unavailable'));
    const result = await generateStrategyRecommendationsTool.execute(
      {
        strategyId: 'recommend-v2',
        runId: run.id,
        mode: 'scheduled',
        policy: { ...v2Policy({ skipExistingHolding: false }), maxPerRun: 1 },
      },
      ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      data: { attempted: 1, generationFailed: 1, advices: [] },
    });
    const audits = await ctx.repos.workflowRun.listRecent({
      workflowName: 'strategy-recommendations',
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      mode: 'scheduled',
      status: 'partial',
      outputSummary: {
        strategyId: 'recommend-v2',
        runId: run.id,
        attempted: 1,
        generationFailed: 1,
        adviceCount: 0,
      },
    });
  });

  it('skips an existing holding before invoking the LLM', async () => {
    const { ctx, run } = await seedRun(1);
    const llm = vi.spyOn(ctx.adapters.llm, 'generate');
    if (ctx.notification === undefined) throw new Error('test notification manager is required');
    const notification = vi.spyOn(ctx.notification, 'send');

    const result = await generateStrategyRecommendationsTool.execute(
      {
        strategyId: 'recommend-v2',
        runId: run.id,
        stockIds: ['600519.SH'],
        policy: { ...v2Policy(), notify: true },
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.advices).toHaveLength(0);
    expect(result.data.preflight).toMatchObject({ total: 1, eligible: 0, skipped: 1 });
    expect(result.data.preflight?.details[0]?.reasons.map((reason) => reason.code)).toContain(
      'existing-holding',
    );
    expect(llm).not.toHaveBeenCalled();
    expect(notification).not.toHaveBeenCalled();
  });

  it('runs the LLM only for an eligible account-scoped candidate and preserves provenance', async () => {
    const { ctx, run } = await seedRun(5);
    const llm = vi.spyOn(ctx.adapters.llm, 'generate');

    const result = await generateStrategyRecommendationsTool.execute(
      {
        strategyId: 'recommend-v2',
        runId: run.id,
        stockIds: ['000858.SZ'],
        policy: v2Policy(),
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.preflight).toMatchObject({
      total: 1,
      eligible: 1,
      skipped: 0,
      unavailable: 0,
    });
    expect(result.data.advices).toHaveLength(1);
    expect(result.data.advices[0]?.basedOn.strategy).toMatchObject({
      strategyId: 'recommend-v2',
      runId: run.id,
      accountId: ctx.user.defaultAccountId,
    });
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it('uses account provenance when applying the V2 cooldown', async () => {
    const { ctx, run } = await seedRun(5);
    const llm = vi.spyOn(ctx.adapters.llm, 'generate');
    const input = {
      strategyId: 'recommend-v2',
      runId: run.id,
      stockIds: ['000858.SZ'],
      policy: v2Policy(),
    };

    const first = await generateStrategyRecommendationsTool.execute(input, ctx);
    const second = await generateStrategyRecommendationsTool.execute(input, ctx);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.data.advices).toHaveLength(1);
    expect(second.data.advices).toHaveLength(0);
    expect(second.data.skippedCooldown).toBe(1);
    expect(second.data.preflight?.details[0]?.reasons.map((reason) => reason.code)).toEqual([
      'cooldown',
    ]);
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it('applies cooldown to an expired Advice whose creation time is still in the window', async () => {
    const { ctx, run } = await seedRun(5);
    const createdAt = new Date(NOW.getTime() - 60 * 60 * 1000);
    const fixture = testAdviceFor('000858.SZ', () => createdAt);
    await ctx.repos.advice.save({
      ...fixture,
      id: 'expired-cooldown-advice',
      sourceTool: 'analyze_strategy_candidate',
      validFrom: createdAt,
      validUntil: new Date(NOW.getTime() - 30 * 60 * 1000),
      basedOn: {
        ...fixture.basedOn,
        strategy: {
          strategyId: 'recommend-v2',
          strategyVersionId: run.strategyVersionId,
          runId: run.id,
          stockId: '000858.SZ',
          accountId: ctx.user.defaultAccountId,
          resultEvidence: [],
          signalIds: [],
          observationIds: [],
          recommendationTrigger: 'run',
        },
      },
    });
    const llm = vi.spyOn(ctx.adapters.llm, 'generate');

    const result = await generateStrategyRecommendationsTool.execute(
      {
        strategyId: 'recommend-v2',
        runId: run.id,
        stockIds: ['000858.SZ'],
        policy: v2Policy(),
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.advices).toHaveLength(0);
    expect(result.data.skippedCooldown).toBe(1);
    expect(result.data.preflight?.details[0]?.reasons.map((reason) => reason.code)).toEqual([
      'cooldown',
    ]);
    expect(llm).not.toHaveBeenCalled();
  });

  it('does not fall through to the LLM when required liquidity facts are unavailable', async () => {
    const { ctx, run } = await seedRun(5);
    const llm = vi.spyOn(ctx.adapters.llm, 'generate');

    const result = await generateStrategyRecommendationsTool.execute(
      {
        strategyId: 'recommend-v2',
        runId: run.id,
        stockIds: ['000858.SZ'],
        policy: v2Policy({ requireLiquidityFacts: true }),
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.advices).toHaveLength(0);
    expect(result.data.preflight).toMatchObject({ total: 1, eligible: 0, unavailable: 1 });
    expect(result.data.preflight?.details[0]?.reasons.map((reason) => reason.code)).toContain(
      'liquidity-facts-unavailable',
    );
    expect(llm).not.toHaveBeenCalled();
  });

  it('does not use initial capital as current portfolio valuation for a new position', async () => {
    const { ctx, run } = await seedRun(5);
    for (const holding of await ctx.repos.holding.listByAccount(ctx.user.defaultAccountId)) {
      await ctx.repos.holding.remove(holding.id);
    }
    const llm = vi.spyOn(ctx.adapters.llm, 'generate');

    const result = await generateStrategyRecommendationsTool.execute(
      {
        strategyId: 'recommend-v2',
        runId: run.id,
        stockIds: ['000858.SZ'],
        policy: v2Policy({ maxSinglePositionExposurePct: 20 }),
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.advices).toHaveLength(0);
    expect(result.data.preflight?.details[0]?.reasons.map((reason) => reason.code)).toEqual([
      'single-position-exposure-unavailable',
      'portfolio-valuation-unavailable',
    ]);
    expect(llm).not.toHaveBeenCalled();
  });

  it('does not let a cooldown advice from another account block the current account', async () => {
    const { ctx, run } = await seedRun(5);
    const createdAt = new Date(NOW.getTime() - 60 * 60 * 1000);
    const fixture = testAdviceFor('000858.SZ', () => createdAt);
    await ctx.repos.advice.save({
      ...fixture,
      id: 'cross-account-advice',
      sourceTool: 'analyze_strategy_candidate',
      basedOn: {
        ...fixture.basedOn,
        strategy: {
          strategyId: 'recommend-v2',
          strategyVersionId: run.strategyVersionId,
          runId: run.id,
          stockId: '000858.SZ',
          accountId: 'other-account',
          resultEvidence: [],
          signalIds: [],
          observationIds: [],
          recommendationTrigger: 'run',
        },
      },
    });
    const llm = vi.spyOn(ctx.adapters.llm, 'generate');

    const result = await generateStrategyRecommendationsTool.execute(
      {
        strategyId: 'recommend-v2',
        runId: run.id,
        stockIds: ['000858.SZ'],
        policy: v2Policy(),
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.preflight?.details[0]?.status).toBe('eligible');
    expect(result.data.advices).toHaveLength(1);
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it('skips a current holding with an explicit same-strategy trade provenance', async () => {
    const { ctx, run } = await seedRun(1);
    await ctx.repos.trade.save({
      id: 'strategy-exposure-trade',
      accountId: ctx.user.defaultAccountId,
      stockId: '600519.SH',
      side: 'buy',
      quantity: quantity(100),
      price: money(10),
      fee: money(0),
      executedAt: NOW,
      source: 'system',
      strategyVersionId: run.strategyVersionId,
      createdAt: NOW,
    });
    const llm = vi.spyOn(ctx.adapters.llm, 'generate');

    const result = await generateStrategyRecommendationsTool.execute(
      {
        strategyId: 'recommend-v2',
        runId: run.id,
        stockIds: ['600519.SH'],
        policy: v2Policy({ skipExistingHolding: false }),
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.preflight?.details[0]?.reasons.map((reason) => reason.code)).toContain(
      'same-strategy-duplicate-exposure',
    );
    expect(result.data.advices).toHaveLength(0);
    expect(llm).not.toHaveBeenCalled();
  });
});
