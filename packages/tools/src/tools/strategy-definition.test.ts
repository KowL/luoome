import { describe, expect, it } from 'vitest';

import { buildTestContext, seedTestStockUniverse } from '../testing/context.js';
import {
  compareStrategyDefinitionsTool,
  proposeStrategyVersionDraftTool,
  trialStrategyVersionTool,
} from './strategy-definition.js';
import {
  createStrategyTool,
  createStrategyVersionTool,
  publishStrategyVersionTool,
  validateStrategyVersionTool,
} from './strategy-lifecycle.js';

const definition = (style: string) => ({
  schemaVersion: 1 as const,
  metadata: { style, horizon: 'short' as const },
  universe: { coverage: 'CN_A_SHARES_SH_SZ' as const, excludeStockIds: [] },
  selection: {
    logic: 'all' as const,
    rules: [
      {
        id: 'rule',
        name: '价格有效',
        when: 'quote.close > 0',
        evidence: ['价格有效'],
      },
    ],
  },
  signals: { entry: [], exit: [], risk: [] },
});

describe('strategy definition Phase C tools', () => {
  it('compares the latest baseline and draft without writing', async () => {
    const ctx = await buildTestContext();
    await createStrategyTool.execute(
      { id: 'definition-diff', name: '定义差异', description: '测试' },
      ctx,
    );
    await createStrategyVersionTool.execute(
      { strategyId: 'definition-diff', definition: definition('trend') },
      ctx,
    );
    await createStrategyVersionTool.execute(
      { strategyId: 'definition-diff', definition: definition('value') },
      ctx,
    );
    const result = await compareStrategyDefinitionsTool.execute(
      { strategyId: 'definition-diff' },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.diff.changes[0]).toMatchObject({
      path: 'metadata.style',
      kind: 'changed',
    });
  });

  it('returns an auditable, unpersisted draft with fact references', async () => {
    const ctx = await buildTestContext();
    await createStrategyTool.execute(
      { id: 'draft-proposal', name: '草案', description: '测试' },
      ctx,
    );
    const base = await createStrategyVersionTool.execute(
      { strategyId: 'draft-proposal', definition: definition('trend') },
      ctx,
    );
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const result = await proposeStrategyVersionDraftTool.execute(
      {
        strategyId: 'draft-proposal',
        baseVersionId: base.data.version.id,
        definition: definition('value'),
        changeSummary: '根据运行窗口调整风格字段',
        factReferences: ['runs:window'],
        agentTrace: [],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.draft.parentVersionId).toBe(base.data.version.id);
    expect(result.data.draft.factReferences).toEqual(['runs:window']);
    expect(result.data.audit.persisted).toBe(false);
    expect(await ctx.repos.strategy.listVersions('draft-proposal')).toHaveLength(1);
  });

  it('runs baseline and draft on the same sample without formal runs', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 1 });
    await createStrategyTool.execute(
      { id: 'trial-proposal', name: '试算', description: '测试' },
      ctx,
    );
    const base = await createStrategyVersionTool.execute(
      { strategyId: 'trial-proposal', definition: definition('trend') },
      ctx,
    );
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    await validateStrategyVersionTool.execute({ versionId: base.data.version.id }, ctx);
    await publishStrategyVersionTool.execute({ versionId: base.data.version.id }, ctx);
    const draft = await createStrategyVersionTool.execute(
      { strategyId: 'trial-proposal', definition: definition('value') },
      ctx,
    );
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    await validateStrategyVersionTool.execute({ versionId: draft.data.version.id }, ctx);
    const trial = await trialStrategyVersionTool.execute(
      {
        strategyId: 'trial-proposal',
        baseVersionId: base.data.version.id,
        draftVersionId: draft.data.version.id,
        stockIds: ['600519.SH'],
      },
      ctx,
    );
    expect(trial.ok).toBe(true);
    if (!trial.ok) return;
    expect(trial.data.persisted).toBe(false);
    expect(trial.data.stockIds).toEqual(['600519.SH']);
    expect(trial.data.diff.definitionChanged).toBe(true);
    expect(await ctx.repos.strategyRun.listRuns({ strategyId: 'trial-proposal' })).toHaveLength(0);
  });
});
