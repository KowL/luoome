import {
  type Strategy,
  type StrategyDslV1,
  type StrategySchedule,
  type StrategyVersion,
  strategyDefinitionHash,
} from '@luoome/core';
import { buildTestContext, seedTestStockUniverse } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { runStrategySchedulesWorkflow } from './run-strategy-schedules.js';

const NOW = new Date('2026-08-10T10:00:00.000Z');

const seedScheduled = async (status: Strategy['status'] = 'active', recommendations = false) => {
  const ctx = await buildTestContext({ clock: () => NOW });
  await seedTestStockUniverse(ctx, { limit: 1 });
  const definition: StrategyDslV1 = {
    schemaVersion: 1,
    metadata: {},
    universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
    selection: {
      logic: 'all',
      rules: [{ id: 'all', name: '全选', when: 'true', evidence: ['fixture'] }],
    },
    scoring: {
      method: 'weighted-sum',
      components: [{ ruleId: 'all', score: '80', weight: 1 }],
    },
    signals: {
      entry: [
        {
          id: 'entry',
          name: '入场',
          when: 'true',
          score: '80',
          direction: 'bullish',
          evidence: ['fixture'],
        },
      ],
      exit: [],
      risk: [],
    },
  };
  const version: StrategyVersion = {
    id: 'scheduled-v1',
    strategyId: 'scheduled',
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: NOW,
    createdAt: NOW,
  };
  await ctx.repos.strategy.create({
    id: 'scheduled',
    name: '调度策略',
    description: 'test',
    owner: 'user',
    status,
    currentVersionId: version.id,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await ctx.repos.strategy.createVersion(version);
  const schedule: StrategySchedule = {
    id: 'strategy-schedule:scheduled',
    strategyId: 'scheduled',
    cron: '0 18 * * 1-5',
    timezone: 'Asia/Shanghai',
    enabled: true,
    ...(recommendations
      ? {
          recommendationPolicy: {
            enabled: true,
            minScore: 70,
            maxRank: 10,
            maxPerRun: 3,
            cooldownHours: 72,
            notify: true,
            channel: 'log' as const,
            observationHorizons: ['t3', 't5', 't20'] as const,
          },
        }
      : {}),
    nextRunAt: NOW,
    createdAt: new Date('2026-08-09T10:00:00.000Z'),
    updatedAt: new Date('2026-08-09T10:00:00.000Z'),
  };
  await ctx.repos.strategySchedule.save(schedule);
  return ctx;
};

describe('run-strategy-schedules workflow', () => {
  it('抢占到期配置、生成 scheduled StrategyRun 并推进 nextRunAt', async () => {
    const ctx = await seedScheduled();
    const result = await runStrategySchedulesWorkflow.run({ owner: 'worker-1' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ ran: 1, skipped: 0, failed: 0 });
    const runId = result.data.items[0]?.runId;
    expect(runId).toBeDefined();
    expect(
      runId === undefined ? null : await ctx.repos.strategyRun.findRunById(runId),
    ).toMatchObject({ mode: 'scheduled' });
    expect(await ctx.repos.strategySchedule.findByStrategyId('scheduled')).toMatchObject({
      lastRunId: runId,
      nextRunAt: new Date('2026-08-11T10:00:00.000Z'),
    });
    const second = await runStrategySchedulesWorkflow.run({ owner: 'worker-2' }, ctx);
    expect(second).toEqual({
      ok: true,
      data: { items: [], ran: 0, skipped: 0, failed: 0 },
    });
  });

  it('paused Strategy 不运行但会推进调度，避免补跑风暴', async () => {
    const ctx = await seedScheduled('paused');
    const result = await runStrategySchedulesWorkflow.run({ owner: 'worker-1' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ ran: 0, skipped: 1, failed: 0 });
    expect(result.data.items[0]?.reason).toContain('active');
    expect(await ctx.repos.strategySchedule.findByStrategyId('scheduled')).toMatchObject({
      nextRunAt: new Date('2026-08-11T10:00:00.000Z'),
    });
  });

  it('启用推荐政策时，定时运行后自动生成 Advice 并通知', async () => {
    const ctx = await seedScheduled('active', true);
    const result = await runStrategySchedulesWorkflow.run({ owner: 'worker-recommend' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]).toMatchObject({ status: 'ran', adviceCount: 1 });
    const advices = await ctx.repos.advice.query({
      sourceTool: 'analyze_strategy_candidate',
      includeExpired: true,
    });
    expect(advices).toHaveLength(1);
    expect(await ctx.repos.notification.listByAdvice(advices[0]?.id ?? '')).toHaveLength(1);
  });
});
