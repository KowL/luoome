import { createHash } from 'node:crypto';
import {
  money,
  type Strategy,
  type StrategyDslV1,
  type StrategyEvaluationSession,
  type StrategyVersion,
  strategyDefinitionHash,
} from '@luoome/core';
import { buildTestContext, seedTestStockUniverse } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { replayStrategyRangeWorkflow } from './replay-strategy-range.js';

const FROM = new Date('2026-07-27T00:00:00.000Z');
const TO = new Date('2026-07-29T00:00:00.000Z');

const stockIdChecksum = (stockIds: readonly string[]): string =>
  createHash('sha256').update(JSON.stringify(stockIds)).digest('hex');

const makeSession = (
  overrides: Partial<StrategyEvaluationSession> = {},
): StrategyEvaluationSession => ({
  id: 'evaluation-session-1',
  strategyId: 'strategy-a',
  strategyVersionId: 'strategy-a-v1',
  from: FROM,
  to: TO,
  status: 'running',
  definitionHash: 'a'.repeat(64),
  createdAt: FROM,
  ...overrides,
});

const seedReplayStrategy = async (
  ctx: Awaited<ReturnType<typeof buildTestContext>>,
  now: Date,
): Promise<void> => {
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
    scoring: {
      method: 'weighted-sum',
      components: [{ ruleId: 'positive-price', score: '50', weight: 1 }],
    },
    signals: {
      entry: [
        {
          id: 'entry',
          name: '历史信号',
          when: 'quote.close > 0',
          score: '60',
          direction: 'bullish',
          evidence: ['历史输入'],
        },
      ],
      exit: [],
      risk: [],
    },
  };
  const version: StrategyVersion = {
    id: 'replay-strategy-v1',
    strategyId: 'replay-strategy',
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: now,
    createdAt: now,
  };
  const strategy: Strategy = {
    id: 'replay-strategy',
    name: 'Replay 测试策略',
    description: '验证历史 revision cutoff',
    owner: 'user',
    status: 'active',
    currentVersionId: version.id,
    createdAt: now,
    updatedAt: now,
  };
  await ctx.repos.strategy.create(strategy);
  await ctx.repos.strategy.createVersion(version);
};

const revisionFor = (
  close: number,
  date: Date,
  recordedAt: Date,
): {
  stockId: string;
  date: Date;
  contentHash: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: string;
  recordedAt: Date;
} => {
  const input = {
    stockId: '600519.SH',
    date,
    open: money(close),
    high: money(close + 1),
    low: money(close - 1),
    close: money(close),
    volume: 1_000_000,
    source: 'replay-fixture',
  };
  return {
    ...input,
    contentHash: createHash('sha256')
      .update(
        JSON.stringify({
          open: input.open,
          high: input.high,
          low: input.low,
          close: input.close,
          volume: input.volume,
          source: input.source,
        }),
      )
      .digest('hex'),
    recordedAt,
  };
};

