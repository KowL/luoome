import { BUILTIN_STRATEGIES, type StrategyDslV1 } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { ensureBuiltinStrategies } from '../context.js';
import { buildTestContext } from '../testing/context.js';
import {
  createStrategyTool,
  createStrategyVersionTool,
  pauseStrategyTool,
  publishStrategyVersionTool,
  resumeStrategyTool,
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

  it('从旧版本派生时按最新版本递增编号，同时保留所选 parent', async () => {
    const ctx = await buildTestContext();
    await createStrategyTool.execute(
      { id: 'branch-strategy', name: '分支策略', description: '测试旧版本派生' },
      ctx,
    );
    const first = await createStrategyVersionTool.execute(
      { strategyId: 'branch-strategy', definition: validDefinition() },
      ctx,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await createStrategyVersionTool.execute(
      { strategyId: 'branch-strategy', definition: validDefinition() },
      ctx,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const branched = await createStrategyVersionTool.execute(
      {
        strategyId: 'branch-strategy',
        definition: validDefinition(),
        parentVersionId: first.data.version.id,
      },
      ctx,
    );

    expect(branched.ok).toBe(true);
    if (!branched.ok) return;
    expect(branched.data.version).toMatchObject({
      version: 3,
      parentVersionId: first.data.version.id,
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

  it('validate/publish 可绑定 Strategy，拒绝跨策略 versionId', async () => {
    const ctx = await buildTestContext();
    await createStrategyTool.execute({ id: 'strategy-a', name: '策略 A', description: 'A' }, ctx);
    await createStrategyTool.execute({ id: 'strategy-b', name: '策略 B', description: 'B' }, ctx);
    const version = await createStrategyVersionTool.execute(
      { strategyId: 'strategy-a', definition: validDefinition() },
      ctx,
    );
    expect(version.ok).toBe(true);
    if (!version.ok) return;
    const validated = await validateStrategyVersionTool.execute(
      { strategyId: 'strategy-b', versionId: version.data.version.id },
      ctx,
    );
    expect(validated.ok).toBe(false);
    const published = await publishStrategyVersionTool.execute(
      { strategyId: 'strategy-b', versionId: version.data.version.id },
      ctx,
    );
    expect(published.ok).toBe(false);
  });

  it('seeds builtin Strategies without writing import runs', async () => {
    const ctx = await buildTestContext();
    await ensureBuiltinStrategies(ctx.repos);
    const strategy = await ctx.repos.strategy.findById('breakout-volume');
    expect(strategy).toMatchObject({ owner: 'builtin', status: 'active' });
    const run = await ctx.repos.strategyRun.findRunById('legacy-signal-import-breakout-volume');
    expect(run).toBeNull();
  });

  it('publish 会把 paused 的 Strategy 隐式置回 active（锁定该语义）', async () => {
    const ctx = await buildTestContext();
    await createStrategyTool.execute(
      { id: 'pause-publish', name: '暂停发布', description: '测试暂停后发布' },
      ctx,
    );
    const first = await createStrategyVersionTool.execute(
      { strategyId: 'pause-publish', definition: validDefinition() },
      ctx,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await validateStrategyVersionTool.execute({ versionId: first.data.version.id }, ctx);
    await publishStrategyVersionTool.execute({ versionId: first.data.version.id }, ctx);
    const paused = await pauseStrategyTool.execute({ strategyId: 'pause-publish' }, ctx);
    expect(paused.ok).toBe(true);
    const version = await createStrategyVersionTool.execute(
      { strategyId: 'pause-publish', definition: validDefinition() },
      ctx,
    );
    expect(version.ok).toBe(true);
    if (!version.ok) return;
    await validateStrategyVersionTool.execute({ versionId: version.data.version.id }, ctx);
    const published = await publishStrategyVersionTool.execute(
      { versionId: version.data.version.id },
      ctx,
    );
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.data.strategy.status).toBe('active');
  });

  it('resume_strategy 恢复 paused Strategy；draft 或 active 拒绝', async () => {
    const ctx = await buildTestContext();
    await createStrategyTool.execute(
      { id: 'resume-me', name: '恢复策略', description: '测试恢复' },
      ctx,
    );
    // draft（无 currentVersion）不可恢复为 active
    const draftResume = await resumeStrategyTool.execute({ strategyId: 'resume-me' }, ctx);
    expect(draftResume.ok).toBe(false);
    if (draftResume.ok) return;
    expect(draftResume.error.kind).toBe('invalid_input');
    const draftPause = await pauseStrategyTool.execute({ strategyId: 'resume-me' }, ctx);
    expect(draftPause.ok).toBe(false);

    const version = await createStrategyVersionTool.execute(
      { strategyId: 'resume-me', definition: validDefinition() },
      ctx,
    );
    expect(version.ok).toBe(true);
    if (!version.ok) return;
    await validateStrategyVersionTool.execute({ versionId: version.data.version.id }, ctx);
    await publishStrategyVersionTool.execute({ versionId: version.data.version.id }, ctx);

    // active 状态不可重复恢复
    const activeResume = await resumeStrategyTool.execute({ strategyId: 'resume-me' }, ctx);
    expect(activeResume.ok).toBe(false);

    await pauseStrategyTool.execute({ strategyId: 'resume-me' }, ctx);
    const resumed = await resumeStrategyTool.execute({ strategyId: 'resume-me' }, ctx);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.data.strategy.status).toBe('active');
    expect(resumed.data.strategy.currentVersionId).toBe(version.data.version.id);
  });

  it('resume_strategy 拒绝 builtin Strategy', async () => {
    const ctx = await buildTestContext();
    await ensureBuiltinStrategies(ctx.repos);
    const result = await resumeStrategyTool.execute({ strategyId: 'breakout-volume' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('用户自建与内置策略同 id 的 draft Strategy 时不重复播种', async () => {
    const ctx = await buildTestContext();
    await createStrategyTool.execute(
      { id: 'breakout-volume', name: '用户同名策略', description: '占用 builtin tactic id' },
      ctx,
    );
    await ensureBuiltinStrategies(ctx.repos);
    await ensureBuiltinStrategies(ctx.repos);
    const strategies = await ctx.repos.strategy.list();
    expect(strategies.filter((s) => s.id === 'breakout-volume')).toHaveLength(1);
    expect(strategies.filter((s) => s.id.startsWith('legacy-tactic-'))).toEqual([]);
  });

  it('把存量 builtin v1 协调到固定 v3 revision，重复执行保持幂等', async () => {
    const ctx = await buildTestContext();
    const current = BUILTIN_STRATEGIES.find((bundle) => bundle.strategy.id === 'breakout-volume');
    if (current === undefined) throw new Error('builtin fixture missing');
    const legacyVersion = {
      ...current.version,
      id: 'breakout-volume-v1',
      version: 1,
      changeSummary: 'legacy builtin',
    };
    await ctx.repos.strategy.create({
      ...current.strategy,
      currentVersionId: legacyVersion.id,
    });
    await ctx.repos.strategy.createVersion(legacyVersion);

    await ensureBuiltinStrategies(ctx.repos);
    await ensureBuiltinStrategies(ctx.repos);

    expect(await ctx.repos.strategy.findById(current.strategy.id)).toMatchObject({
      currentVersionId: current.version.id,
      status: 'active',
    });
    expect(await ctx.repos.strategy.listVersions(current.strategy.id)).toMatchObject([
      { id: legacyVersion.id, version: 1 },
      {
        id: current.version.id,
        version: 3,
        parentVersionId: legacyVersion.id,
        definitionHash: current.version.definitionHash,
      },
    ]);
  });
});
