import type {
  StockUniverseManagerLike,
  Strategy,
  StrategyDslV1,
  StrategyVersion,
  ToolContext,
} from '@luoome/core';
import { strategyDefinitionHash } from '@luoome/core';
import { buildTestContext, seedTestDailyBars, seedTestStockUniverse } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { strategyDailyCycleOperation } from './strategy-daily-cycle.js';

const NOW = new Date('2026-08-10T10:00:00.000Z');
const STOCK_ID = '600519.SH';

const stockUniverseAdapter = (ctx: ToolContext, observedAt: Date): StockUniverseManagerLike => ({
  name: 'stock-universe',
  sources: ['test-universe'],
  fetchStockUniverse: async ({ coverage }) => {
    const stocks = await ctx.repos.stockUniverse.listCurrent({ coverage, status: 'active' });
    return {
      source: 'test-universe',
      coverage,
      observedAt,
      complete: true,
      reportedTotal: stocks.length,
      entries: stocks.map((stock) => ({
        stockId: stock.id,
        code: stock.code,
        exchange: stock.exchange,
        name: stock.name,
        listingStatus: 'listed' as const,
      })),
    };
  },
});

const strategyDefinition = (
  options: { readonly withSignal?: boolean; readonly excludeStockIds?: readonly string[] } = {},
): StrategyDslV1 => ({
  schemaVersion: 1,
  metadata: {},
  universe: {
    coverage: 'CN_A_SHARES_SH_SZ',
    excludeStockIds: [...(options.excludeStockIds ?? [])],
  },
  selection: {
    logic: 'all',
    rules: [{ id: 'all', name: '全选', when: 'true', evidence: ['fixture'] }],
  },
  signals: {
    entry: options.withSignal
      ? [
          {
            id: 'entry',
            name: '测试入场',
            when: 'quote.close > 0',
            score: '80',
            direction: 'bullish' as const,
            evidence: ['fixture'],
          },
        ]
      : [],
    exit: [],
    risk: [],
  },
});

