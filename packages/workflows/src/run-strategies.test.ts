import type { Strategy, StrategyDslV1, StrategyVersion } from '@luoome/core';
import { strategyDefinitionHash } from '@luoome/core';
import { buildTestContext, seedTestStockUniverse } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { runStrategiesWorkflow } from './run-strategies.js';

describe('run-strategies workflow', () => {
  it('continues after one Strategy failure and records each status', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 1 });
    const now = new Date('2026-07-28T09:00:00Z');
    const definition: StrategyDslV1 = {
      schemaVersion: 1,
      metadata: {},
      universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
      selection: {
        logic: 'all',
        rules: [{ id: 'price', name: '价格', when: 'quote.close > 0', evidence: ['价格有效'] }],
      },
      signals: { entry: [], exit: [], risk: [] },
    };
    const version: StrategyVersion = {
      id: 'workflow-strategy-v1',
      strategyId: 'workflow-strategy',
      version: 1,
      definition,
      definitionHash: strategyDefinitionHash(definition),
      validationStatus: 'valid',
      validationErrors: [],
      publishedAt: now,
      createdAt: now,
    };
    const strategy: Strategy = {
      id: 'workflow-strategy',
      name: '工作流策略',
      description: '工作流测试',
      owner: 'user',
      status: 'active',
      currentVersionId: version.id,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.repos.strategy.create(strategy);
    await ctx.repos.strategy.createVersion(version);

    const result = await runStrategiesWorkflow.run(
      {
        strategyIds: ['missing-strategy', strategy.id],
        stockIds: ['600519.SH'],
        persist: false,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ complete: 1, dataPartial: 0, failed: 1 });
    expect(result.data.items.map((item) => [item.strategyId, item.status])).toEqual([
      ['missing-strategy', 'failed'],
      ['workflow-strategy', 'complete'],
    ]);
  });

  it('maps workflow scheduled mode to auditable scheduled StrategyRun', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 1 });
    const now = new Date('2026-07-28T09:00:00Z');
    const definition: StrategyDslV1 = {
      schemaVersion: 1,
      metadata: {},
      universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
      selection: {
        logic: 'all',
        rules: [{ id: 'price', name: '价格', when: 'quote.close > 0', evidence: ['价格有效'] }],
      },
      signals: { entry: [], exit: [], risk: [] },
    };
    const version: StrategyVersion = {
      id: 'scheduled-strategy-v1',
      strategyId: 'scheduled-strategy',
      version: 1,
      definition,
      definitionHash: strategyDefinitionHash(definition),
      validationStatus: 'valid',
      validationErrors: [],
      publishedAt: now,
      createdAt: now,
    };
    await ctx.repos.strategy.create({
      id: 'scheduled-strategy',
      name: '调度策略',
      description: 'scheduled workflow test',
      owner: 'user',
      status: 'active',
      currentVersionId: version.id,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.repos.strategy.createVersion(version);

    const result = await runStrategiesWorkflow.run(
      {
        strategyIds: ['scheduled-strategy'],
        mode: 'scheduled',
        stockIds: ['600519.SH'],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const runId = result.data.items[0]?.runId;
    expect(runId).toBeDefined();
    const run = runId === undefined ? null : await ctx.repos.strategyRun.findRunById(runId);
    expect(run).toMatchObject({
      mode: 'scheduled',
      inputSnapshot: { schemaVersion: 3, requestedBy: 'scheduled' },
    });
  });
});
