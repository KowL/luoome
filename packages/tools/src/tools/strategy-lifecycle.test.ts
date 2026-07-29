import type { StrategyDslV1 } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { ensureBuiltinStrategies } from '../context.js';
import { buildTestContext } from '../testing/context.js';
import {
  createStrategyTool,
  createStrategyVersionTool,
  publishStrategyVersionTool,
  validateStrategyVersionTool,
} from './strategy-lifecycle.js';

const validDefinition = (): StrategyDslV1 => ({
  schemaVersion: 1,
  metadata: { horizon: 'short' },
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
  signals: { entry: [], exit: [], risk: [] },
});

describe('Strategy lifecycle tools', () => {
  it('creates, validates and publishes a user StrategyVersion', async () => {
    const ctx = await buildTestContext();
    const created = await createStrategyTool.execute(
      { id: 'my-strategy', name: '我的策略', description: '测试策略' },
      ctx,
    );
    expect(created.ok).toBe(true);

    const version = await createStrategyVersionTool.execute(
      {
        strategyId: 'my-strategy',
        definition: validDefinition(),
        changeSummary: 'initial',
      },
      ctx,
    );
    expect(version.ok).toBe(true);
    if (!version.ok) return;

    const validated = await validateStrategyVersionTool.execute(
      { versionId: version.data.version.id },
      ctx,
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.data.version.validationStatus).toBe('valid');
    expect(validated.data.referencedFields).toEqual(['quote.close']);

    const published = await publishStrategyVersionTool.execute(
      { versionId: version.data.version.id },
      ctx,
    );
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.data.strategy).toMatchObject({
      status: 'active',
      currentVersionId: version.data.version.id,
    });
  });

  it('marks an unregistered field invalid and refuses publish', async () => {
    const ctx = await buildTestContext();
    await createStrategyTool.execute(
      { id: 'bad-strategy', name: '坏策略', description: '测试坏字段' },
      ctx,
    );
    const bad = validDefinition();
    bad.selection.rules[0] = {
      id: 'bad-field',
      name: '坏字段',
      when: 'fundamentals.roe > 0',
      evidence: ['坏字段'],
    };
    const created = await createStrategyVersionTool.execute(
      { strategyId: 'bad-strategy', definition: bad },
      ctx,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const validated = await validateStrategyVersionTool.execute(
      { versionId: created.data.version.id },
      ctx,
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.data.version.validationStatus).toBe('invalid');
    const published = await publishStrategyVersionTool.execute(
      { versionId: created.data.version.id },
      ctx,
    );
    expect(published.ok).toBe(false);
  });

  it('seeds builtin Strategies without writing legacy Tactic or import runs', async () => {
    const ctx = await buildTestContext();
    const legacyBefore = await ctx.repos.tactic.list();
    await ensureBuiltinStrategies(ctx.repos);
    const strategy = await ctx.repos.strategy.findById('breakout-volume');
    expect(strategy).toMatchObject({ owner: 'builtin', status: 'active' });
    expect(await ctx.repos.tactic.list()).toEqual(legacyBefore);
    const run = await ctx.repos.strategyRun.findRunById('legacy-signal-import-breakout-volume');
    expect(run).toBeNull();
  });
});
