import { type StrategyDslV1, strategyDefinitionHash } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import {
  claimDueStrategySchedulesTool,
  finishStrategyScheduleClaimTool,
  getStrategyScheduleTool,
  setStrategyScheduleTool,
} from './strategy-schedule.js';

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

  it('保存自动推荐政策时移除已退役的 T+20 配置', async () => {
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
      observationHorizons: ['t3', 't5'],
    });
  });

  it('完成时从被消耗的发生点推进 nextRunAt，长运行不吞掉中间发生点', async () => {
    let now = new Date('2026-10-27T00:30:00.000Z');
    const ctx = await buildTestContext({ clock: () => now });
    await seedActiveStrategy(ctx);
    await setStrategyScheduleTool.execute(
      { strategyId: 'scheduled', cron: '0 9-15 * * 1-5', timezone: 'Asia/Shanghai' },
      ctx,
    );
    now = new Date('2026-10-27T01:00:00.000Z');
    const claimed = await claimDueStrategySchedulesTool.execute(
      { owner: 'cycle-long', leaseMinutes: 240 },
      ctx,
    );
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const item = claimed.data.items[0];
    expect(item?.schedule.nextRunAt).toEqual(new Date('2026-10-27T01:00:00.000Z'));

    // 运行跨过 10:00、11:00、12:00 三个发生点，13:00 前才结束。
    now = new Date('2026-10-27T04:30:00.000Z');
    const finished = await finishStrategyScheduleClaimTool.execute(
      {
        scheduleId: item?.schedule.id ?? '',
        owner: 'cycle-long',
        fence: item?.lease.fence ?? 1,
        ...(item?.schedule.nextRunAt === undefined
          ? {}
          : { claimedNextRunAt: item.schedule.nextRunAt }),
      },
      ctx,
    );
    expect(finished.ok).toBe(true);
    if (!finished.ok) return;
    // 从被消耗的 09:00 发生点推进到 10:00；按完成时刻推进会直接跳到 13:00，吞掉中间发生点。
    expect(finished.data.schedule.nextRunAt).toEqual(new Date('2026-10-27T02:00:00.000Z'));
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
