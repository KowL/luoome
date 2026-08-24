import {
  type DailyBarRevision,
  type Strategy,
  type StrategyDslV1,
  type StrategyVersion,
  strategyDefinitionHash,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext, seedTestStockUniverse } from '../testing/context.js';
import {
  assessAdaptivePersonalityTool,
  runLocalSelectorResearchTool,
} from './strategy-research.js';

const definition: StrategyDslV1 = {
  schemaVersion: 1,
  metadata: {},
  universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
  selection: {
    logic: 'all',
    rules: [{ id: 'positive', name: '价格有效', when: 'quote.close > 0', evidence: ['价格有效'] }],
  },
  signals: { entry: [], exit: [], risk: [] },
};

describe('strategy research tools', () => {
  it('local selector 只使用批量 PIT revision 并返回稳定研究排序', async () => {
    const observedAt = new Date('2026-03-16T08:00:00.000Z');
    const revisionCutoff = new Date('2026-03-17T00:00:00.000Z');
    const ctx = await buildTestContext({ clock: () => revisionCutoff });
    await seedTestStockUniverse(ctx, { limit: 2, observedAt });
    const stocks = await ctx.repos.stockUniverse.listSnapshotMembers('sync-test-stock-universe');
    const revisions: DailyBarRevision[] = stocks.flatMap((stock, stockIndex) =>
      Array.from({ length: 60 }, (_, index) => {
        const close = 10 + index * (stockIndex === 0 ? 0.1 : 0.03);
        return {
          stockId: stock.id,
          date: new Date(Date.UTC(2026, 0, index + 1)),
          contentHash: `${stock.id}-${index}`,
          open: close,
          high: close + 0.2,
          low: close - 0.2,
          close,
          volume: 1000 + index,
          source: 'fixture',
          recordedAt: new Date('2026-03-16T10:00:00.000Z'),
        };
      }),
    );
    await ctx.repos.dailyBar.saveRevisions(revisions);

    const first = await runLocalSelectorResearchTool.execute(
      {
        marketDate: '2026-03-16',
        revisionCutoff,
        stockIds: stocks.map((stock) => stock.id),
        parameters: {
          parameterVersion: 'local-selector-v1',
          minimumBars: 60,
          minimumCoverageRatio: 1,
          top: 2,
          factors: [{ metric: 'momentum-20', direction: 'higher', weight: 1 }],
        },
      },
      ctx,
    );
    const second = await runLocalSelectorResearchTool.execute(
      {
        marketDate: '2026-03-16',
        revisionCutoff,
        stockIds: stocks.map((stock) => stock.id),
        parameters: {
          parameterVersion: 'local-selector-v1',
          minimumBars: 60,
          minimumCoverageRatio: 1,
          top: 2,
          factors: [{ metric: 'momentum-20', direction: 'higher', weight: 1 }],
        },
      },
      ctx,
    );
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      data: { status: 'complete', snapshot: { requestedCount: 2, evaluatedCount: 2 } },
    });
    if (first.ok) {
      expect(first.data.candidates).toHaveLength(2);
      expect(first.data.candidates[0]?.score).toBeGreaterThan(first.data.candidates[1]?.score ?? 0);
      expect(first.data.limitations.join(' ')).toContain('不是胜率');
    }
  });

  it('adaptive personality 在真实验证观察不足时保持 unavailable 且没有结论', async () => {
    const ctx = await buildTestContext();
    const strategy: Strategy = {
      id: 'adaptive-research',
      name: '自适应研究',
      description: '仅用于门禁测试',
      owner: 'user',
      status: 'draft',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    };
    const version: StrategyVersion = {
      id: 'adaptive-research-v2',
      strategyId: strategy.id,
      version: 2,
      definition,
      definitionHash: strategyDefinitionHash(definition),
      factReferences: ['strategy-evaluation:training-session'],
      validationStatus: 'valid',
      validationErrors: [],
      createdAt: new Date('2026-04-01T00:00:00Z'),
    };
    await ctx.repos.strategy.create(strategy);
    await ctx.repos.strategy.createVersion(version);
    await ctx.repos.strategyEvaluation.saveSession({
      id: 'training-session',
      strategyId: strategy.id,
      strategyVersionId: 'adaptive-research-v1',
      from: new Date('2025-01-01T00:00:00Z'),
      to: new Date('2025-03-31T00:00:00Z'),
      status: 'complete',
      definitionHash: 'b'.repeat(64),
      createdAt: new Date('2026-01-01T00:00:00Z'),
      finishedAt: new Date('2026-04-01T00:00:00Z'),
    });
    await ctx.repos.strategyEvaluation.saveSession({
      id: 'validation-session',
      strategyId: strategy.id,
      strategyVersionId: version.id,
      from: new Date('2025-04-01T00:00:00Z'),
      to: new Date('2025-05-01T00:00:00Z'),
      status: 'complete',
      definitionHash: version.definitionHash,
      createdAt: new Date('2026-04-01T00:00:00Z'),
      finishedAt: new Date('2026-05-02T00:00:00Z'),
    });

    const result = await assessAdaptivePersonalityTool.execute(
      {
        parameterVersionId: version.id,
        trainingSessionId: 'training-session',
        validationSessionId: 'validation-session',
      },
      ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        assessment: {
          status: 'unavailable',
          conclusion: null,
          reasons: expect.arrayContaining([
            'training-days-insufficient',
            'validation-days-insufficient',
            'validation-observations-insufficient',
          ]),
        },
      },
    });
  });
});
