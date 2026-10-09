import { describe, expect, it } from 'bun:test';
import type { ToolContext } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { type RunStrategySchedulesOutputT, strategyDailyCycleWorkflow } from '@luoome/workflows';

import { startStrategyScheduler, strategySchedulerTuningFromEnv } from './strategy-scheduler.js';

const emptyResult = (): RunStrategySchedulesOutputT => ({
  items: [],
  ran: 0,
  partial: 0,
  skipped: 0,
  failed: 0,
});

describe('strategy scheduler', () => {
  it('从环境变量读取有界的 Strategy 生产参数，并拒绝危险值', () => {
    expect(
      strategySchedulerTuningFromEnv({
        LUOOME_STRATEGY_SCHEDULE_LEASE_MINUTES: '45',
        LUOOME_STRATEGY_DATA_CONCURRENCY: '6',
        LUOOME_STRATEGY_DATA_MAX_STALENESS_TRADING_DAYS: '2',
        LUOOME_STRATEGY_DATA_MAX_RETRIES: '1',
        LUOOME_STRATEGY_DATA_REQUEST_TIMEOUT_MS: '30000',
      }),
    ).toEqual({
      leaseMinutes: 45,
      concurrency: 6,
      maxStalenessTradingDays: 2,
      maxRetries: 1,
      requestTimeoutMs: 30_000,
    });
    expect(() => strategySchedulerTuningFromEnv({ LUOOME_STRATEGY_DATA_CONCURRENCY: '0' })).toThrow(
      'LUOOME_STRATEGY_DATA_CONCURRENCY',
    );
    expect(() =>
      strategySchedulerTuningFromEnv({ LUOOME_STRATEGY_DATA_REQUEST_TIMEOUT_MS: 'unbounded' }),
    ).toThrow('LUOOME_STRATEGY_DATA_REQUEST_TIMEOUT_MS');
  });

  it('主动 tick，并在 stop 后不再运行', async () => {
    const ctx = await buildTestContext();
    let calls = 0;
    const scheduler = startStrategyScheduler(ctx, {
      intervalMs: 60_000,
      startImmediately: false,
      run: async () => {
        calls += 1;
        return { ok: true, data: emptyResult() };
      },
    });

    await scheduler.tick();
    expect(calls).toBe(1);
    scheduler.stop();
    await scheduler.tick();
    expect(calls).toBe(1);
  });

  it('上一轮未结束时不会重叠执行', async () => {
    const ctx = await buildTestContext();
    let calls = 0;
    let finish: (() => void) | undefined;
    const scheduler = startStrategyScheduler(ctx, {
      intervalMs: 60_000,
      startImmediately: false,
      run: () => {
        calls += 1;
        return new Promise((resolve) => {
          finish = () => resolve({ ok: true, data: emptyResult() });
        });
      },
    });

    const first = scheduler.tick();
    await scheduler.tick();
    expect(calls).toBe(1);
    finish?.();
    await first;
    scheduler.stop();
  });

  it('策略批次未结束时仍可独立触发收盘截止报告', async () => {
    const ctx = await buildTestContext();
    let finish: (() => void) | undefined;
    let cutoffCalls = 0;
    const scheduler = startStrategyScheduler(ctx, {
      intervalMs: 60_000,
      startImmediately: false,
      run: () =>
        new Promise((resolve) => {
          finish = () => resolve({ ok: true, data: emptyResult() });
        }),
      runCutoff: async () => {
        cutoffCalls += 1;
        return { ok: true, data: { date: '2026-08-10', created: [], failed: [] } };
      },
    });
    const active = scheduler.tick();
    await scheduler.cutoffTick();
    expect(cutoffCalls).toBe(1);
    finish?.();
    await active;
    scheduler.stop();
  });

  it('次日 tick 补投前一交易日已留存报告，并以缺失事实状态补记漏报主版', async () => {
    let now = new Date('2026-08-10T10:00:00.000Z');
    let channelFailed = true;
    const base = await buildTestContext({ clock: () => now });
    const ctx: ToolContext = {
      ...base,
      notification: {
        send: async (input) => {
          const notification = {
            id: input.id ?? 'missing-report-id',
            channel: input.channel,
            payload: input.payload,
            result: channelFailed ? ('failed' as const) : ('success' as const),
            sentAt: now,
          };
          await base.repos.notification.save(notification);
          return { notification };
        },
      },
    };
    const initial = await strategyDailyCycleWorkflow.run({}, ctx);
    expect(initial.ok).toBe(true);
    const reports = await ctx.repos.report.list({ kind: 'closing' });
    expect(reports).toHaveLength(3);
    expect(reports.every((report) => report.deliveryStatus === 'failed')).toBe(true);
    const missing = reports[0];
    if (missing === undefined) throw new Error('report fixture missing');
    await ctx.repos.report.remove(missing.id);

    now = new Date('2026-08-11T02:00:00.000Z');
    channelFailed = false;
    const scheduler = startStrategyScheduler(ctx, {
      intervalMs: 60_000,
      startImmediately: false,
      run: async () => ({ ok: true, data: emptyResult() }),
    });
    await scheduler.cutoffTick();
    scheduler.stop();

    const recovered = await ctx.repos.report.list({ kind: 'closing' });
    expect(recovered).toHaveLength(3);
    expect(recovered.some((report) => report.id === missing.id)).toBe(false);
    const gap = recovered.find(
      (report) =>
        report.scope.kind === 'account' &&
        missing.scope.kind === 'account' &&
        report.scope.accountId === missing.scope.accountId,
    );
    expect(gap?.status).toBe('partial');
    expect(gap?.title).toContain('逾期缺口补记');
    expect(gap?.sections.every((section) => section.status === 'unavailable')).toBe(true);
    expect(recovered.every((report) => report.deliveryStatus === 'sent')).toBe(true);
  });
});