const seedStrategy = async (
  ctx: ToolContext,
  options: {
    readonly id?: string;
    readonly status?: Strategy['status'];
    readonly withSignal?: boolean;
    readonly excludeStockIds?: readonly string[];
  } = {},
): Promise<string> => {
  const strategyId = options.id ?? 'cycle-strategy';
  const definition = strategyDefinition(options);
  const version: StrategyVersion = {
    id: `${strategyId}-v1`,
    strategyId,
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: NOW,
    createdAt: NOW,
  };
  await ctx.repos.strategy.create({
    id: strategyId,
    name: '日循环测试策略',
    description: 'test',
    owner: 'user',
    status: options.status ?? 'active',
    currentVersionId: version.id,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await ctx.repos.strategy.createVersion(version);
  return strategyId;
};

const setup = async (
  options: {
    readonly now?: Date;
    readonly status?: Strategy['status'];
    readonly withSignal?: boolean;
    readonly excludeStockIds?: readonly string[];
  } = {},
): Promise<{ readonly ctx: ToolContext; readonly strategyId: string }> => {
  const now = options.now ?? NOW;
  const base = await buildTestContext({ clock: () => now });
  await seedTestStockUniverse(base, { limit: 1, observedAt: now });
  await seedTestDailyBars(base);
  const ctx: ToolContext = {
    ...base,
    adapters: { ...base.adapters, stockUniverse: stockUniverseAdapter(base, now) },
  };
  const strategyId = await seedStrategy(ctx, options);
  return { ctx, strategyId };
};

describe('strategy-daily-cycle workflow', () => {
  it('生产日运行发布 scheduled StrategyRun 并写入 v1 审计事实', async () => {
    const { ctx, strategyId } = await setup({ withSignal: true });

    const result = await strategyDailyCycleOperation.run({ strategyId }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      items: [{ strategyId, status: 'complete' }],
      complete: 1,
      partial: 0,
      skipped: 0,
      failed: 0,
    });
    const item = result.data.items[0];
    expect(item?.runId).toBeDefined();
    expect(item?.insightProvider).toBeDefined();
    const runs = await ctx.repos.strategyRun.listRuns({ strategyId });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      mode: 'scheduled',
      status: 'complete',
      publication: { status: 'published' },
    });
    const audits = await ctx.repos.workflowRun.listRecent({
      workflowName: 'strategy-daily-cycle',
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      status: 'succeeded',
      inputSummary: {
        schemaVersion: 1,
        strategyId,
        requestedBy: 'scheduled',
      },
      outputSummary: {
        schemaVersion: 1,
        status: 'complete',
        publication: 'published',
      },
    });
    expect(audits[0]?.outputSummary).toMatchObject({
      observations: {
        created: 3,
        skipped: 0,
        scanned: 0,
        completed: 0,
        pending: 0,
        baselines: { available: 1, unavailable: 0 },
        byHorizon: {
          t1: { created: 1, skipped: 0 },
          t3: { created: 1, skipped: 0 },
          t5: { created: 1, skipped: 0 },
        },
      },
      benchmarkSync: { status: 'succeeded', stockId: '000300.SH' },
    });
    const observations = await ctx.repos.signalObservation.list({
      sourceKind: 'strategy-signal',
    });
    expect(observations).toHaveLength(3);
    expect(observations.every((observation) => observation.status === 'pending')).toBe(true);
    expect(audits[0]?.outputSummary?.phaseTimings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'run' }),
        expect.objectContaining({ phase: 'observations' }),
        expect.objectContaining({ phase: 'insight' }),
        expect.objectContaining({ phase: 'finish' }),
      ]),
    );
  });

  it('同一交易日重复 tick 只审计 skipped，不重复运行', async () => {
    const { ctx, strategyId } = await setup();

    const first = await strategyDailyCycleOperation.run({ strategyId }, ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.items[0]?.status).toBe('complete');

    const second = await strategyDailyCycleOperation.run({ strategyId }, ctx);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.items[0]).toMatchObject({
      status: 'skipped',
      reason: 'schedule-day-duplicate',
    });
    expect(await ctx.repos.strategyRun.listRuns({ strategyId })).toHaveLength(1);
  });

  it('同日重复 tick 时补建缺失的观察候选，不重复运行', async () => {
    const { ctx, strategyId } = await setup({ withSignal: true });

    const first = await strategyDailyCycleOperation.run({ strategyId }, ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const runId = first.data.items[0]?.runId;
    expect(runId).toBeDefined();
    const signals = await ctx.repos.strategyRun.signalsByRun(runId ?? '');
    expect(signals).toHaveLength(1);
    await ctx.repos.signalObservation.removeBySources(
      'strategy-signal',
      signals.map((signal) => signal.id),
    );
    expect(await ctx.repos.signalObservation.list({ sourceKind: 'strategy-signal' })).toEqual([]);

    const second = await strategyDailyCycleOperation.run({ strategyId }, ctx);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.items[0]).toMatchObject({
      status: 'skipped',
      reason: 'schedule-day-duplicate',
    });
    expect(await ctx.repos.strategyRun.listRuns({ strategyId })).toHaveLength(1);
    expect(await ctx.repos.signalObservation.list({ sourceKind: 'strategy-signal' })).toHaveLength(
      3,
    );
    const audits = await ctx.repos.workflowRun.listRecent({
      workflowName: 'strategy-daily-cycle',
    });
    expect(audits[0]?.outputSummary).toMatchObject({
      status: 'skipped',
      observations: { created: 3, skipped: 0 },
    });
  });

  it('周末不运行并推进下一次调度', async () => {
    const saturday = new Date('2026-08-08T02:00:00.000Z');
    const { ctx, strategyId } = await setup({ now: saturday });

    const result = await strategyDailyCycleOperation.run({ strategyId }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]).toMatchObject({
      status: 'skipped',
      reason: expect.stringContaining('非 A 股交易日'),
    });
    expect(await ctx.repos.strategyRun.listRuns({ strategyId })).toEqual([]);
  });

  it('目录同步不可用时使用已有 PIT 快照与本地日线继续运行', async () => {
    const { ctx, strategyId } = await setup();
    const failingCtx: ToolContext = {
      ...ctx,
      adapters: {
        ...ctx.adapters,
        stockUniverse: {
          name: 'stock-universe',
          sources: ['real-source'],
          fetchStockUniverse: async () => {
            throw new Error('real provider unavailable');
          },
        },
      },
    };

    const result = await strategyDailyCycleOperation.run({ strategyId }, failingCtx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 目录同步失败不再回退到当前时点抓取；运行仍基于已固化的 PIT snapshot 与本地日线。
    expect(result.data.items[0]).toMatchObject({ status: 'complete' });
    expect(await failingCtx.repos.strategyRun.listRuns({ strategyId })).toHaveLength(1);
  });

  it('运行未达到发布门槛时返回 partial，不生成生产建议', async () => {
    const { ctx, strategyId } = await setup({
      withSignal: true,
      excludeStockIds: [STOCK_ID],
    });

    const result = await strategyDailyCycleOperation.run({ strategyId }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]?.status).toBe('partial');
    expect(result.data.items[0]?.reason).toContain('不创建生产建议');
    const runs = await ctx.repos.strategyRun.listRuns({ strategyId });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.publication?.status).not.toBe('published');
  });

  it('insight 失败时保留已发布事实并返回 facts-only partial 周期', async () => {
    const { ctx, strategyId } = await setup();
    const failingLlmCtx: ToolContext = {
      ...ctx,
      adapters: {
        ...ctx.adapters,
        llm: {
          name: 'failing-llm',
          generate: async () => {
            throw new Error('provider unavailable');
          },
        },
      },
    };

    const result = await strategyDailyCycleOperation.run({ strategyId }, failingLlmCtx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]).toMatchObject({
      status: 'partial',
      insightProvider: 'facts-only',
    });
    const runs = await failingLlmCtx.repos.strategyRun.listRuns({ strategyId });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'complete',
      publication: { status: 'published' },
    });
  });

  it('非 active Strategy 直接调用日循环时返回 failed 且不产生运行事实', async () => {
    const { ctx, strategyId } = await setup({ status: 'paused' });

    const result = await strategyDailyCycleOperation.run({ strategyId }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]).toMatchObject({ status: 'failed' });
    expect(result.data.items[0]?.reason).toContain('active');
    expect(await ctx.repos.strategyRun.listRuns({ strategyId })).toEqual([]);
  });

  it('观察候选写入失败时保留已发布 run，只把周期标 partial', async () => {
    const { ctx, strategyId } = await setup({ withSignal: true });
    const observationRepo = ctx.repos.signalObservation;
    const failingRepo = Object.create(observationRepo) as typeof observationRepo;
    failingRepo.save = async () => {
      throw new Error('observation store unavailable');
    };
    const failingCtx: ToolContext = {
      ...ctx,
      repos: { ...ctx.repos, signalObservation: failingRepo },
    };

    const result = await strategyDailyCycleOperation.run({ strategyId }, failingCtx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]).toMatchObject({
      status: 'partial',
      reason: expect.stringContaining('观察候选创建失败'),
    });
    const runs = await failingCtx.repos.strategyRun.listRuns({ strategyId });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.publication?.status).toBe('published');
    expect(
      await failingCtx.repos.signalObservation.list({ sourceKind: 'strategy-signal' }),
    ).toEqual([]);
  });
});
