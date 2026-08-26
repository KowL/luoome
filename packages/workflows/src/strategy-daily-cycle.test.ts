import type {
  StockCode,
  StockUniverseManagerLike,
  StrategyDslV1,
  StrategySchedule,
  StrategyVersion,
  ToolContext,
} from '@luoome/core';
import { strategyDefinitionHash } from '@luoome/core';
import { buildTestContext, seedTestStockUniverse } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { strategyDailyCycleWorkflow } from './strategy-daily-cycle.js';

const NOW = new Date('2026-08-10T10:00:00.000Z');

const seedSchedule = async (
  ctx: ToolContext,
  options: { readonly withSignal?: boolean } = {},
): Promise<void> => {
  await seedTestStockUniverse(ctx, { limit: 1, observedAt: NOW });
  const definition: StrategyDslV1 = {
    schemaVersion: 1,
    metadata: {},
    universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
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
              when: 'true',
              score: '80',
              direction: 'bullish' as const,
              evidence: ['fixture'],
            },
          ]
        : [],
      exit: [],
      risk: [],
    },
  };
  const version: StrategyVersion = {
    id: 'cycle-v1',
    strategyId: 'cycle-strategy',
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: NOW,
    createdAt: NOW,
  };
  await ctx.repos.strategy.create({
    id: 'cycle-strategy',
    name: '日循环故障矩阵',
    description: 'test',
    owner: 'user',
    status: 'active',
    currentVersionId: version.id,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await ctx.repos.strategy.createVersion(version);
  const schedule: StrategySchedule = {
    id: 'cycle-schedule',
    strategyId: 'cycle-strategy',
    cron: '0 18 * * 1-5',
    timezone: 'Asia/Shanghai',
    enabled: true,
    nextRunAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
  await ctx.repos.strategySchedule.save(schedule);
};

describe('strategy-daily-cycle reliability matrix', () => {
  it('数据 checkpoint 无法建立时失败并推进 schedule，不生成 run', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedSchedule(ctx);
    const failedDataCtx: ToolContext = {
      ...ctx,
      adapters: {
        ...ctx.adapters,
        market: {
          ...ctx.adapters.market,
          fetchDailyBars: async () => {
            throw new Error('provider unavailable');
          },
        },
      },
    };
    const result = await strategyDailyCycleWorkflow.run(
      { owner: 'cycle-worker', asOf: NOW, leaseMinutes: 5 },
      failedDataCtx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]).toMatchObject({
      status: 'failed',
      phase: 'finish',
    });
    expect(await ctx.repos.strategyRun.listRuns({ strategyId: 'cycle-strategy' })).toEqual([]);
    expect(
      await ctx.repos.workflowRun.listRecent({ workflowName: 'strategy-daily-cycle' }),
    ).toHaveLength(1);
  });

  it('AI 失败时保留已发布事实并返回 facts-only partial 周期', async () => {
    const base = await buildTestContext({
      clock: () => NOW,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    await seedSchedule(base);
    const ctx: ToolContext = {
      ...base,
      adapters: {
        ...base.adapters,
        llm: {
          name: 'failing-llm',
          generate: async () => {
            throw new Error('provider unavailable');
          },
        },
      },
    };
    const result = await strategyDailyCycleWorkflow.run(
      { owner: 'cycle-worker', asOf: NOW, leaseMinutes: 5 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]).toMatchObject({
      status: 'partial',
      insightProvider: 'facts-only',
    });
    const runId = result.data.items[0]?.runId;
    expect(runId).toBeDefined();
    expect(
      runId === undefined ? null : await ctx.repos.strategyRun.findRunById(runId),
    ).toMatchObject({
      status: 'complete',
      publication: { status: 'published' },
    });
    expect(
      await ctx.repos.workflowRun.listRecent({ workflowName: 'strategy-daily-cycle' }),
    ).toHaveLength(1);
    const audit = (
      await ctx.repos.workflowRun.listRecent({
        workflowName: 'strategy-daily-cycle',
      })
    )[0];
    expect(audit?.outputSummary).toMatchObject({
      benchmarkSync: {
        status: 'skipped',
        dataVersion: '000300.SH:qfq:daily:v1',
        stockId: '000300.SH',
      },
    });
  });

  it('观察阶段失败时不回滚已发布 StrategyRun，WorkflowRun 保留后阶段审计', async () => {
    const base = await buildTestContext({ clock: () => NOW });
    await seedSchedule(base, { withSignal: true });
    const observationRepo = base.repos.signalObservation;
    const ctx: ToolContext = {
      ...base,
      repos: {
        ...base.repos,
        signalObservation: {
          ...observationRepo,
          save: async () => {
            throw new Error('observation store unavailable');
          },
        },
      },
    };
    const result = await strategyDailyCycleWorkflow.run(
      { owner: 'cycle-observation-failure', asOf: NOW, leaseMinutes: 5 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]).toMatchObject({ status: 'failed', phase: 'finish' });
    const runs = await ctx.repos.strategyRun.listRuns({ strategyId: 'cycle-strategy' });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'complete', publication: { status: 'published' } });
    const audits = await ctx.repos.workflowRun.listRecent({ workflowName: 'strategy-daily-cycle' });
    expect(audits[0]).toMatchObject({ status: 'failed' });
    expect(audits[0]?.outputSummary).toMatchObject({ status: 'failed', publication: 'published' });
    expect(audits[0]?.outputSummary?.phaseTimings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'observations' }),
        expect.objectContaining({ phase: 'finish' }),
      ]),
    );
  });

  it('schedule lease 丢失时不提交运行事实', async () => {
    const base = await buildTestContext({ clock: () => NOW });
    await seedSchedule(base);
    const ctx: ToolContext = {
      ...base,
      repos: {
        ...base.repos,
        strategySchedule: {
          save: (...args: Parameters<typeof base.repos.strategySchedule.save>) =>
            base.repos.strategySchedule.save(...args),
          removeByStrategyId: (
            ...args: Parameters<typeof base.repos.strategySchedule.removeByStrategyId>
          ) => base.repos.strategySchedule.removeByStrategyId(...args),
          findById: (...args: Parameters<typeof base.repos.strategySchedule.findById>) =>
            base.repos.strategySchedule.findById(...args),
          findByStrategyId: (
            ...args: Parameters<typeof base.repos.strategySchedule.findByStrategyId>
          ) => base.repos.strategySchedule.findByStrategyId(...args),
          list: (...args: Parameters<typeof base.repos.strategySchedule.list>) =>
            base.repos.strategySchedule.list(...args),
          claimDue: (...args: Parameters<typeof base.repos.strategySchedule.claimDue>) =>
            base.repos.strategySchedule.claimDue(...args),
          claimDueWithFence: (
            ...args: Parameters<typeof base.repos.strategySchedule.claimDueWithFence>
          ) => base.repos.strategySchedule.claimDueWithFence(...args),
          claimByStrategyIdWithFence: (
            ...args: Parameters<typeof base.repos.strategySchedule.claimByStrategyIdWithFence>
          ) => base.repos.strategySchedule.claimByStrategyIdWithFence(...args),
          renewClaim: async () => false,
          finishClaim: (...args: Parameters<typeof base.repos.strategySchedule.finishClaim>) =>
            base.repos.strategySchedule.finishClaim(...args),
        },
      },
    };
    const result = await strategyDailyCycleWorkflow.run(
      { owner: 'cycle-worker', asOf: NOW, leaseMinutes: 5 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]).toMatchObject({
      status: 'failed',
      reason: 'lease_lost_before_commit',
    });
    expect(await ctx.repos.strategyRun.listRuns({ strategyId: 'cycle-strategy' })).toEqual([]);
  });

  it('数据准备后被另一实例接管时，旧 owner 在 run/观察/Advice 前被同步 fence 拒绝', async () => {
    const base = await buildTestContext({ clock: () => NOW });
    await seedSchedule(base, { withSignal: true });
    const adviceIdsBefore = new Set(
      (await base.repos.advice.query({ includeExpired: true })).map((advice) => advice.id),
    );
    let renewals = 0;
    const strategySchedule = base.repos.strategySchedule;
    const ctx: ToolContext = {
      ...base,
      repos: {
        ...base.repos,
        strategySchedule: {
          save: (...args: Parameters<typeof strategySchedule.save>) =>
            strategySchedule.save(...args),
          removeByStrategyId: (...args: Parameters<typeof strategySchedule.removeByStrategyId>) =>
            strategySchedule.removeByStrategyId(...args),
          findById: (...args: Parameters<typeof strategySchedule.findById>) =>
            strategySchedule.findById(...args),
          findByStrategyId: (...args: Parameters<typeof strategySchedule.findByStrategyId>) =>
            strategySchedule.findByStrategyId(...args),
          list: (...args: Parameters<typeof strategySchedule.list>) =>
            strategySchedule.list(...args),
          claimDue: (...args: Parameters<typeof strategySchedule.claimDue>) =>
            strategySchedule.claimDue(...args),
          claimDueWithFence: (...args: Parameters<typeof strategySchedule.claimDueWithFence>) =>
            strategySchedule.claimDueWithFence(...args),
          claimByStrategyIdWithFence: (
            ...args: Parameters<typeof strategySchedule.claimByStrategyIdWithFence>
          ) => strategySchedule.claimByStrategyIdWithFence(...args),
          renewClaim: async (...args: Parameters<typeof strategySchedule.renewClaim>) => {
            renewals += 1;
            return renewals === 1 ? strategySchedule.renewClaim(...args) : false;
          },
          finishClaim: (...args: Parameters<typeof strategySchedule.finishClaim>) =>
            strategySchedule.finishClaim(...args),
        },
      },
    };

    const result = await strategyDailyCycleWorkflow.run(
      { owner: 'stale-owner', asOf: NOW, leaseMinutes: 5 },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(renewals).toBe(2);
    expect(result.data.items[0]).toMatchObject({
      status: 'failed',
      reason: 'lease_lost_before_commit',
    });
    expect(await ctx.repos.strategyRun.listRuns({ strategyId: 'cycle-strategy' })).toEqual([]);
    expect(await ctx.repos.signalObservation.list({ sourceKind: 'strategy-signal' })).toEqual([]);
    expect(
      (await ctx.repos.advice.query({ includeExpired: true })).map((advice) => advice.id),
    ).toEqual([...adviceIdsBefore]);
  });

  it('生产日运行前同步真实目录快照，显式历史 asOf 不触发实时同步', async () => {
    const LATER = new Date('2026-08-11T12:00:00.000Z');
    const base = await buildTestContext({ clock: () => LATER });
    await seedSchedule(base);
    let fetches = 0;
    const dailyBarFetches: string[] = [];
    const stockUniverse: StockUniverseManagerLike = {
      name: 'stock-universe',
      sources: ['real-test-source'],
      fetchStockUniverse: async () => {
        fetches += 1;
        return {
          source: 'real-test-source',
          coverage: 'CN_A_SHARES_SH_SZ' as const,
          observedAt: LATER,
          complete: true,
          reportedTotal: 1,
          entries: [
            {
              stockId: '002594.SZ',
              code: '002594' as StockCode,
              exchange: 'SZ' as const,
              name: '测试股票',
              listingStatus: 'listed' as const,
            },
          ],
        };
      },
    };
    const productionCtx: ToolContext = {
      ...base,
      adapters: {
        ...base.adapters,
        stockUniverse,
        market: {
          ...base.adapters.market,
          fetchDailyBars: async (stockId, range) => {
            dailyBarFetches.push(stockId);
            return base.adapters.market.fetchDailyBars(stockId, range);
          },
        },
      },
    };

    const production = await strategyDailyCycleWorkflow.run(
      { owner: 'cycle-production', leaseMinutes: 5 },
      productionCtx,
    );
    expect(production.ok).toBe(true);
    expect(fetches).toBe(1);
    expect(dailyBarFetches).toContain('000300.SH');
    const benchmarkFetchesAfterProduction = dailyBarFetches.filter(
      (stockId) => stockId === '000300.SH',
    ).length;
    const synced = await productionCtx.repos.stockUniverse.latestSnapshotAtOrBefore({
      coverage: 'CN_A_SHARES_SH_SZ',
      asOf: LATER,
    });
    expect(synced).toMatchObject({ source: 'real-test-source', observedAt: LATER });

    const scheduled = await productionCtx.repos.strategySchedule.findById('cycle-schedule');
    expect(scheduled).not.toBeNull();
    if (scheduled === null) return;
    await productionCtx.repos.strategySchedule.save({ ...scheduled, nextRunAt: LATER });
    const historical = await strategyDailyCycleWorkflow.run(
      { owner: 'cycle-historical', asOf: NOW, leaseMinutes: 5 },
      productionCtx,
    );
    expect(historical.ok).toBe(true);
    expect(fetches).toBe(1);
    expect(dailyBarFetches.filter((stockId) => stockId === '000300.SH')).toHaveLength(
      benchmarkFetchesAfterProduction,
    );
  });

  it('生产日目录同步失败时不使用旧快照继续发布策略运行', async () => {
    const LATER = new Date('2026-08-11T12:00:00.000Z');
    const base = await buildTestContext({ clock: () => LATER });
    await seedSchedule(base);
    const stockUniverse: StockUniverseManagerLike = {
      name: 'stock-universe',
      sources: ['real-source'],
      fetchStockUniverse: async () => {
        throw new Error('real provider unavailable');
      },
    };
    const ctx: ToolContext = { ...base, adapters: { ...base.adapters, stockUniverse } };
    const result = await strategyDailyCycleWorkflow.run(
      { owner: 'cycle-no-stale-fallback', leaseMinutes: 5 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]).toMatchObject({ status: 'failed', phase: 'finish' });
    expect(await ctx.repos.strategyRun.listRuns({ strategyId: 'cycle-strategy' })).toEqual([]);
  });

  it('同一 schedule 交易日已有正式运行时跳过后续 cron tick', async () => {
    let now = NOW;
    const base = await buildTestContext({ clock: () => now });
    const ctx: ToolContext = {
      ...base,
      adapters: {
        ...base.adapters,
        stockUniverse: {
          name: 'stock-universe',
          sources: ['stock-universe'],
          fetchStockUniverse: async () => ({
            source: 'stock-universe',
            coverage: 'CN_A_SHARES_SH_SZ' as const,
            observedAt: now,
            complete: true,
            reportedTotal: 1,
            entries: [
              {
                stockId: '600519.SH',
                code: '600519' as StockCode,
                exchange: 'SH' as const,
                name: '贵州茅台',
                listingStatus: 'listed' as const,
              },
            ],
          }),
        },
      },
    };
    await seedSchedule(ctx);

    const first = await strategyDailyCycleWorkflow.run(
      { owner: 'cycle-first', leaseMinutes: 5 },
      ctx,
    );
    expect(first.ok).toBe(true);
    const firstRuns = await ctx.repos.strategyRun.listRuns({ strategyId: 'cycle-strategy' });
    expect(firstRuns).toHaveLength(1);
    const firstRun = firstRuns[0];
    if (firstRun === undefined) return;

    // 让第二次 claim 的“今天”与 checkpoint 交易日一致；文件 SQLite 读回 JSON
    // 时可能是 ISO 字符串，不能只依赖内存 repo 的 Date 形态。
    const snapshot = firstRun.inputSnapshot;
    const checkpoint =
      typeof snapshot === 'object' && snapshot !== null && 'dataCheckpoint' in snapshot
        ? snapshot.dataCheckpoint
        : undefined;
    const checkpointDataAsOf =
      typeof checkpoint === 'object' && checkpoint !== null && 'dataAsOf' in checkpoint
        ? checkpoint.dataAsOf
        : undefined;
    now = new Date(
      typeof checkpointDataAsOf === 'string' || typeof checkpointDataAsOf === 'number'
        ? checkpointDataAsOf
        : firstRun.dataAsOf,
    );
    const schedule = await ctx.repos.strategySchedule.findById('cycle-schedule');
    expect(schedule).not.toBeNull();
    if (schedule === null) return;
    await ctx.repos.strategySchedule.save({ ...schedule, nextRunAt: now });

    const second = await strategyDailyCycleWorkflow.run(
      { owner: 'cycle-duplicate', leaseMinutes: 5 },
      ctx,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.items[0]).toMatchObject({
      status: 'skipped',
      reason: 'schedule-day-duplicate',
    });
    expect(await ctx.repos.strategyRun.listRuns({ strategyId: 'cycle-strategy' })).toHaveLength(1);
  });

  it('手动正式运行即使 schedule 尚未到期也复用同一调度配置和生产闭环', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedSchedule(ctx);
    const snapshotStocks = await ctx.repos.stockUniverse.listSnapshotMembers(
      'sync-test-stock-universe',
    );
    const manualCtx: ToolContext = {
      ...ctx,
      adapters: {
        ...ctx.adapters,
        stockUniverse: {
          name: 'stock-universe',
          sources: ['stock-universe'],
          fetchStockUniverse: async () => ({
            source: 'stock-universe',
            coverage: 'CN_A_SHARES_SH_SZ' as const,
            observedAt: NOW,
            complete: true,
            reportedTotal: snapshotStocks.length,
            entries: snapshotStocks.map((stock) => ({
              stockId: stock.id,
              code: stock.code,
              exchange: stock.exchange,
              name: stock.name,
              listingStatus: 'listed' as const,
            })),
          }),
        },
      },
    };
    const schedule = await ctx.repos.strategySchedule.findById('cycle-schedule');
    expect(schedule).not.toBeNull();
    if (schedule === null) return;
    await ctx.repos.strategySchedule.save({
      ...schedule,
      nextRunAt: new Date(NOW.getTime() + 24 * 60 * 60_000),
      acceptancePolicy: {
        policyVersion: 'strategy-run-acceptance-v1',
        minEvaluatedRatio: 0.9,
        maxFailedRatio: 0.1,
        maxIncompleteRatio: 0.1,
      },
    });

    const result = await strategyDailyCycleWorkflow.run(
      { owner: 'cycle-manual', strategyId: 'cycle-strategy', trigger: 'manual', leaseMinutes: 5 },
      manualCtx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items).toHaveLength(1);
    expect(result.data.items[0]).toMatchObject({
      strategyId: 'cycle-strategy',
      scheduleId: 'cycle-schedule',
      status: 'complete',
    });
    const runId = result.data.items[0]?.runId;
    expect(runId).toBeDefined();
    const run = runId === undefined ? null : await manualCtx.repos.strategyRun.findRunById(runId);
    expect(run?.summary).toMatchObject({
      schemaVersion: 4,
      acceptance: { policy: { minEvaluatedRatio: 0.9, maxFailedRatio: 0.1 } },
    });
  });

  it('重跑只刷新上次失败成员，并沿用原 universe checkpoint 后恢复发布', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedTestStockUniverse(ctx, { limit: 10, observedAt: NOW });
    const snapshotStocks = await ctx.repos.stockUniverse.listSnapshotMembers(
      'sync-test-stock-universe',
    );
    expect(snapshotStocks).toHaveLength(10);
    const failedStock = snapshotStocks[0];
    if (failedStock === undefined) return;
    const strategyId = 'retry-cycle-strategy';
    const definition: StrategyDslV1 = {
      schemaVersion: 1,
      metadata: {},
      universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
      selection: {
        logic: 'all',
        rules: [{ id: 'all', name: '全选', when: 'true', evidence: ['retry fixture'] }],
      },
      signals: { entry: [], exit: [], risk: [] },
    };
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
      name: '重跑闭环测试',
      description: 'retry fixture',
      owner: 'user',
      status: 'active',
      currentVersionId: version.id,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ctx.repos.strategy.createVersion(version);
    const schedule: StrategySchedule = {
      id: `${strategyId}-schedule`,
      strategyId,
      cron: '0 18 * * 1-5',
      timezone: 'Asia/Shanghai',
      enabled: true,
      nextRunAt: NOW,
      acceptancePolicy: {
        policyVersion: 'strategy-run-acceptance-v1',
        minEvaluatedRatio: 0.9,
        maxFailedRatio: 0.05,
        maxIncompleteRatio: 0.1,
      },
      createdAt: NOW,
      updatedAt: NOW,
    };
    await ctx.repos.strategySchedule.save(schedule);
    let failFirstAttempt = true;
    const retryRequests: string[] = [];
    const stockUniverse: StockUniverseManagerLike = {
      name: 'stock-universe',
      sources: ['stock-universe'],
      fetchStockUniverse: async () => ({
        source: 'stock-universe',
        coverage: 'CN_A_SHARES_SH_SZ' as const,
        observedAt: NOW,
        complete: true as const,
        reportedTotal: snapshotStocks.length,
        entries: snapshotStocks.map((stock) => ({
          stockId: stock.id,
          code: stock.code,
          exchange: stock.exchange,
          name: stock.name,
          listingStatus: 'listed' as const,
        })),
      }),
    };
    const market = {
      ...ctx.adapters.market,
      fetchDailyBars: async (stockId: string, range: { start: Date; end: Date }) => {
        if (stockId === failedStock.id && failFirstAttempt) {
          throw new Error('provider unavailable');
        }
        if (!failFirstAttempt && snapshotStocks.some((stock) => stock.id === stockId)) {
          retryRequests.push(stockId);
        }
        return ctx.adapters.market.fetchDailyBars(stockId, range);
      },
    };
    const retryCtx: ToolContext = {
      ...ctx,
      adapters: { ...ctx.adapters, market, stockUniverse },
    };

    const first = await strategyDailyCycleWorkflow.run(
      { owner: 'retry-first', strategyId, trigger: 'manual', leaseMinutes: 5 },
      retryCtx,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.items[0]).toMatchObject({ status: 'partial', publication: 'withheld' });
    const firstRunId = first.data.items[0]?.runId;
    expect(firstRunId).toBeDefined();
    if (firstRunId === undefined) return;
    const firstRun = await retryCtx.repos.strategyRun.findRunById(firstRunId);
    expect(firstRun).toMatchObject({ publication: { status: 'withheld' } });
    const firstCheckpointId =
      typeof firstRun?.inputSnapshot === 'object' &&
      firstRun.inputSnapshot !== null &&
      'dataCheckpoint' in firstRun.inputSnapshot &&
      typeof firstRun.inputSnapshot.dataCheckpoint === 'object' &&
      firstRun.inputSnapshot.dataCheckpoint !== null &&
      'id' in firstRun.inputSnapshot.dataCheckpoint
        ? firstRun.inputSnapshot.dataCheckpoint.id
        : undefined;
    expect(typeof firstCheckpointId).toBe('string');
    if (typeof firstCheckpointId !== 'string') return;
    const firstCheckpoint = await retryCtx.repos.strategyDataCheckpoint.findById(firstCheckpointId);
    expect(firstCheckpoint).toMatchObject({
      universeSyncId: expect.any(String),
      requestedCount: 10,
      availableCount: 9,
      failedCount: 1,
    });
    if (firstCheckpoint === null) return;
    const originalUniverseSyncId = firstCheckpoint.universeSyncId;
    const originalMemberChecksum = firstCheckpoint.memberChecksum;

    failFirstAttempt = false;
    retryRequests.length = 0;
    const retry = await strategyDailyCycleWorkflow.run(
      {
        owner: 'retry-second',
        strategyId,
        trigger: 'retry',
        retryRunId: firstRunId,
        leaseMinutes: 5,
      },
      retryCtx,
    );
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.data.items[0]).toMatchObject({ status: 'complete', publication: 'published' });
    expect(retryRequests).toEqual([failedStock.id]);
    const retryRunId = retry.data.items[0]?.runId;
    expect(retryRunId).toBeDefined();
    if (retryRunId === undefined) return;
    const retryRun = await retryCtx.repos.strategyRun.findRunById(retryRunId);
    const retryCheckpointId =
      typeof retryRun?.inputSnapshot === 'object' &&
      retryRun.inputSnapshot !== null &&
      'dataCheckpoint' in retryRun.inputSnapshot &&
      typeof retryRun.inputSnapshot.dataCheckpoint === 'object' &&
      retryRun.inputSnapshot.dataCheckpoint !== null &&
      'id' in retryRun.inputSnapshot.dataCheckpoint
        ? retryRun.inputSnapshot.dataCheckpoint.id
        : undefined;
    expect(typeof retryCheckpointId).toBe('string');
    if (typeof retryCheckpointId !== 'string') return;
    const retryCheckpoint = await retryCtx.repos.strategyDataCheckpoint.findById(retryCheckpointId);
    expect(retryCheckpoint).toMatchObject({
      status: 'complete',
      requestedCount: 10,
      availableCount: 10,
      failedCount: 0,
      universeSyncId: originalUniverseSyncId,
      memberChecksum: originalMemberChecksum,
    });
  });
});
