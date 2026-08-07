import {
  type MarketDataAdapterLike,
  type Strategy,
  type StrategyDslV1,
  type StrategyRun,
  type StrategyVersion,
  strategyDefinitionHash,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext, seedTestStockUniverse } from '../testing/context.js';
import { runStrategyTool } from './run-strategy.js';
import {
  compareStrategyRunsTool,
  getStrategyRunTool,
  getStrategyWorkspaceTool,
  listStrategyResultViewsTool,
  listStrategyRunsTool,
} from './strategy-query.js';

const seedStrategy = async (ctx: Awaited<ReturnType<typeof buildTestContext>>): Promise<void> => {
  const now = new Date('2026-07-28T09:00:00Z');
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
    id: 'scan-strategy-v1',
    strategyId: 'scan-strategy',
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: now,
    createdAt: now,
  };
  const strategy: Strategy = {
    id: 'scan-strategy',
    name: '扫描策略',
    description: '测试扫描策略',
    owner: 'user',
    status: 'active',
    currentVersionId: version.id,
    createdAt: now,
    updatedAt: now,
  };
  await ctx.repos.strategy.create(strategy);
  await ctx.repos.strategy.createVersion(version);
};

/** 从一次真实运行派生同版本的后续 run（改 id/时间/状态/摘要）。 */
const deriveRun = (
  base: StrategyRun,
  patch: Partial<StrategyRun> & { id: string; startedAt: Date },
): StrategyRun => ({ ...base, ...patch });

const partialSummary = {
  schemaVersion: 2 as const,
  universeCount: 1,
  evaluatedCount: 1,
  selectedCount: 1,
  signalCount: 0,
  partialCount: 1,
  failedCount: 0,
  failureSamples: [{ stockId: '600519.SH', error: '行情数据不足' }],
};

const failedSummary = {
  schemaVersion: 2 as const,
  universeCount: 1,
  evaluatedCount: 0,
  selectedCount: 0,
  signalCount: 0,
  partialCount: 0,
  failedCount: 1,
  failureSamples: [{ stockId: '600519.SH', error: 'provider down' }],
};