describe('replay-strategy-range resume identity', () => {
  it.each([
    ['strategy', { strategyId: 'strategy-b' }],
    ['version', { versionId: 'strategy-b-v1' }],
    ['from', { from: new Date('2026-07-26T00:00:00.000Z') }],
    ['to', { to: new Date('2026-07-30T00:00:00.000Z') }],
  ])('rejects resume when %s does not match the session', async (_label, mismatch) => {
    const ctx = await buildTestContext();
    await ctx.repos.strategyEvaluation.saveSession(makeSession());
    const result = await replayStrategyRangeWorkflow.run(
      {
        strategyId: 'strategy-a',
        versionId: 'strategy-a-v1',
        from: FROM,
        to: TO,
        resumeSessionId: 'evaluation-session-1',
        ...mismatch,
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('rejects resume of a terminal session', async () => {
    const ctx = await buildTestContext();
    await ctx.repos.strategyEvaluation.saveSession(makeSession({ status: 'complete' }));
    const result = await replayStrategyRangeWorkflow.run(
      {
        strategyId: 'strategy-a',
        versionId: 'strategy-a-v1',
        from: FROM,
        to: TO,
        resumeSessionId: 'evaluation-session-1',
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('rejects resume when the explicit stock selection changes', async () => {
    const ctx = await buildTestContext();
    const stockIds = ['600519.SH'];
    await ctx.repos.strategyEvaluation.saveSession(
      makeSession({ stockIds, stockIdChecksum: stockIdChecksum(stockIds) }),
    );
    const result = await replayStrategyRangeWorkflow.run(
      {
        strategyId: 'strategy-a',
        versionId: 'strategy-a-v1',
        from: FROM,
        to: TO,
        stockIds: ['002594.SZ'],
        resumeSessionId: 'evaluation-session-1',
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('preserves the recorded vintage status for completed days when resuming', async () => {
    const ctx = await buildTestContext();
    await ctx.repos.strategyEvaluation.saveSession(makeSession());
    for (const dataAsOf of [FROM, new Date('2026-07-28T00:00:00.000Z'), TO]) {
      await ctx.repos.strategyEvaluation.saveDay({
        sessionId: 'evaluation-session-1',
        dataAsOf,
        status: 'complete',
        vintageStatus: 'available',
      });
    }

    const result = await replayStrategyRangeWorkflow.run(
      {
        strategyId: 'strategy-a',
        versionId: 'strategy-a-v1',
        from: FROM,
        to: TO,
        resumeSessionId: 'evaluation-session-1',
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.days.map((day) => day.vintageStatus)).toEqual([
      'available',
      'available',
      'available',
    ]);
  });

  it('uses the target cutoff when vintage content is available', async () => {
    const now = new Date('2026-08-12T09:00:00.000Z');
    const asOf = new Date('2026-08-10T00:00:00.000Z');
    const ctx = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(ctx, { limit: 1, observedAt: asOf });
    await seedReplayStrategy(ctx, now);
    const historicalBar = {
      stockId: '600519.SH',
      date: asOf,
      open: money(10),
      high: money(11),
      low: money(9),
      close: money(10),
      volume: 1_000_000,
      adjustment: 'qfq' as const,
      source: 'replay-fixture',
    };
    await ctx.repos.dailyBar.saveRevisions([
      revisionFor(10, asOf, new Date('2026-08-09T00:00:00.000Z')),
      revisionFor(99, asOf, new Date('2026-08-11T00:00:00.000Z')),
    ]);
    const replayCtx = {
      ...ctx,
      adapters: {
        ...ctx.adapters,
        market: {
          ...ctx.adapters.market,
          fetchDailyBars: () => Promise.resolve([historicalBar]),
        },
      },
    };

    const result = await replayStrategyRangeWorkflow.run(
      {
        strategyId: 'replay-strategy',
        versionId: 'replay-strategy-v1',
        from: asOf,
        to: asOf,
        stockIds: ['600519.SH'],
      },
      replayCtx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.days[0]).toMatchObject({
      status: 'complete',
      vintageStatus: 'available',
      evaluatedCount: 1,
      selectedCount: 1,
      signalCount: 1,
      failedCount: 0,
    });
    expect(result.data.summary).toEqual({
      tradingDays: 1,
      completedDays: 1,
      failedDays: 0,
      vintageAvailableDays: 1,
      vintageUnavailableDays: 0,
      evaluatedCount: 1,
      selectedCount: 1,
      signalCount: 1,
      failedCount: 0,
    });
    expect(
      await replayCtx.repos.strategyEvaluation.findSessionById(result.data.sessionId),
    ).toMatchObject({
      stockIds: ['600519.SH'],
      stockIdChecksum: stockIdChecksum(['600519.SH']),
    });
    const day = await replayCtx.repos.strategyEvaluation.findDay({
      sessionId: result.data.sessionId,
      dataAsOf: asOf,
    });
    expect(day?.revisionCutoff).toEqual(asOf);
    expect(day?.vintageStatus).toBe('available');
  });

  it('PIT universe uses the trading-day end boundary for an intraday snapshot', async () => {
    const now = new Date('2026-08-10T18:00:00.000Z');
    const asOf = new Date('2026-08-10T00:00:00.000Z');
    const ctx = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(ctx, {
      limit: 1,
      observedAt: new Date('2026-08-10T15:00:00.000Z'),
    });
    await seedReplayStrategy(ctx, now);
    const historicalBar = {
      stockId: '600519.SH',
      date: asOf,
      open: money(10),
      high: money(11),
      low: money(9),
      close: money(10),
      volume: 1_000_000,
      adjustment: 'qfq' as const,
      source: 'replay-fixture',
    };
    const replayCtx = {
      ...ctx,
      adapters: {
        ...ctx.adapters,
        market: { ...ctx.adapters.market, fetchDailyBars: () => Promise.resolve([historicalBar]) },
      },
    };
    const result = await replayStrategyRangeWorkflow.run(
      {
        strategyId: 'replay-strategy',
        versionId: 'replay-strategy-v1',
        from: asOf,
        to: asOf,
      },
      replayCtx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.days[0]).toMatchObject({ status: 'complete' });
    expect(
      await replayCtx.repos.strategyEvaluation.findDay({
        sessionId: result.data.sessionId,
        dataAsOf: asOf,
      }),
    ).toMatchObject({ universeSyncId: 'sync-test-stock-universe' });
  });

  it('does not persist a dangling run id for persist=false replay', async () => {
    const now = new Date('2026-08-12T09:00:00.000Z');
    const asOf = new Date('2026-08-10T00:00:00.000Z');
    const ctx = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(ctx, { limit: 1, observedAt: asOf });
    await seedReplayStrategy(ctx, now);
    const historicalBar = {
      stockId: '600519.SH',
      date: asOf,
      open: money(10),
      high: money(11),
      low: money(9),
      close: money(10),
      volume: 1_000_000,
      adjustment: 'qfq' as const,
      source: 'replay-fixture',
    };
    const replayCtx = {
      ...ctx,
      adapters: {
        ...ctx.adapters,
        market: {
          ...ctx.adapters.market,
          fetchDailyBars: () => Promise.resolve([historicalBar]),
        },
      },
    };

    const result = await replayStrategyRangeWorkflow.run(
      {
        strategyId: 'replay-strategy',
        versionId: 'replay-strategy-v1',
        from: asOf,
        to: asOf,
        stockIds: ['600519.SH'],
        persist: false,
      },
      replayCtx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.days[0]?.runId).toBeUndefined();
    const day = await replayCtx.repos.strategyEvaluation.findDay({
      sessionId: result.data.sessionId,
      dataAsOf: asOf,
    });
    expect(day?.runId).toBeUndefined();
    expect(await replayCtx.repos.strategyRun.listRuns({ strategyId: 'replay-strategy' })).toEqual(
      [],
    );
  });
});
