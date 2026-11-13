import {
  type SignalObservation,
  type Strategy,
  type StrategyDslV1,
  type StrategyResult,
  type StrategyRun,
  type StrategyVersion,
  signalObservationId,
  strategyDefinitionHash,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { pruneStrategyHistoryTool } from './prune-strategy-history.js';

const NOW = new Date('2026-07-28T09:00:00Z');

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
  signals: { entry: [], exit: [], risk: [] },
};

const seedStrategy = async (
  ctx: Awaited<ReturnType<typeof buildTestContext>>,
): Promise<{ strategy: Strategy; version: StrategyVersion }> => {
  const version: StrategyVersion = {
    id: 'prune-v1',
    strategyId: 'prune-strategy',
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: NOW,
    createdAt: NOW,
  };
  const strategy: Strategy = {
    id: 'prune-strategy',
    name: '保留策略测试',
    description: '存储保留策略',
    owner: 'user',
    status: 'active',
    currentVersionId: version.id,
    createdAt: NOW,
    updatedAt: NOW,
  };
  await ctx.repos.strategy.create(strategy);
  await ctx.repos.strategy.createVersion(version);
  return { strategy, version };
};

const runAt = (id: string, startedAt: Date, overrides: Partial<StrategyRun> = {}): StrategyRun => ({
  id,
  strategyId: 'prune-strategy',
  strategyVersionId: 'prune-v1',
  mode: 'scheduled',
  coverage: 'CN_A_SHARES_SH_SZ',
  dataAsOf: startedAt,
  startedAt,
  finishedAt: startedAt,
  status: 'complete',
  scope: 'operational',
  inputSnapshot: {
    schemaVersion: 2,
    strategyVersionId: 'prune-v1',
    definitionHash: 'a'.repeat(64),
    evaluatorVersion: 'test',
    coverage: 'CN_A_SHARES_SH_SZ',
    stockIds: ['600519.SH'],
    stockIdChecksum: 'b'.repeat(64),
    requestedBy: 'scheduled',
  },
  providerStatuses: [],
  ...overrides,
});

const resultOf = (runId: string): StrategyResult => ({
  runId,
  stockId: '600519.SH',
  selected: true,
  score: 80,
  rank: 1,
  ruleEvaluations: [{ ruleId: 'positive-price', status: 'matched', value: true, evidence: ['x'] }],
  evidence: ['x'],
  dataAsOf: NOW,
});

const day = (offset: number): Date => new Date(NOW.getTime() + offset * 86_400_000);

describe('prune_strategy_history', () => {
  it('只清窗口外的逐股明细，保留已发布 run 与信号；默认 dryRun', async () => {
    const ctx = await buildTestContext();
    await seedStrategy(ctx);
    // 由旧到新：old-1、old-2、published、keep-1、keep-2
    for (const [id, offset] of [
      ['old-1', -10],
      ['old-2', -9],
      ['published', -8],
      ['keep-1', -2],
      ['keep-2', -1],
    ] as const) {
      await ctx.repos.strategyRun.commitRun({
        run: runAt(id, day(offset), {
          ...(id === 'published'
            ? {
                publication: {
                  status: 'published' as const,
                  reasons: [],
                  decidedAt: day(offset),
                },
              }
            : {}),
        }),
        results: [resultOf(id)],
        signals: [],
      });
    }

    const dry = await pruneStrategyHistoryTool.execute(
      { dryRun: true, keepRunsPerStrategy: 2, observationRetentionDays: 7 },
      ctx,
    );
    expect(dry.ok).toBe(true);
    if (!dry.ok) return;
    expect(dry.data.runsCleared).toBe(3);
    expect(await ctx.repos.strategyRun.listResults('old-1')).toHaveLength(1);

    const real = await pruneStrategyHistoryTool.execute(
      { dryRun: false, keepRunsPerStrategy: 2, observationRetentionDays: 7 },
      ctx,
    );
    expect(real.ok).toBe(true);
    if (!real.ok) return;
    expect(real.data.runsCleared).toBe(3);
    expect(await ctx.repos.strategyRun.listResults('old-1')).toEqual([]);
    expect(await ctx.repos.strategyRun.listResults('old-2')).toEqual([]);
    expect(await ctx.repos.strategyRun.listResults('published')).toEqual([]);
    expect(await ctx.repos.strategyRun.listResults('keep-1')).toHaveLength(1);
    expect(await ctx.repos.strategyRun.findRunById('old-1')).not.toBeNull();
  });

  it('只清理过期终态观察，pending 与新鲜观察保留', async () => {
    const ctx = await buildTestContext();
    await seedStrategy(ctx);
    const now = ctx.clock();
    const at = (offset: number): Date => new Date(now.getTime() + offset * 86_400_000);
    const observation = (
      name: string,
      status: SignalObservation['status'],
      baselineAt: Date,
    ): SignalObservation => ({
      id: signalObservationId('strategy-signal', `signal-${name}`, 't1'),
      sourceKind: 'strategy-signal',
      sourceId: `signal-${name}`,
      stockId: '600519.SH',
      baselinePrice: 10,
      baselineAt,
      horizon: 't1',
      benchmarkStatus: 'unavailable',
      status,
      provenance: {
        provider: 'fixture',
        observedAt: baselineAt,
        fetchedAt: baselineAt,
        freshness: 'fresh',
      },
      ...(status === 'unavailable' ? { unavailableReason: 'baseline_unavailable' } : {}),
    });
    const staleSettled = observation('stale-settled', 'unavailable', at(-30));
    const stalePending = observation('stale-pending', 'pending', at(-30));
    const freshSettled = observation('fresh-settled', 'unavailable', at(-1));
    for (const row of [staleSettled, stalePending, freshSettled]) {
      await ctx.repos.signalObservation.save(row);
    }

    const dry = await pruneStrategyHistoryTool.execute(
      { dryRun: true, keepRunsPerStrategy: 10, observationRetentionDays: 7 },
      ctx,
    );
    expect(dry.ok).toBe(true);
    if (!dry.ok) return;
    expect(dry.data.observationsMatched).toBe(1);
    expect(dry.data.observationsDeleted).toBe(0);

    const real = await pruneStrategyHistoryTool.execute(
      { dryRun: false, keepRunsPerStrategy: 10, observationRetentionDays: 7 },
      ctx,
    );
    expect(real.ok).toBe(true);
    if (!real.ok) return;
    expect(real.data.observationsDeleted).toBe(1);
    expect(await ctx.repos.signalObservation.findById(staleSettled.id)).toBeNull();
    expect(await ctx.repos.signalObservation.findById(stalePending.id)).not.toBeNull();
    expect(await ctx.repos.signalObservation.findById(freshSettled.id)).not.toBeNull();
  });
});