describe('complete|partial 可用运行基准', () => {
  it('无运行时使用统一完成语义，不向用户暴露 legacy partial 状态', async () => {
    const ctx = await buildTestContext();
    await seedStrategy(ctx);

    const views = await listStrategyResultViewsTool.execute(
      { strategyId: 'scan-strategy', view: 'selected' },
      ctx,
    );

    expect(views.ok).toBe(false);
    if (views.ok) return;
    expect(views.error).toEqual({
      kind: 'not_found',
      entity: '可用的完成运行',
      id: 'scan-strategy',
    });
    expect(JSON.stringify(views.error)).not.toContain('partial');
  });

  it('数据部分缺失的 complete 运行仍成为当前股票池基准', async () => {
    const base = await buildTestContext();
    await seedTestStockUniverse(base, { limit: 2 });
    await seedStrategy(base);
    const market: MarketDataAdapterLike = {
      ...base.adapters.market,
      fetchQuote: (stockId) =>
        stockId === '300750.SZ'
          ? Promise.reject(new Error('quote unavailable'))
          : base.adapters.market.fetchQuote(stockId),
    };
    const ctx = { ...base, adapters: { ...base.adapters, market } };

    const run = await runStrategyTool.execute(
      { strategyId: 'scan-strategy', stockIds: ['300750.SZ', '600519.SH'] },
      ctx,
    );
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.data.run).toMatchObject({
      status: 'complete',
      summary: { schemaVersion: 3, dataHealth: 'partial' },
    });

    const views = await listStrategyResultViewsTool.execute(
      { strategyId: 'scan-strategy', view: 'selected' },
      ctx,
    );
    expect(views.ok).toBe(true);
    if (!views.ok) return;
    expect(views.data.run.id).toBe(run.data.run.id);
    expect(views.data.rows.map((row) => row.stock.stockId)).toEqual(['600519.SH']);

    const workspace = await getStrategyWorkspaceTool.execute({ strategyId: 'scan-strategy' }, ctx);
    expect(workspace.ok).toBe(true);
    if (!workspace.ok) return;
    expect(workspace.data.currentRun?.id).toBe(run.data.run.id);
    expect(workspace.data.overview.health).toBe('partial');
  });

  it('最新一次为 partial 时，视图与工作台以它为基准且不警告', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 1 });
    await seedStrategy(ctx);
    const complete = await runStrategyTool.execute(
      { strategyId: 'scan-strategy', stockIds: ['600519.SH'] },
      ctx,
    );
    if (!complete.ok) throw new Error('run_strategy 前置失败');
    const laterAt = new Date(complete.data.run.startedAt.getTime() + 1_000);
    const partial = deriveRun(complete.data.run, {
      id: 'strategy-run-partial-latest',
      startedAt: laterAt,
      finishedAt: laterAt,
      dataAsOf: laterAt,
      status: 'partial',
      summary: partialSummary,
    });
    await ctx.repos.strategyRun.commitRun({
      run: partial,
      results: complete.data.results.map((result) => ({ ...result, runId: partial.id })),
      signals: [],
    });

    const views = await listStrategyResultViewsTool.execute(
      { strategyId: 'scan-strategy', view: 'selected' },
      ctx,
    );
    expect(views.ok).toBe(true);
    if (!views.ok) return;
    expect(views.data.run.id).toBe(partial.id);
    expect(views.data.total).toBe(1);

    const workspace = await getStrategyWorkspaceTool.execute({ strategyId: 'scan-strategy' }, ctx);
    expect(workspace.ok).toBe(true);
    if (!workspace.ok) return;
    expect(workspace.data.currentRun?.id).toBe(partial.id);
    expect(workspace.data.latestAttempt?.id).toBe(partial.id);
    expect(workspace.data.overview).toMatchObject({ health: 'partial', selectedCount: 1 });
    expect(workspace.data.warnings.length).toBe(0);
  });

  it('最新一次 failed、更早 partial 时回退到 partial 基准并带 warning', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 1 });
    await seedStrategy(ctx);
    const complete = await runStrategyTool.execute(
      { strategyId: 'scan-strategy', stockIds: ['600519.SH'] },
      ctx,
    );
    if (!complete.ok) throw new Error('run_strategy 前置失败');
    const partialAt = new Date(complete.data.run.startedAt.getTime() + 1_000);
    const partial = deriveRun(complete.data.run, {
      id: 'strategy-run-partial-mid',
      startedAt: partialAt,
      finishedAt: partialAt,
      dataAsOf: partialAt,
      status: 'partial',
      summary: partialSummary,
    });
    await ctx.repos.strategyRun.commitRun({
      run: partial,
      results: complete.data.results.map((result) => ({ ...result, runId: partial.id })),
      signals: [],
    });
    const failedAt = new Date(partialAt.getTime() + 1_000);
    const failed = deriveRun(complete.data.run, {
      id: 'strategy-run-failed-latest',
      startedAt: failedAt,
      finishedAt: failedAt,
      dataAsOf: failedAt,
      status: 'failed',
      error: '全部 candidate 数据准备失败',
      summary: failedSummary,
    });
    await ctx.repos.strategyRun.commitRun({ run: failed, results: [], signals: [] });

    const workspace = await getStrategyWorkspaceTool.execute({ strategyId: 'scan-strategy' }, ctx);
    expect(workspace.ok).toBe(true);
    if (!workspace.ok) return;
    expect(workspace.data.currentRun?.id).toBe(partial.id);
    expect(workspace.data.latestAttempt?.id).toBe(failed.id);
    expect(workspace.data.overview).toMatchObject({ health: 'failed', selectedCount: 1 });
    expect(workspace.data.warnings[0]).toContain('当前结果仍来自');
    expect(workspace.data.warnings[0]).not.toContain('完整运行');

    const views = await listStrategyResultViewsTool.execute(
      { strategyId: 'scan-strategy', view: 'selected' },
      ctx,
    );
    expect(views.ok).toBe(true);
    if (!views.ok) return;
    expect(views.data.run.id).toBe(partial.id);
  });

  it('compare 默认取最近两次 complete|partial，中间夹 failed 被跳过', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 1 });
    await seedStrategy(ctx);
    const base = await runStrategyTool.execute(
      { strategyId: 'scan-strategy', stockIds: ['600519.SH'] },
      ctx,
    );
    if (!base.ok) throw new Error('run_strategy 前置失败');
    const failedAt = new Date(base.data.run.startedAt.getTime() + 1_000);
    const failed = deriveRun(base.data.run, {
      id: 'strategy-run-failed-mid',
      startedAt: failedAt,
      finishedAt: failedAt,
      dataAsOf: failedAt,
      status: 'failed',
      error: '全部 candidate 数据准备失败',
      summary: failedSummary,
    });
    await ctx.repos.strategyRun.commitRun({ run: failed, results: [], signals: [] });
    const partialAt = new Date(failedAt.getTime() + 1_000);
    const partial = deriveRun(base.data.run, {
      id: 'strategy-run-partial-latest',
      startedAt: partialAt,
      finishedAt: partialAt,
      dataAsOf: partialAt,
      status: 'partial',
      summary: partialSummary,
    });
    await ctx.repos.strategyRun.commitRun({
      run: partial,
      results: base.data.results.map((result) => ({ ...result, runId: partial.id })),
      signals: [],
    });

    const compared = await compareStrategyRunsTool.execute({ strategyId: 'scan-strategy' }, ctx);
    expect(compared.ok).toBe(true);
    if (!compared.ok) return;
    expect(compared.data.fromRun.id).toBe(base.data.run.id);
    expect(compared.data.toRun.id).toBe(partial.id);
    expect(compared.data.warnings.some((warning) => warning.includes('数据不完整运行'))).toBe(true);
  });
});

