import type {
  StockUniverseManagerLike,
  Strategy,
  StrategyDslV1,
  StrategyVersion,
  ToolContext,
} from '@luoome/core';
import { money, strategyDefinitionHash } from '@luoome/core';
import { buildTestContext, seedTestDailyBars, seedTestStockUniverse } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { runStrategySchedulesOperation } from './run-strategy-schedules.js';

const NOW = new Date('2026-08-10T10:00:00.000Z');
const DAY_START = new Date('2026-08-10T00:00:00.000Z');

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

const seedScheduled = async (
  options: {
    readonly now?: Date;
    readonly status?: Strategy['status'];
    readonly cron?: string;
    readonly createdAt?: Date;
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
  const strategyId = 'scheduled';
  const version: StrategyVersion = {
    id: 'scheduled-v1',
    strategyId,
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: now,
    createdAt: now,
  };
  await ctx.repos.strategy.create({
    id: strategyId,
    name: '调度策略',
    description: 'test',
    owner: 'user',
    status: options.status ?? 'active',
    currentVersionId: version.id,
    scheduleCron: options.cron ?? '0 18 * * 1-5',
    createdAt: options.createdAt ?? DAY_START,
    updatedAt: now,
  });
  await ctx.repos.strategy.createVersion(version);
  return { ctx, strategyId };
};

describe('run-strategy-schedules workflow', () => {
  it('运行到期策略、生成 scheduled StrategyRun 并推进 lastScheduledAt', async () => {
    const { ctx, strategyId } = await seedScheduled();

    const result = await runStrategySchedulesOperation.run({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ ran: 1, skipped: 0, failed: 0 });
    const runId = result.data.items[0]?.runId;
    expect(runId).toBeDefined();
    expect(
      runId === undefined ? null : await ctx.repos.strategyRun.findRunById(runId),
    ).toMatchObject({ mode: 'scheduled' });
    expect(await ctx.repos.strategy.findById(strategyId)).toMatchObject({
      lastScheduledAt: NOW,
    });
    const second = await runStrategySchedulesOperation.run({}, ctx);
    expect(second).toEqual({
      ok: true,
      data: { items: [], ran: 0, partial: 0, skipped: 0, failed: 0 },
    });
  });

  it('paused Strategy 不运行但会推进 lastScheduledAt，避免补跑风暴', async () => {
    const { ctx, strategyId } = await seedScheduled({ status: 'paused' });

    const result = await runStrategySchedulesOperation.run({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ ran: 0, skipped: 1, failed: 0 });
    expect(result.data.items[0]?.reason).toContain('active');
    expect(await ctx.repos.strategy.findById(strategyId)).toMatchObject({
      lastScheduledAt: NOW,
    });
    expect(await ctx.repos.strategyRun.listRuns({ strategyId })).toEqual([]);
  });

  it('未到 cron 时间的策略不运行，也不推进 lastScheduledAt', async () => {
    const { ctx, strategyId } = await seedScheduled({ cron: '0 19 * * 1-5' });

    const result = await runStrategySchedulesOperation.run({}, ctx);

    expect(result).toEqual({
      ok: true,
      data: { items: [], ran: 0, partial: 0, skipped: 0, failed: 0 },
    });
    expect(await ctx.repos.strategy.findById(strategyId)).toMatchObject({
      scheduleCron: '0 19 * * 1-5',
    });
    expect((await ctx.repos.strategy.findById(strategyId))?.lastScheduledAt).toBeUndefined();
  });

  it('进程内互斥防止同一策略在并发 tick 中重复运行', async () => {
    const { ctx, strategyId } = await seedScheduled();

    const first = await runStrategySchedulesOperation.run({}, ctx);
    const concurrent = await runStrategySchedulesOperation.run({}, ctx);

    expect(first.ok).toBe(true);
    expect(concurrent.ok).toBe(true);
    expect(await ctx.repos.strategyRun.listRuns({ strategyId })).toHaveLength(1);
  });

  it('18:00 后即使没有到期策略也为每个账户发布收盘报告', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });

    const result = await runStrategySchedulesOperation.run({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items).toEqual([]);
    const accountIds = (await ctx.repos.account.list()).map((account) => account.id).sort();
    const reports = await ctx.repos.report.list({ kind: 'closing' });
    expect(reports).toHaveLength(accountIds.length);
    expect(
      reports.map((report) => report.scope.kind === 'account' && report.scope.accountId).sort(),
    ).toEqual(accountIds);
    const repeated = await runStrategySchedulesOperation.run({}, ctx);
    expect(repeated.ok).toBe(true);
    expect(await ctx.repos.report.list({ kind: 'closing' })).toHaveLength(accountIds.length);
  });

  it('收盘报告生成失败时本轮记 partial，不回滚已提交的 run', async () => {
    const { ctx } = await seedScheduled();
    const failingCtx: ToolContext = {
      ...ctx,
      repos: {
        ...ctx.repos,
        report: Object.assign(Object.create(ctx.repos.report) as typeof ctx.repos.report, {
          upsertForPeriod: async () => {
            throw new Error('report store unavailable');
          },
        }),
      },
    };

    const result = await runStrategySchedulesOperation.run({}, failingCtx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]?.status).toBe('partial');
    expect(result.data.items[0]?.reason).toContain('收盘复盘生成失败');
    const runs = await failingCtx.repos.strategyRun.listRuns({ strategyId: 'scheduled' });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'complete', publication: { status: 'published' } });
    expect(await failingCtx.repos.report.list({ kind: 'closing' })).toEqual([]);
  });

  it('deferReports 时跳过收盘报告发布', async () => {
    const { ctx } = await seedScheduled();
    const account = (await ctx.repos.account.list())[0];
    if (account === undefined) throw new Error('account fixture missing');
    await ctx.repos.account.save({ ...account, cashBalance: money(account.cashBalance + 100) });

    const result = await runStrategySchedulesOperation.run({ deferReports: true }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]?.status).toBe('ran');
    expect(await ctx.repos.report.list({ kind: 'closing' })).toEqual([]);
  });
});
