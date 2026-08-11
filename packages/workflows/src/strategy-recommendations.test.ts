import { type StrategyDslV1, strategyDefinitionHash } from '@luoome/core';
import {
  createStrategyObservationCandidatesTool,
  prepareStrategyDataTool,
  runStrategyTool,
} from '@luoome/tools';
import { buildTestContext, seedTestStockUniverse } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { strategyRecommendationsWorkflow } from './strategy-recommendations.js';

const NOW = new Date('2026-08-10T10:00:00.000Z');

const seedRun = async () => {
  const ctx = await buildTestContext({ clock: () => NOW, advices: [] });
  await seedTestStockUniverse(ctx, { limit: 1 });
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
  const version = {
    id: 'recommend-v1',
    strategyId: 'recommend',
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid' as const,
    validationErrors: [],
    publishedAt: NOW,
    createdAt: NOW,
  };
  await ctx.repos.strategy.create({
    id: 'recommend',
    name: '自动推荐策略',
    description: 'test',
    owner: 'user',
    status: 'active',
    currentVersionId: version.id,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await ctx.repos.strategy.createVersion(version);
  const prepared = await prepareStrategyDataTool.execute({ strategyId: 'recommend' }, ctx);
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
  const run = await runStrategyTool.execute(
    {
      strategyId: 'recommend',
      mode: 'scheduled',
      dataCheckpointId: prepared.data.checkpoint.id,
      persist: true,
    },
    ctx,
  );
  if (!run.ok) throw new Error(JSON.stringify(run.error));
  return { ctx, run: run.data.run };
};

describe('strategy-recommendations workflow', () => {
  it('按排名和评分生成可追溯 Advice，通知后冷却去重', async () => {
    const { ctx, run } = await seedRun();
    const input = {
      strategyId: 'recommend',
      runId: run.id,
      policy: {
        enabled: true,
        minScore: 70,
        maxRank: 10,
        maxPerRun: 3,
        cooldownHours: 72,
        notify: true,
        channel: 'log' as const,
        observationHorizons: ['t3', 't5', 't20'] as const,
      },
    };
    const first = await strategyRecommendationsWorkflow.run(input, ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.advices).toHaveLength(1);
    expect(first.data.advices[0]?.basedOn.strategy).toMatchObject({
      strategyId: 'recommend',
      runId: run.id,
      score: 80,
      rank: 1,
    });
    expect(first.data.advices[0]?.basedOn.strategy?.signalIds).toHaveLength(1);
    expect(await ctx.repos.notification.listRecent()).toHaveLength(1);

    const candidates = await createStrategyObservationCandidatesTool.execute(
      { runId: run.id },
      ctx,
    );
    expect(candidates.ok).toBe(true);

    const second = await strategyRecommendationsWorkflow.run(input, ctx);
    expect(second).toEqual({
      ok: true,
      data: {
        strategyId: 'recommend',
        runId: run.id,
        advices: [],
        skippedCooldown: 1,
        notificationFailed: 0,
      },
    });

    const pending = await ctx.repos.signalObservation.list({
      sourceKind: 'strategy-signal',
      status: 'pending',
      horizons: ['t3'],
    });
    const observation = pending[0];
    expect(observation).toBeDefined();
    if (observation === undefined) return;
    await ctx.repos.signalObservation.save({
      ...observation,
      closePrice: 11,
      returnPct: 0.1,
      maxFavorableExcursionPct: 0.12,
      maxAdverseExcursionPct: -0.03,
      status: 'complete',
      observedAt: NOW,
    });
    const milestone = await strategyRecommendationsWorkflow.run(
      { ...input, trigger: 't3', stockIds: [observation.stockId] },
      ctx,
    );
    expect(milestone.ok).toBe(true);
    if (!milestone.ok) return;
    expect(milestone.data.advices).toHaveLength(1);
    expect(milestone.data.advices[0]?.basedOn.strategy).toMatchObject({
      recommendationTrigger: 't3',
      observationIds: expect.arrayContaining([observation.id]),
    });
  });

  it('政策关闭时不调用 AI 或通知', async () => {
    const { ctx, run } = await seedRun();
    const result = await strategyRecommendationsWorkflow.run(
      {
        strategyId: 'recommend',
        runId: run.id,
        policy: {
          enabled: false,
          minScore: 70,
          maxRank: 10,
          maxPerRun: 3,
          cooldownHours: 72,
          notify: true,
          channel: 'log',
          observationHorizons: ['t3', 't5', 't20'],
        },
      },
      ctx,
    );
    expect(result).toMatchObject({ ok: true, data: { advices: [] } });
    expect(await ctx.repos.notification.listRecent()).toHaveLength(0);
  });
});