describe('strategy-query', () => {
  it('lists the current complete selected view with stock name/code identities', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 2 });
    await seedStrategy(ctx);
    const run = await runStrategyTool.execute(
      { strategyId: 'scan-strategy', stockIds: ['600519.SH', '300750.SZ'] },
      ctx,
    );
    if (!run.ok) throw new Error('run_strategy 前置失败');

    const result = await listStrategyResultViewsTool.execute(
      { strategyId: 'scan-strategy', view: 'selected' },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.run.id).toBe(run.data.run.id);
    expect(result.data.total).toBe(2);
    expect(
      result.data.rows.map(({ stock, view }) => [stock.stockName, stock.stockId, view.kind]),
    ).toEqual([
      ['宁德时代', '300750.SZ', 'selected'],
      ['贵州茅台', '600519.SH', 'selected'],
    ]);
  });

  it('keeps the latest complete run as current when the latest attempt failed', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 1 });
    await seedStrategy(ctx);
    const complete = await runStrategyTool.execute(
      { strategyId: 'scan-strategy', stockIds: ['600519.SH'] },
      ctx,
    );
    if (!complete.ok) throw new Error('run_strategy 前置失败');
    const failedStartedAt = new Date(complete.data.run.startedAt.getTime() + 1_000);
    const failed = {
      ...complete.data.run,
      id: 'strategy-run-failed-latest',
      startedAt: failedStartedAt,
      finishedAt: failedStartedAt,
      dataAsOf: failedStartedAt,
      status: 'failed' as const,
      summary: {
        schemaVersion: 2 as const,
        universeCount: 1,
        evaluatedCount: 0,
        selectedCount: 0,
        signalCount: 0,
        partialCount: 0,
        failedCount: 1,
        failureSamples: [{ stockId: '600519.SH', error: 'provider down' }],
      },
      error: '全部 candidate 数据准备失败',
    };
    await ctx.repos.strategyRun.commitRun({ run: failed, results: [], signals: [] });

    const workspace = await getStrategyWorkspaceTool.execute({ strategyId: 'scan-strategy' }, ctx);
    expect(workspace.ok).toBe(true);
    if (!workspace.ok) return;
    expect(workspace.data.currentRun?.id).toBe(complete.data.run.id);
    expect(workspace.data.latestAttempt?.id).toBe(failed.id);
    expect(workspace.data.overview).toMatchObject({ health: 'failed', selectedCount: 1 });
    expect(workspace.data.warnings[0]).toContain('当前结果仍来自');
  });

  it('compares the latest two complete runs and enriches every diff row with stock identity', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 1 });
    await seedStrategy(ctx);
    const first = await runStrategyTool.execute(
      { strategyId: 'scan-strategy', stockIds: ['600519.SH'] },
      ctx,
    );
    if (!first.ok) throw new Error('run_strategy 前置失败');
    const laterAt = new Date(first.data.run.startedAt.getTime() + 1_000);
    const secondRun = {
      ...first.data.run,
      id: 'strategy-run-complete-latest',
      startedAt: laterAt,
      finishedAt: laterAt,
      dataAsOf: laterAt,
      summary: {
        schemaVersion: 2 as const,
        universeCount: 1,
        evaluatedCount: 1,
        selectedCount: 0,
        signalCount: 0,
        partialCount: 0,
        failedCount: 0,
        failureSamples: [],
      },
    };
    await ctx.repos.strategyRun.commitRun({
      run: secondRun,
      results: first.data.results.map((result) => ({
        ...result,
        runId: secondRun.id,
        selected: false,
      })),
      signals: [],
    });

    const compared = await compareStrategyRunsTool.execute({ strategyId: 'scan-strategy' }, ctx);
    expect(compared.ok).toBe(true);
    if (!compared.ok) return;
    expect(compared.data.diff).toMatchObject({
      fromRunId: first.data.run.id,
      toRunId: secondRun.id,
      summary: { exited: 1, selectedDemoted: 1 },
    });
    expect(compared.data.diff.rows[0]?.stock).toMatchObject({
      stockName: '贵州茅台',
      stockId: '600519.SH',
    });

    const workspace = await getStrategyWorkspaceTool.execute({ strategyId: 'scan-strategy' }, ctx);
    expect(workspace.ok).toBe(true);
    if (!workspace.ok) return;
    expect(workspace.data.overview).toMatchObject({
      enteredCount: 0,
      exitedCount: 1,
      maxAbsRankDelta: 0,
    });
  });
  it('list_strategy_runs 按策略过滤，get_strategy_run 返回该 run 的 results 与 signals', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 2 });
    await seedStrategy(ctx);
    const first = await runStrategyTool.execute(
      { strategyId: 'scan-strategy', stockIds: ['600519.SH'] },
      ctx,
    );
    const second = await runStrategyTool.execute(
      { strategyId: 'scan-strategy', stockIds: ['600519.SH', '300750.SZ'] },
      ctx,
    );
    if (!first.ok || !second.ok) throw new Error('run_strategy 前置失败');

    const runs = await listStrategyRunsTool.execute({ strategyId: 'scan-strategy' }, ctx);
    expect(runs.ok).toBe(true);
    if (!runs.ok) return;
    expect(new Set(runs.data.runs.map((run) => run.id))).toEqual(
      new Set([second.data.run.id, first.data.run.id]),
    );

    const detail = await getStrategyRunTool.execute({ runId: first.data.run.id }, ctx);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.data.run.id).toBe(first.data.run.id);
    expect(detail.data.results.map((result) => result.stockId)).toEqual(['600519.SH']);
    expect(detail.data.signals.length).toBeGreaterThan(0);
    expect(detail.data.signals.every((signal) => signal.runId === first.data.run.id)).toBe(true);

    const missing = await getStrategyRunTool.execute({ runId: 'strategy-run-missing' }, ctx);
    expect(missing.ok).toBe(false);
  });
});
