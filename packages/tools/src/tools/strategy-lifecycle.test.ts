import { BUILTIN_STRATEGY_TEMPLATES, type StrategyDslV1 } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext, seedTestStockUniverse } from '../testing/context.js';
import { runStrategyTool } from './run-strategy.js';
import {
  createStrategyTool,
  createStrategyVersionTool,
  deleteStrategyTool,
  pauseStrategyTool,
  publishStrategyVersionTool,
  resumeStrategyTool,
  validateStrategyVersionTool,
} from './strategy-lifecycle.js';
import { setStrategyScheduleTool } from './strategy-schedule.js';

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

  it('builtin 内容只存在于模板目录，不写入 Strategy repository', async () => {
    const ctx = await buildTestContext();
    expect(BUILTIN_STRATEGY_TEMPLATES.some((template) => template.id === 'breakout-volume')).toBe(
      true,
    );
    expect(await ctx.repos.strategy.list()).toEqual([]);
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

  it('delete_strategy 级联删除版本、调度、运行、信号和观察数据', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 1 });
    await createStrategyTool.execute(
      { id: 'delete-me', name: '待删除策略', description: '验证级联删除' },
      ctx,
    );
    const definition = validDefinition();
    definition.signals.entry = [
      {
        id: 'entry',
        name: '入场信号',
        when: 'quote.close > 0',
        score: '80',
        direction: 'bullish',
        evidence: ['价格有效'],
      },
    ];
    const version = await createStrategyVersionTool.execute(
      { strategyId: 'delete-me', definition },
      ctx,
    );
    expect(version.ok).toBe(true);
    if (!version.ok) return;
    await validateStrategyVersionTool.execute({ versionId: version.data.version.id }, ctx);
    await publishStrategyVersionTool.execute({ versionId: version.data.version.id }, ctx);
    await setStrategyScheduleTool.execute({ strategyId: 'delete-me', cron: '0 18 * * 1-5' }, ctx);
    const run = await runStrategyTool.execute(
      { strategyId: 'delete-me', stockIds: ['600519.SH'], persist: true },
      ctx,
    );
    if (!run.ok) throw new Error(JSON.stringify(run.error));
    expect(run).toMatchObject({ ok: true });
    expect(await ctx.repos.signalObservation.list({ sourceKind: 'strategy-signal' })).not.toEqual(
      [],
    );

    const deleted = await deleteStrategyTool.execute({ strategyId: 'delete-me' }, ctx);
    expect(deleted).toEqual({ ok: true, data: { deleted: true } });
    expect(await ctx.repos.strategy.findById('delete-me')).toBeNull();
    expect(await ctx.repos.strategy.listVersions('delete-me')).toEqual([]);
    expect(await ctx.repos.strategySchedule.findByStrategyId('delete-me')).toBeNull();
    expect(await ctx.repos.strategyRun.listRuns({ strategyId: 'delete-me' })).toEqual([]);
    expect(await ctx.repos.strategyRun.signalsByStrategy('delete-me')).toEqual([]);
    expect(await ctx.repos.signalObservation.list({ sourceKind: 'strategy-signal' })).toEqual([]);
  });

  it('delete_strategy 拒绝删除仍被 AlertPlan 引用的策略', async () => {
    const ctx = await buildTestContext();
    await createStrategyTool.execute(
      { id: 'referenced-strategy', name: '被引用策略', description: '验证引用保护' },
      ctx,
    );
    const now = ctx.clock();
    await ctx.repos.alertPlan.save({
      id: 'strategy-reference-plan',
      name: '策略引用方案',
      watchlistId: 'watchlist-placeholder',
      rules: [
        {
          id: 'signal',
          kind: 'strategy-signal',
          strategyId: 'referenced-strategy',
          minScore: 60,
        },
      ],
      logic: 'ANY',
      triggerMode: 'on-enter',
      cooldownMinutes: 30,
      dailyNotificationLimit: 20,
      notifyOnRecovery: false,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    const deleted = await deleteStrategyTool.execute({ strategyId: 'referenced-strategy' }, ctx);
    expect(deleted.ok).toBe(false);
    expect(await ctx.repos.strategy.findById('referenced-strategy')).not.toBeNull();
  });
});
