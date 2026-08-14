import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { getStrategyReliabilitySummaryTool } from './get-strategy-reliability-summary.js';

describe('get_strategy_reliability_summary', () => {
  it('按真实 WorkflowRun 审计聚合交易日、租约、checkpoint 和降级事实', async () => {
    const ctx = await buildTestContext();
    await ctx.repos.workflowRun.save({
      id: 'cycle-ok',
      workflowName: 'strategy-daily-cycle',
      mode: 'scheduled',
      status: 'partial',
      startedAt: new Date('2026-08-10T09:00:00.000Z'),
      finishedAt: new Date('2026-08-10T09:01:00.000Z'),
      inputSummary: {
        strategyId: 'strategy-1',
        scheduleId: 'schedule-1',
        dataAsOf: new Date('2026-08-10T00:00:00.000Z'),
      },
      outputSummary: {
        publication: 'published',
        leaseRenewals: 2,
        checkpoint: {
          requestedCount: 10,
          availableCount: 10,
          failedCount: 0,
          coverageRatio: 1,
        },
        observations: { completed: 3, pending: 0 },
        insightProvider: 'facts-only',
        phaseTimings: [
          { phase: 'data-prep', durationMs: 120 },
          { phase: 'run', durationMs: 300 },
        ],
      },
      providerStatuses: [
        {
          provider: 'checkpoint:daily-bars',
          ok: true,
          latencyMs: { samples: 10, p50Ms: 100, p95Ms: 180, maxMs: 220 },
        },
        { provider: 'market', ok: false, errorKind: 'timeout' },
      ],
    });
    await ctx.repos.workflowRun.save({
      id: 'cycle-lost',
      workflowName: 'strategy-daily-cycle',
      mode: 'scheduled',
      status: 'failed',
      startedAt: new Date('2026-08-11T09:00:00.000Z'),
      finishedAt: new Date('2026-08-11T09:01:00.000Z'),
      inputSummary: {
        strategyId: 'strategy-1',
        scheduleId: 'schedule-1',
        dataAsOf: new Date('2026-08-11T00:00:00.000Z'),
      },
      outputSummary: { reason: 'lease_lost_before_commit' },
      providerStatuses: [],
      error: 'lease_lost_before_commit',
    });

    const result = await getStrategyReliabilitySummaryTool.execute(
      { strategyId: 'strategy-1', targetTradingDays: 2 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      runCount: 2,
      historicalRunCount: 0,
      scheduleCount: 1,
      tradingDays: 2,
      statuses: { running: 0, partial: 1, failed: 1, succeeded: 0 },
      publications: { published: 1, withheld: 0, nonPublishing: 0, missing: 1 },
      leases: { totalRenewals: 2, runsWithRenewal: 1, leaseLost: 1 },
      checkpoints: {
        runsWithCheckpoint: 1,
        requestedCount: 10,
        availableCount: 10,
        failedCount: 0,
        belowAcceptance: 0,
        coverageRatio: 1,
      },
      observations: { runsWithObservations: 1, completed: 3, pending: 0 },
      insight: { factsOnly: 1, unavailable: 0 },
      providerErrors: { timeout: 1 },
      scheduleDayDuplicates: 0,
      phaseDurations: {
        'data-prep': { samples: 1, p50Ms: 120, p95Ms: 120, maxMs: 120 },
        run: { samples: 1, p50Ms: 300, p95Ms: 300, maxMs: 300 },
      },
      providerLatencies: {
        'checkpoint:daily-bars': { samples: 10, p50Ms: 100, p95Ms: 180, maxMs: 220 },
      },
      gate: {
        targetTradingDays: 2,
        ready: false,
        blockers: ['lease-lost', 'publication-missing', 'cycle-failed'],
      },
    });
  });

  it('正式周期缺审计事实或被 withheld 时不能误报 ready', async () => {
    const ctx = await buildTestContext();
    await ctx.repos.workflowRun.save({
      id: 'cycle-incomplete-audit',
      workflowName: 'strategy-daily-cycle',
      mode: 'scheduled',
      status: 'partial',
      startedAt: new Date('2026-08-12T09:00:00.000Z'),
      finishedAt: new Date('2026-08-12T09:01:00.000Z'),
      inputSummary: {
        strategyId: 'strategy-incomplete-audit',
        scheduleId: 'schedule-incomplete-audit',
        dataAsOf: new Date('2026-08-12T00:00:00.000Z'),
      },
      outputSummary: { publication: 'withheld' },
      providerStatuses: [],
    });

    const result = await getStrategyReliabilitySummaryTool.execute(
      { strategyId: 'strategy-incomplete-audit', targetTradingDays: 1 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.gate).toMatchObject({
      ready: false,
      blockers: ['publication-withheld', 'checkpoint-missing', 'observation-audit-missing'],
    });
  });

  it('把同一 schedule 同一交易日的重复正式运行列为可靠性门禁阻塞', async () => {
    const ctx = await buildTestContext();
    const base = {
      workflowName: 'strategy-daily-cycle' as const,
      mode: 'scheduled' as const,
      status: 'succeeded' as const,
      startedAt: new Date('2026-08-12T09:00:00.000Z'),
      finishedAt: new Date('2026-08-12T09:01:00.000Z'),
      inputSummary: {
        strategyId: 'strategy-duplicate',
        scheduleId: 'schedule-duplicate',
        dataAsOf: new Date('2026-08-12T00:00:00.000Z'),
      },
      outputSummary: {
        publication: 'published',
        checkpoint: {
          requestedCount: 1,
          availableCount: 1,
          failedCount: 0,
          coverageRatio: 1,
        },
        observations: { completed: 0, pending: 0 },
      },
      providerStatuses: [],
    };
    await ctx.repos.workflowRun.save({ id: 'cycle-duplicate-1', ...base });
    await ctx.repos.workflowRun.save({ id: 'cycle-duplicate-2', ...base });

    const result = await getStrategyReliabilitySummaryTool.execute(
      { strategyId: 'strategy-duplicate', targetTradingDays: 1 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.scheduleDayDuplicates).toBe(1);
    expect(result.data.gate).toMatchObject({
      ready: false,
      blockers: ['schedule-day-duplicate'],
    });
  });

  it('多 schedule 不拼接交易日；任一 schedule 未达目标时保持门禁阻塞', async () => {
    const ctx = await buildTestContext();
    const run = async (id: string, scheduleId: string, day: string) =>
      ctx.repos.workflowRun.save({
        id,
        workflowName: 'strategy-daily-cycle',
        mode: 'scheduled',
        status: 'succeeded',
        startedAt: new Date(`${day}T09:00:00.000Z`),
        finishedAt: new Date(`${day}T09:01:00.000Z`),
        inputSummary: {
          strategyId: 'strategy-multi-schedule',
          scheduleId,
          dataAsOf: new Date(`${day}T00:00:00.000Z`),
        },
        outputSummary: {
          publication: 'published',
          checkpoint: { requestedCount: 1, availableCount: 1, failedCount: 0, coverageRatio: 1 },
          observations: { completed: 0, pending: 0 },
        },
        providerStatuses: [],
      });
    await run('multi-a-1', 'schedule-a', '2026-08-10');
    await run('multi-b-1', 'schedule-b', '2026-08-10');
    await run('multi-b-2', 'schedule-b', '2026-08-11');

    const result = await getStrategyReliabilitySummaryTool.execute(
      { strategyId: 'strategy-multi-schedule', targetTradingDays: 2 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.scheduleTradingDayKeys).toEqual({
      'schedule-a': ['2026-08-10'],
      'schedule-b': ['2026-08-10', '2026-08-11'],
    });
    expect(result.data).toMatchObject({
      tradingDays: 2,
      scheduleCount: 2,
      gate: { ready: false, blockers: ['schedule-days-below-target'] },
    });

    const singleSchedule = await getStrategyReliabilitySummaryTool.execute(
      {
        strategyId: 'strategy-multi-schedule',
        scheduleId: 'schedule-a',
        targetTradingDays: 1,
      },
      ctx,
    );
    expect(singleSchedule.ok).toBe(true);
    if (!singleSchedule.ok) return;
    expect(singleSchedule.data).toMatchObject({
      scheduleId: 'schedule-a',
      scheduleTradingDayKeys: { 'schedule-a': ['2026-08-10'] },
      gate: { ready: true, blockers: [] },
    });
  });

  it('保留 stale 收敛审计但不把它计入正式周期或重复门禁', async () => {
    const ctx = await buildTestContext();
    const base = {
      workflowName: 'strategy-daily-cycle' as const,
      mode: 'scheduled' as const,
      status: 'failed' as const,
      startedAt: new Date('2026-08-12T08:00:00.000Z'),
      finishedAt: new Date('2026-08-12T09:00:00.000Z'),
      inputSummary: {
        strategyId: 'strategy-stale',
        scheduleId: 'schedule-stale',
        dataAsOf: new Date('2026-08-12T00:00:00.000Z'),
      },
      outputSummary: {
        reconciliation: 'stale_workflow_run_reconciled',
        phaseTimings: [{ phase: 'data-prep', durationMs: 999_999 }],
      },
      error: 'stale_workflow_run_reconciled',
      providerStatuses: [],
    };
    await ctx.repos.workflowRun.save({ id: 'cycle-stale', ...base });

    const result = await getStrategyReliabilitySummaryTool.execute(
      { strategyId: 'strategy-stale', targetTradingDays: 1 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.runCount).toBe(0);
    expect(result.data.historicalRunCount).toBe(0);
    expect(result.data.tradingDays).toBe(0);
    expect(result.data.scheduleDayDuplicates).toBe(0);
    expect(result.data.phaseDurations).toEqual({});
  });

  it('不把 skipped claim 审计计入生产周期', async () => {
    const ctx = await buildTestContext();
    await ctx.repos.workflowRun.save({
      id: 'cycle-skipped',
      workflowName: 'strategy-daily-cycle',
      mode: 'scheduled',
      status: 'succeeded',
      startedAt: new Date('2026-08-12T09:00:00.000Z'),
      finishedAt: new Date('2026-08-12T09:00:01.000Z'),
      inputSummary: {
        strategyId: 'strategy-skipped',
        scheduleId: 'schedule-skipped',
        dataAsOf: new Date('2026-08-12T00:00:00.000Z'),
      },
      outputSummary: { status: 'skipped', reason: 'schedule-day-duplicate' },
      providerStatuses: [],
    });

    const result = await getStrategyReliabilitySummaryTool.execute(
      { strategyId: 'strategy-skipped', targetTradingDays: 1 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      runCount: 0,
      historicalRunCount: 0,
      tradingDays: 0,
      statuses: { running: 0, succeeded: 0, partial: 0, failed: 0 },
      gate: { blockers: ['trading-days-below-target'] },
    });
  });

  it('历史 asOf 周期保留审计但不污染生产状态与门禁', async () => {
    const ctx = await buildTestContext();
    await ctx.repos.workflowRun.save({
      id: 'cycle-historical',
      workflowName: 'strategy-daily-cycle',
      mode: 'scheduled',
      status: 'failed',
      startedAt: new Date('2026-08-13T18:34:30.000Z'),
      finishedAt: new Date('2026-08-13T18:34:31.000Z'),
      inputSummary: {
        strategyId: 'strategy-historical',
        scheduleId: 'schedule-historical',
        dataAsOf: new Date('2026-08-11T10:00:00.000Z'),
      },
      outputSummary: { status: 'failed', phase: 'finish' },
      providerStatuses: [],
      error: 'prepare_strategy_data 需要非空 PIT StockUniverse',
    });
    await ctx.repos.workflowRun.save({
      id: 'cycle-explicit-historical',
      workflowName: 'strategy-daily-cycle',
      mode: 'scheduled',
      status: 'failed',
      startedAt: new Date('2026-08-14T01:00:00.000Z'),
      finishedAt: new Date('2026-08-14T01:00:01.000Z'),
      inputSummary: {
        strategyId: 'strategy-historical',
        scheduleId: 'schedule-historical',
        dataAsOf: new Date('2026-08-14T00:00:00.000Z'),
        requestedBy: 'historical',
      },
      outputSummary: { status: 'failed', phase: 'finish' },
      providerStatuses: [],
      error: 'historical failure',
    });

    const result = await getStrategyReliabilitySummaryTool.execute(
      { strategyId: 'strategy-historical', targetTradingDays: 1 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      runCount: 0,
      historicalRunCount: 2,
      tradingDays: 0,
      statuses: { running: 0, succeeded: 0, partial: 0, failed: 0 },
      gate: { blockers: ['trading-days-below-target'] },
    });
  });

  it('按 dataAsOf 而不是 WorkflowRun 启动时间过滤 since/until 区间', async () => {
    const ctx = await buildTestContext();
    const base = {
      workflowName: 'strategy-daily-cycle' as const,
      mode: 'scheduled' as const,
      status: 'succeeded' as const,
      finishedAt: new Date('2026-08-14T09:01:00.000Z'),
      inputSummary: {
        strategyId: 'strategy-range',
        scheduleId: 'schedule-range',
      },
      outputSummary: {
        publication: 'published',
        checkpoint: { requestedCount: 1, availableCount: 1, failedCount: 0, coverageRatio: 1 },
        observations: { completed: 0, pending: 0 },
      },
      providerStatuses: [],
    };
    await ctx.repos.workflowRun.save({
      ...base,
      id: 'cycle-range-before',
      startedAt: new Date('2026-08-14T09:00:00.000Z'),
      inputSummary: {
        ...base.inputSummary,
        dataAsOf: new Date('2026-08-12T00:00:00.000Z'),
      },
    });
    await ctx.repos.workflowRun.save({
      ...base,
      id: 'cycle-range-inside',
      startedAt: new Date('2026-08-14T09:00:01.000Z'),
      inputSummary: {
        ...base.inputSummary,
        dataAsOf: new Date('2026-08-14T00:00:00.000Z'),
      },
    });

    const result = await getStrategyReliabilitySummaryTool.execute(
      {
        strategyId: 'strategy-range',
        since: new Date('2026-08-13T00:00:00.000Z'),
        until: new Date('2026-08-14T23:59:59.999Z'),
        targetTradingDays: 1,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      runCount: 1,
      tradingDays: 1,
      tradingDayKeys: ['2026-08-14'],
      historicalRunCount: 0,
      gate: { ready: true, blockers: [] },
    });
  });
});
