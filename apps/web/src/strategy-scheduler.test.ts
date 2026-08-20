import { describe, expect, it } from 'bun:test';
import { buildTestContext } from '@luoome/tools/testing';
import type { RunStrategySchedulesOutputT } from '@luoome/workflows';

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
});
