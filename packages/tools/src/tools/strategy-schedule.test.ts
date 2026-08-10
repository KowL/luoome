import { type StrategyDslV1, strategyDefinitionHash } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { getStrategyScheduleTool, setStrategyScheduleTool } from './strategy-schedule.js';

const NOW = new Date('2026-08-10T09:00:00.000Z');
const definition: StrategyDslV1 = {
  schemaVersion: 1,
  metadata: {},
  universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
  selection: {
    logic: 'all',
    rules: [{ id: 'all', name: '全部', when: 'true', evidence: ['fixture'] }],
  },
  signals: { entry: [], exit: [], risk: [] },
};

const seedActiveStrategy = async (ctx: Awaited<ReturnType<typeof buildTestContext>>) => {
  const version = {
    id: 'scheduled-v1',
    strategyId: 'scheduled',
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid' as const,
    validationErrors: [],
    publishedAt: NOW,
    createdAt: NOW,
  };
  await ctx.repos.strategy.create({
    id: 'scheduled',
    name: '调度策略',
    description: 'test',
    owner: 'user',
    status: 'active',
    currentVersionId: version.id,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await ctx.repos.strategy.createVersion(version);
};

describe('strategy schedule tools', () => {
  it('为 active Strategy 创建可用调度并可读回', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedActiveStrategy(ctx);
    const saved = await setStrategyScheduleTool.execute(
      { strategyId: 'scheduled', cron: '0 18 * * 1-5', timezone: 'Asia/Shanghai' },
      ctx,
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.data.schedule).toMatchObject({
      strategyId: 'scheduled',
      enabled: true,
      nextRunAt: new Date('2026-08-10T10:00:00.000Z'),
    });
    expect(await getStrategyScheduleTool.execute({ strategyId: 'scheduled' }, ctx)).toEqual(saved);
  });

  it('保存默认关闭的自动推荐政策', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedActiveStrategy(ctx);
    const saved = await setStrategyScheduleTool.execute(
      {
        strategyId: 'scheduled',
        cron: '0 18 * * 1-5',
        recommendationPolicy: {
          enabled: true,
          minScore: 75,
          maxRank: 8,
          maxPerRun: 2,
          cooldownHours: 48,
          notify: false,
          channel: 'log',
          observationHorizons: ['t3', 't5', 't20'],
        },
      },
      ctx,
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.data.schedule.recommendationPolicy).toEqual({
      enabled: true,
      minScore: 75,
      maxRank: 8,
      maxPerRun: 2,
      cooldownHours: 48,
      notify: false,
      channel: 'log',
      observationHorizons: ['t3', 't5', 't20'],
    });
  });

  it('拒绝无效 cron 和 draft Strategy 的启用调度', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedActiveStrategy(ctx);
    const invalidCron = await setStrategyScheduleTool.execute(
      { strategyId: 'scheduled', cron: '99 18 * * 1-5' },
      ctx,
    );
    expect(invalidCron.ok).toBe(false);
    if (invalidCron.ok) return;
    expect(invalidCron.error.kind).toBe('invariant_violation');

    await ctx.repos.strategy.create({
      id: 'draft',
      name: '草稿',
      description: 'test',
      owner: 'user',
      status: 'draft',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const draft = await setStrategyScheduleTool.execute(
      { strategyId: 'draft', cron: '0 18 * * 1-5' },
      ctx,
    );
    expect(draft.ok).toBe(false);
    if (draft.ok) return;
    expect(draft.error.kind).toBe('invalid_input');
  });
});
