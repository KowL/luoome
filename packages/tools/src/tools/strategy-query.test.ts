import {
  type Strategy,
  type StrategyDslV1,
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
  await ctx.repos.strategy.save(strategy);
  await ctx.repos.strategy.saveVersion(version);
};

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
