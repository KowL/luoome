import {
  type Strategy,
  type StrategyDslV1,
  type StrategyResult,
  type StrategyRun,
  type StrategyVersion,
  strategyDefinitionHash,
} from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';
import {
  listStrategyWatchlistSubscriptionsTool,
  subscribeStrategyToWatchlistTool,
  syncStrategyWatchlistSubscriptionsTool,
  unsubscribeStrategyFromWatchlistTool,
} from './strategy-watchlist-subscription.js';
import { createWatchlistTool } from './watchlist.js';

const T0 = new Date('2026-07-29T01:00:00.000Z');
const T1 = new Date('2026-07-29T02:00:00.000Z');

const definition: StrategyDslV1 = {
  schemaVersion: 1,
  metadata: {},
  universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
  selection: {
    logic: 'all',
    rules: [{ id: 'rule-1', name: '测试规则', when: 'quote.close > 0', evidence: ['测试事实'] }],
  },
  scoring: { method: 'weighted-sum', components: [{ ruleId: 'rule-1', score: '80', weight: 1 }] },
  signals: { entry: [], exit: [], risk: [] },
};

const seedStrategy = async (ctx: Awaited<ReturnType<typeof buildTestContext>>): Promise<void> => {
  const version: StrategyVersion = {
    id: 'strategy-1-v1',
    strategyId: 'strategy-1',
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: T0,
    createdAt: T0,
  };
  const strategy: Strategy = {
    id: 'strategy-1',
    name: '测试策略',
    description: '测试 Strategy→Watchlist',
    owner: 'user',
    status: 'active',
    currentVersionId: version.id,
    createdAt: T0,
    updatedAt: T0,
  };
  await ctx.repos.strategy.create(strategy);
  await ctx.repos.strategy.createVersion(version);
};

const makeResult = (runId: string, stockId: string, selected = true): StrategyResult => ({
  runId,
  stockId,
  selected,
  score: selected ? 80 : 20,
  rank: selected ? 1 : undefined,
  ruleEvaluations: [
    { ruleId: 'rule-1', status: selected ? 'matched' : 'not-matched', evidence: ['测试事实'] },
  ],
  evidence: [`evidence:${stockId}`],
  dataAsOf: T0,
});

const makeRun = (id: string, overrides: Partial<StrategyRun> = {}): StrategyRun => ({
  id,
  strategyId: 'strategy-1',
  strategyVersionId: 'strategy-1-v1',
  mode: 'scan',
  coverage: 'CN_A_SHARES_SH_SZ',
  dataAsOf: T0,
  startedAt: T0,
  finishedAt: T1,
  status: 'complete',
  scope: 'operational',
  inputSnapshot: { fixture: true },
  providerStatuses: [],
  summary: { selected: 1 },
  publication: { status: 'published', reasons: [], decidedAt: T1 },
  ...overrides,
});

const commitRun = async (
  ctx: Awaited<ReturnType<typeof buildTestContext>>,
  run: StrategyRun,
  results: readonly StrategyResult[],
): Promise<void> => {
  await ctx.repos.strategyRun.commitRun({ run, results, signals: [] });
};

