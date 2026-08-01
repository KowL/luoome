import type { StrategyDslV1 } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext, seedTestStockUniverse } from '../testing/context.js';
import { runStrategyTool } from './run-strategy.js';
import {
  createStrategyTool,
  createStrategyVersionTool,
  pauseStrategyTool,
  publishStrategyVersionTool,
  resumeStrategyTool,
  validateStrategyVersionTool,
} from './strategy-lifecycle.js';
import {
  compareStrategyRunsTool,
  getStrategyRunTool,
  getStrategyWorkspaceTool,
  listStrategyResultViewsTool,
} from './strategy-query.js';

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
        evidence: ['现价有效'],
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
        id: 'research-entry',
        name: '研究入场信号',
        when: 'quote.close > 0',
        score: '60',
        direction: 'bullish',
        evidence: ['仅供研究，不执行交易'],
      },
    ],
    exit: [],
    risk: [],
  },
};

describe('strategy workspace full flow', () => {
  it('creates, validates, publishes, samples, persists, queries, compares and pauses safely', async () => {
    let now = new Date('2026-08-01T08:00:00.000Z').getTime();
    const ctx = await buildTestContext({
      clock: () => {
        now += 1_000;
        return new Date(now);
      },
    });
    await seedTestStockUniverse(ctx, { limit: 2 });

    const created = await createStrategyTool.execute(
      {
        id: 'full-flow-strategy',
        name: '全流程策略',
        description: '策略工作台端到端验收',
      },
      ctx,
    );
    expect(created.ok).toBe(true);

    const drafted = await createStrategyVersionTool.execute(
      {
        strategyId: 'full-flow-strategy',
        definition,
        changeSummary: '首个可运行版本',
      },
      ctx,
    );
    expect(drafted.ok).toBe(true);
    if (!drafted.ok) return;

    const validated = await validateStrategyVersionTool.execute(
      { versionId: drafted.data.version.id },
      ctx,
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.data.version.validationStatus).toBe('valid');

    const published = await publishStrategyVersionTool.execute(
      { versionId: drafted.data.version.id },
      ctx,
    );
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.data.strategy.status).toBe('active');

    const sample = await runStrategyTool.execute(
      { strategyId: 'full-flow-strategy', stockIds: ['600519.SH'], persist: false },
      ctx,
    );
    expect(sample.ok).toBe(true);
    if (!sample.ok) return;
    expect(sample.data).toMatchObject({ persisted: false, run: { status: 'complete' } });

    const beforeFormal = await getStrategyWorkspaceTool.execute(
      { strategyId: 'full-flow-strategy' },
      ctx,
    );
    expect(beforeFormal.ok).toBe(true);
    if (!beforeFormal.ok) return;
    expect(beforeFormal.data.overview.health).toBe('never-run');

    const first = await runStrategyTool.execute(
      { strategyId: 'full-flow-strategy', stockIds: ['600519.SH'], persist: true },
      ctx,
    );
    const second = await runStrategyTool.execute(
      {
        strategyId: 'full-flow-strategy',
        stockIds: ['600519.SH', '300750.SZ'],
        persist: true,
      },
      ctx,
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const workspace = await getStrategyWorkspaceTool.execute(
      { strategyId: 'full-flow-strategy' },
      ctx,
    );
    expect(workspace.ok).toBe(true);
    if (!workspace.ok) return;
    expect(workspace.data).toMatchObject({
      currentRun: { id: second.data.run.id },
      previousCompleteRun: { id: first.data.run.id },
      overview: { health: 'ready', selectedCount: 2, enteredCount: 1, exitedCount: 0 },
    });

    const pool = await listStrategyResultViewsTool.execute(
      { strategyId: 'full-flow-strategy', view: 'selected' },
      ctx,
    );
    expect(pool.ok).toBe(true);
    if (!pool.ok) return;
    expect(pool.data.rows.map((row) => [row.stock.stockName, row.stock.stockId])).toEqual([
      ['宁德时代', '300750.SZ'],
      ['贵州茅台', '600519.SH'],
    ]);

    const detail = await getStrategyRunTool.execute({ runId: second.data.run.id }, ctx);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.data.signals).toHaveLength(2);
    expect(detail.data.stocks).toHaveLength(2);

    const diff = await compareStrategyRunsTool.execute({ strategyId: 'full-flow-strategy' }, ctx);
    expect(diff.ok).toBe(true);
    if (!diff.ok) return;
    expect(diff.data.diff.summary).toMatchObject({ entered: 1, exited: 0 });

    const paused = await pauseStrategyTool.execute({ strategyId: 'full-flow-strategy' }, ctx);
    expect(paused.ok).toBe(true);
    const runWhilePaused = await runStrategyTool.execute(
      { strategyId: 'full-flow-strategy', stockIds: ['600519.SH'] },
      ctx,
    );
    expect(runWhilePaused.ok).toBe(false);
    const resumed = await resumeStrategyTool.execute({ strategyId: 'full-flow-strategy' }, ctx);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.data.strategy.status).toBe('active');
  });
});
