import {
  type MarketDataAdapterLike,
  money,
  type StrategyDslV1,
  type StrategyVersion,
  strategyDefinitionHash,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext, seedTestStockUniverse } from '../testing/context.js';
import { prepareStrategyDataTool } from './prepare-strategy-data.js';
import { runStrategyTool } from './run-strategy.js';
import { evaluateStrategyCandidatePreflightTool } from './strategy-candidate-preflight.js';

const NOW = new Date('2026-08-12T09:00:00.000Z');
const STOCK_ID = '600519.SH';

const policy = {
  schemaVersion: 2 as const,
  enabled: true,
  minScore: 0,
  maxRank: 8,
  maxPerRun: 5,
  cooldownHours: 48,
  notify: false,
  channel: 'log' as const,
  observationHorizons: ['t3', 't5'] as const,
  portfolioPreflight: {
    skipExistingHolding: true,
    requireLiquidityFacts: false,
    maxDataAgeTradingDays: 5,
    rejectOnExitSignal: true,
    rejectOnRiskSignal: true,
  },
};

const seedStrategy = async (
  ctx: Awaited<ReturnType<typeof buildTestContext>>,
): Promise<StrategyVersion> => {
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
          name: '入场',
          when: 'true',
          score: '80',
          direction: 'bullish',
          evidence: ['fixture'],
        },
      ],
      exit: [],
      risk: [],
    },
  };
  const version: StrategyVersion = {
    id: 'preflight-v1',
    strategyId: 'preflight-strategy',
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: NOW,
    createdAt: NOW,
  };
  await ctx.repos.strategy.create({
    id: 'preflight-strategy',
    name: '预检策略',
    description: 'test',
    owner: 'user',
    status: 'active',
    currentVersionId: version.id,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await ctx.repos.strategy.createVersion(version);
  return version;
};

const publishedRun = async (ctx: Awaited<ReturnType<typeof buildTestContext>>): Promise<string> => {
  await seedTestStockUniverse(ctx, { limit: 1, observedAt: NOW });
  await seedStrategy(ctx);
  const prepared = await prepareStrategyDataTool.execute(
    { strategyId: 'preflight-strategy', asOf: NOW, stockIds: [STOCK_ID], cachePolicy: 'refresh' },
    ctx,
  );
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
  const run = await runStrategyTool.execute(
    {
      strategyId: 'preflight-strategy',
      mode: 'scheduled',
      dataCheckpointId: prepared.data.checkpoint.id,
      acceptancePolicy: {
        policyVersion: 'strategy-run-acceptance-v1',
        minEvaluatedRatio: 0.5,
        maxFailedRatio: 0.5,
        maxIncompleteRatio: 0.5,
      },
    },
    ctx,
  );
  if (!run.ok) throw new Error(JSON.stringify(run.error));
  return run.data.run.id;
};

const withQuote = (
  ctx: Awaited<ReturnType<typeof buildTestContext>>,
): Awaited<ReturnType<typeof buildTestContext>> => ({
  ...ctx,
  adapters: {
    ...ctx.adapters,
    market: {
      ...ctx.adapters.market,
      fetchDailyBars: (stockId: string) =>
        Promise.resolve([
          {
            stockId,
            date: new Date('2026-08-12T00:00:00.000Z'),
            open: money(10),
            high: money(11),
            low: money(9),
            close: money(10),
            volume: 1_000_000,
            adjustment: 'qfq' as const,
            source: 'preflight-fixture',
          },
        ]),
    } as MarketDataAdapterLike,
  },
});

const seedQuote = async (
  ctx: Awaited<ReturnType<typeof buildTestContext>>,
  close: number,
): Promise<void> => {
  await ctx.repos.quote.save({
    stockId: STOCK_ID,
    ts: NOW,
    observedAt: NOW,
    fetchedAt: NOW,
    timestampSource: 'upstream',
    open: money(close),
    high: money(close),
    low: money(close),
    close: money(close),
    volume: 1000,
    source: 'test',
  });
};

describe('evaluate_strategy_candidate_preflight', () => {
  it('对已发布运行的入选结果逐股给出预检结论', async () => {
    const base = await buildTestContext({ clock: () => NOW });
    const ctx = withQuote(base);
    const runId = await publishedRun(ctx);
    await seedQuote(ctx, 10);

    const result = await evaluateStrategyCandidatePreflightTool.execute(
      {
        strategyId: 'preflight-strategy',
        policy: {
          ...policy,
          portfolioPreflight: { ...policy.portfolioPreflight, skipExistingHolding: false },
        },
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.runId).toBe(runId);
    expect(result.data.policySource).toBe('input');
    expect(result.data.summary.total).toBe(1);
    expect(result.data.details[0]).toMatchObject({
      stockId: STOCK_ID,
      strategyId: 'preflight-strategy',
      runId,
    });
    expect(result.data.details[0]?.status).toBe('eligible');
  });

  it('账户已持仓时按 skipExistingHolding 跳过，并给出原因码', async () => {
    const base = await buildTestContext({ clock: () => NOW });
    const ctx = withQuote(base);
    await publishedRun(ctx);
    await seedQuote(ctx, 10);

    const result = await evaluateStrategyCandidatePreflightTool.execute(
      { strategyId: 'preflight-strategy', policy },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.summary.skipped).toBe(1);
    expect(result.data.details[0]?.reasons.map((reason) => reason.code)).toContain(
      'existing-holding',
    );
  });

  it('缺行情时该候选标为 unavailable 而不是 eligible', async () => {
    const base = await buildTestContext({ clock: () => NOW });
    const ctx = withQuote(base);
    await publishedRun(ctx);

    const result = await evaluateStrategyCandidatePreflightTool.execute(
      { strategyId: 'preflight-strategy', policy },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.details[0]?.status).toBe('unavailable');
    expect(result.data.details[0]?.reasons.map((reason) => reason.code)).toContain(
      'candidate-data-unavailable',
    );
  });

  it('没有 V2 推荐策略时给出可执行的配置提示', async () => {
    const base = await buildTestContext({ clock: () => NOW });
    const ctx = withQuote(base);
    await publishedRun(ctx);
    await seedQuote(ctx, 10);

    const result = await evaluateStrategyCandidatePreflightTool.execute(
      { strategyId: 'preflight-strategy' },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });
});