describe('Strategy → Watchlist subscription tools', () => {
  it('显式订阅/取消是持久且幂等的，取消后保留审计记录', async () => {
    const ctx = await buildTestContext({ clock: () => T0 });
    await seedStrategy(ctx);
    await createWatchlistTool.execute(
      { id: 'strategy-watch', name: '策略观察', kind: 'strategy', membershipPolicy: 'mixed' },
      ctx,
    );
    const first = await subscribeStrategyToWatchlistTool.execute(
      { strategyId: 'strategy-1', watchlistId: 'strategy-watch' },
      ctx,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const repeat = await subscribeStrategyToWatchlistTool.execute(
      { strategyId: 'strategy-1', watchlistId: 'strategy-watch' },
      ctx,
    );
    expect(repeat).toMatchObject({ ok: true, data: { idempotent: true } });
    const cancelled = await unsubscribeStrategyFromWatchlistTool.execute(
      { strategyId: 'strategy-1', watchlistId: 'strategy-watch' },
      { ...ctx, clock: () => T1 },
    );
    expect(cancelled).toMatchObject({ ok: true, data: { idempotent: false } });
    const history = await listStrategyWatchlistSubscriptionsTool.execute(
      { strategyId: 'strategy-1' },
      ctx,
    );
    expect(history).toMatchObject({ ok: true, data: { subscriptions: [{ status: 'cancelled' }] } });
  });

  it('published operational complete run 才能完整同步，并保留 source provenance；重复 run 幂等', async () => {
    const ctx = await buildTestContext({ clock: () => T0 });
    await seedStrategy(ctx);
    await createWatchlistTool.execute(
      { id: 'strategy-watch', name: '策略观察', kind: 'strategy', membershipPolicy: 'synced' },
      ctx,
    );
    const subscribed = await subscribeStrategyToWatchlistTool.execute(
      { strategyId: 'strategy-1', watchlistId: 'strategy-watch' },
      ctx,
    );
    expect(subscribed.ok).toBe(true);
    const run = makeRun('run-complete');
    await commitRun(ctx, run, [makeResult(run.id, '600519.SH'), makeResult(run.id, '002594.SZ')]);
    const synced = await syncStrategyWatchlistSubscriptionsTool.execute(
      { strategyId: 'strategy-1', producerRunId: run.id },
      ctx,
    );
    expect(synced).toMatchObject({ ok: true, data: { status: 'complete', complete: 1 } });
    const member = await ctx.repos.watchlistMember.findMember('strategy-watch', '600519.SH');
    if (member === null) throw new Error('member missing');
    expect(
      await ctx.repos.watchlistMember.currentSource(member.id, 'strategy:strategy-1'),
    ).toMatchObject({
      kind: 'strategy',
      sourceId: 'strategy-1',
      sourceVersionId: 'strategy-1-v1',
      syncRunId: expect.any(String),
      score: 80,
      rank: 1,
      evidence: ['evidence:600519.SH'],
      dataAsOf: T0,
    });
    const retry = await syncStrategyWatchlistSubscriptionsTool.execute(
      { strategyId: 'strategy-1', producerRunId: run.id },
      ctx,
    );
    expect(retry).toMatchObject({ ok: true, data: { status: 'complete', complete: 1 } });
    expect(await ctx.repos.watchlistMember.listSyncRuns('strategy-watch')).toHaveLength(1);
  });

  it('published partial 只标 stale；withheld/evaluation/failed/persist 缺失均不改变 Watchlist', async () => {
    const ctx = await buildTestContext({ clock: () => T0 });
    await seedStrategy(ctx);
    await createWatchlistTool.execute(
      { id: 'strategy-watch', name: '策略观察', kind: 'strategy', membershipPolicy: 'synced' },
      ctx,
    );
    await subscribeStrategyToWatchlistTool.execute(
      { strategyId: 'strategy-1', watchlistId: 'strategy-watch' },
      ctx,
    );
    const completeRun = makeRun('run-complete');
    await commitRun(ctx, completeRun, [
      makeResult(completeRun.id, '600519.SH'),
      makeResult(completeRun.id, '002594.SZ'),
    ]);
    await syncStrategyWatchlistSubscriptionsTool.execute(
      { strategyId: 'strategy-1', producerRunId: completeRun.id },
      ctx,
    );

    const partialRun = makeRun('run-partial', {
      summary: {
        schemaVersion: 4,
        dataHealth: 'partial',
        universeCount: 2,
        evaluatedCount: 1,
        selectedCount: 1,
        signalCount: 0,
        incompleteCount: 0,
        failedCount: 1,
        failureSamples: [{ stockId: '002594.SZ', error: '缺失数据' }],
        acceptance: {
          decision: 'accepted',
          policy: {
            policyVersion: 'strategy-run-acceptance-v1',
            minEvaluatedRatio: 0,
            maxFailedRatio: 1,
            maxIncompleteRatio: 1,
          },
          metrics: { evaluatedRatio: 0.5, failedRatio: 0.5, incompleteRatio: 0 },
          reasons: [],
          assessedAt: T1,
        },
      },
    });
    await commitRun(ctx, partialRun, [makeResult(partialRun.id, '600519.SH')]);
    const partial = await syncStrategyWatchlistSubscriptionsTool.execute(
      { strategyId: 'strategy-1', producerRunId: partialRun.id },
      ctx,
    );
    expect(partial).toMatchObject({ ok: true, data: { status: 'partial', partial: 1 } });
    const missingMember = await ctx.repos.watchlistMember.findMember('strategy-watch', '002594.SZ');
    if (missingMember === null) throw new Error('missing member');
    expect(
      await ctx.repos.watchlistMember.currentSource(missingMember.id, 'strategy:strategy-1'),
    ).toMatchObject({ status: 'stale' });

    const before = await ctx.repos.watchlistMember.listSyncRuns('strategy-watch');
    const blockedRuns: Array<[string, Partial<StrategyRun>]> = [
      [
        'run-withheld',
        {
          publication: {
            status: 'withheld',
            reasons: ['acceptance-rejected'],
            decidedAt: T1,
          },
        },
      ],
      ['run-evaluation', { scope: 'evaluation' }],
      [
        'run-nonpublishing',
        {
          publication: { status: 'non-publishing', reasons: ['evaluation-scope'], decidedAt: T1 },
        },
      ],
      [
        'run-failed',
        {
          status: 'failed',
          error: 'provider failed',
          publication: { status: 'withheld', reasons: ['run-not-complete'], decidedAt: T1 },
        },
      ],
    ];
    for (const [id, patch] of blockedRuns) {
      const run = makeRun(id, patch);
      await commitRun(ctx, run, []);
      const skipped = await syncStrategyWatchlistSubscriptionsTool.execute(
        { strategyId: 'strategy-1', producerRunId: run.id },
        ctx,
      );
      expect(skipped).toMatchObject({ ok: true, data: { status: 'skipped' } });
    }
    const missingPersistedRun = await syncStrategyWatchlistSubscriptionsTool.execute(
      { strategyId: 'strategy-1', producerRunId: 'persist-false-run' },
      ctx,
    );
    expect(missingPersistedRun).toMatchObject({ ok: false, error: { kind: 'not_found' } });
    expect(await ctx.repos.watchlistMember.listSyncRuns('strategy-watch')).toHaveLength(
      before.length,
    );
  });

  it('空 complete published run 才能结束全部 Strategy source', async () => {
    const ctx = await buildTestContext({ clock: () => T0 });
    await seedStrategy(ctx);
    await createWatchlistTool.execute(
      { id: 'strategy-watch', name: '策略观察', kind: 'strategy', membershipPolicy: 'synced' },
      ctx,
    );
    await subscribeStrategyToWatchlistTool.execute(
      { strategyId: 'strategy-1', watchlistId: 'strategy-watch' },
      ctx,
    );
    const first = makeRun('run-first');
    await commitRun(ctx, first, [makeResult(first.id, '600519.SH')]);
    await syncStrategyWatchlistSubscriptionsTool.execute(
      { strategyId: 'strategy-1', producerRunId: first.id },
      ctx,
    );
    const empty = makeRun('run-empty', {
      summary: {
        schemaVersion: 4,
        dataHealth: 'complete',
        universeCount: 0,
        evaluatedCount: 0,
        selectedCount: 0,
        signalCount: 0,
        incompleteCount: 0,
        failedCount: 0,
        failureSamples: [],
        acceptance: {
          decision: 'accepted',
          policy: {
            policyVersion: 'strategy-run-acceptance-v1',
            minEvaluatedRatio: 0,
            maxFailedRatio: 1,
            maxIncompleteRatio: 1,
          },
          metrics: { evaluatedRatio: 0, failedRatio: 0, incompleteRatio: 0 },
          reasons: [],
          assessedAt: T1,
        },
      },
    });
    await commitRun(ctx, empty, []);
    const synced = await syncStrategyWatchlistSubscriptionsTool.execute(
      { strategyId: 'strategy-1', producerRunId: empty.id },
      ctx,
    );
    expect(synced).toMatchObject({ ok: true, data: { status: 'complete', complete: 1 } });
    const member = await ctx.repos.watchlistMember.findMember('strategy-watch', '600519.SH');
    if (member === null) throw new Error('member missing');
    expect(member.stage).toBe('archived');
    expect(
      await ctx.repos.watchlistMember.currentSource(member.id, 'strategy:strategy-1'),
    ).toBeNull();
  });

  it('缺少完整覆盖证明的空 complete 不得结束 Strategy source', async () => {
    const ctx = await buildTestContext({ clock: () => T0 });
    await seedStrategy(ctx);
    await createWatchlistTool.execute(
      { id: 'strategy-watch', name: '策略观察', kind: 'strategy', membershipPolicy: 'synced' },
      ctx,
    );
    await subscribeStrategyToWatchlistTool.execute(
      { strategyId: 'strategy-1', watchlistId: 'strategy-watch' },
      ctx,
    );
    const first = makeRun('run-first');
    await commitRun(ctx, first, [makeResult(first.id, '600519.SH')]);
    await syncStrategyWatchlistSubscriptionsTool.execute(
      { strategyId: 'strategy-1', producerRunId: first.id },
      ctx,
    );

    const untrusted = makeRun('run-untrusted-empty', { summary: { selected: 0 } });
    await commitRun(ctx, untrusted, []);
    const rejected = await syncStrategyWatchlistSubscriptionsTool.execute(
      { strategyId: 'strategy-1', producerRunId: untrusted.id },
      ctx,
    );
    expect(rejected).toMatchObject({ ok: true, data: { status: 'failed', failed: 1 } });
    expect(await ctx.repos.watchlistMember.listSyncRuns('strategy-watch')).toHaveLength(1);
    const member = await ctx.repos.watchlistMember.findMember('strategy-watch', '600519.SH');
    if (member === null) throw new Error('member missing');
    expect(
      await ctx.repos.watchlistMember.currentSource(member.id, 'strategy:strategy-1'),
    ).toMatchObject({ status: 'active' });
  });
});
