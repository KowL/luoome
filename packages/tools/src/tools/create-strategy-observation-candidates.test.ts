import {
  money,
  STRATEGY_OBSERVATION_BENCHMARK_STOCK_ID,
  type Strategy,
  type StrategyDslV1,
  type StrategyVersion,
  strategyDefinitionHash,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext, seedTestStockUniverse } from '../testing/context.js';
import { createStrategyObservationCandidatesTool } from './create-strategy-observation-candidates.js';
import { runStrategyTool } from './run-strategy.js';
import {
  completeStrategyObservationsTool,
  getSignalObservationStatsTool,
} from './signal-observation.js';

const NOW = new Date('2026-07-28T09:00:00Z');
const STOCK_ID = '600519.SH';

const seedStrategy = async (ctx: Awaited<ReturnType<typeof buildTestContext>>): Promise<void> => {
  const definition: StrategyDslV1 = {
    schemaVersion: 1,
    metadata: {},
    universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
    selection: {
      logic: 'all',
      rules: [
        {
          id: 'positive-price',
          name: '价格有效',
          when: 'quote.close > 0',
          evidence: ['价格有效'],
        },
      ],
    },
    signals: {
      entry: [
        {
          id: 'entry',
          name: '研究信号',
          when: 'quote.close > 0',
          score: '60',
          direction: 'bullish',
          evidence: ['仅供研究'],
        },
      ],
      exit: [],
      risk: [],
    },
  };
  const version: StrategyVersion = {
    id: 'observation-strategy-v1',
    strategyId: 'observation-strategy',
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: NOW,
    createdAt: NOW,
  };
  const strategy: Strategy = {
    id: 'observation-strategy',
    name: '观察策略',
    description: '观察候选测试',
    owner: 'user',
    status: 'active',
    currentVersionId: version.id,
    createdAt: NOW,
    updatedAt: NOW,
  };
  await ctx.repos.strategy.create(strategy);
  await ctx.repos.strategy.createVersion(version);
};

const setup = async (clock: Date = NOW): Promise<Awaited<ReturnType<typeof buildTestContext>>> => {
  const ctx = await buildTestContext({ clock: () => clock });
  await seedTestStockUniverse(ctx, { limit: 1 });
  await seedStrategy(ctx);
  return ctx;
};

describe('create_strategy_observation_candidates', () => {
  it('为 published operational run 的每个信号幂等创建 T+1/T+3/T+5 候选', async () => {
    const ctx = await setup();
    const run = await runStrategyTool.execute(
      { strategyId: 'observation-strategy', persist: true },
      ctx,
    );
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.data.run.publication?.status).toBe('published');
    expect(run.data.signals).toHaveLength(1);

    const created = await createStrategyObservationCandidatesTool.execute(
      { runId: run.data.run.id },
      ctx,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data).toMatchObject({
      status: 'complete',
      created: 3,
      skipped: 0,
      baselines: { available: 1, unavailable: 0, providers: { test: 1 } },
      horizons: {
        t1: { created: 1, skipped: 0 },
        t3: { created: 1, skipped: 0 },
        t5: { created: 1, skipped: 0 },
      },
    });

    const signal = run.data.signals[0];
    expect(signal).toBeDefined();
    const observations = await ctx.repos.signalObservation.listBySources({
      sourceKind: 'strategy-signal',
      sourceIds: signal === undefined ? [] : [signal.id],
    });
    expect(observations).toHaveLength(3);
    expect(observations.every((observation) => observation.status === 'pending')).toBe(true);
    expect(observations.every((observation) => observation.baselinePrice !== undefined)).toBe(true);

    const again = await createStrategyObservationCandidatesTool.execute(
      { runId: run.data.run.id },
      ctx,
    );
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.data).toMatchObject({ status: 'complete', created: 0, skipped: 3 });
  });

  it('不为 evaluation / withheld 运行创建候选', async () => {
    const ctx = await setup();
    const run = await runStrategyTool.execute(
      { strategyId: 'observation-strategy', stockIds: [STOCK_ID], persist: true },
      ctx,
    );
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.data.run.publication?.status).toBe('non-publishing');

    const created = await createStrategyObservationCandidatesTool.execute(
      { runId: run.data.run.id },
      ctx,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data).toMatchObject({ status: 'skipped', created: 0, skipped: 0 });
    expect(await ctx.repos.signalObservation.list({ sourceKind: 'strategy-signal' })).toEqual([]);
  });

  it('run 不存在时返回 not_found', async () => {
    const ctx = await setup();
    const result = await createStrategyObservationCandidatesTool.execute(
      { runId: 'missing-run' },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: 'not_found', entity: 'StrategyRun' });
  });

  it('候选可由后续 qfq 日线补齐为 complete，并进入观察统计', async () => {
    const ctx = await setup();
    const run = await runStrategyTool.execute(
      { strategyId: 'observation-strategy', persist: true },
      ctx,
    );
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const created = await createStrategyObservationCandidatesTool.execute(
      { runId: run.data.run.id },
      ctx,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.created).toBe(3);

    const later = new Date('2026-08-10T09:00:00Z');
    const laterCtx = { ...ctx, clock: () => later };
    const dates = [
      new Date('2026-07-28T00:00:00Z'),
      new Date('2026-07-29T00:00:00Z'),
      new Date('2026-07-30T00:00:00Z'),
      new Date('2026-07-31T00:00:00Z'),
      new Date('2026-08-03T00:00:00Z'),
      new Date('2026-08-04T00:00:00Z'),
    ];
    await ctx.repos.dailyBar.saveMany([
      ...dates.map((date, index) => ({
        stockId: STRATEGY_OBSERVATION_BENCHMARK_STOCK_ID,
        date,
        open: money(4000 + index * 10),
        high: money(4010 + index * 10),
        low: money(3990 + index * 10),
        close: money(4000 + index * 10),
        volume: 1_000_000,
        adjustment: 'qfq' as const,
        source: 'test',
      })),
      ...dates.slice(1).map((date, index) => ({
        stockId: STOCK_ID,
        date,
        open: money(11 + index),
        high: money(12 + index),
        low: money(10 + index),
        close: money(11 + index),
        volume: 1_000_000,
        adjustment: 'qfq' as const,
        source: 'test',
      })),
    ]);

    const completed = await completeStrategyObservationsTool.execute({ limit: 100 }, laterCtx);
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.data).toMatchObject({
      scanned: 3,
      completed: 3,
      pending: 0,
      byHorizon: {
        t1: { scanned: 1, completed: 1, pending: 0 },
        t3: { scanned: 1, completed: 1, pending: 0 },
        t5: { scanned: 1, completed: 1, pending: 0 },
      },
    });

    const signal = run.data.signals[0];
    expect(signal).toBeDefined();
    const observations = await ctx.repos.signalObservation.listBySources({
      sourceKind: 'strategy-signal',
      sourceIds: signal === undefined ? [] : [signal.id],
    });
    expect(observations).toHaveLength(3);
    expect(observations.every((observation) => observation.status === 'complete')).toBe(true);
    expect(observations.every((observation) => observation.benchmarkStatus === 'complete')).toBe(
      true,
    );
    expect(observations.every((observation) => observation.returnPct !== undefined)).toBe(true);

    const stats = await getSignalObservationStatsTool.execute(
      { sourceKind: 'strategy-signal' },
      laterCtx,
    );
    expect(stats.ok).toBe(true);
    if (!stats.ok) return;
    expect(stats.data).toMatchObject({ total: 3, complete: 3, missingRate: 0 });
  });
});
