import { describe, expect, it } from 'bun:test';
import { buildTestContext } from '@luoome/tools/testing';

import {
  duePortfolioPerformanceTradingDay,
  startPortfolioPerformanceScheduler,
} from './portfolio-performance-scheduler.js';

const output = (tradingDay: string) => ({
  runId: `run-${tradingDay}`,
  status: 'succeeded' as const,
  from: tradingDay,
  to: tradingDay,
  requestedAccounts: 0,
  completedAccounts: 0,
  partialAccounts: 0,
  failedAccounts: 0,
  createdSnapshots: 0,
  reusedSnapshots: 0,
  durationMs: 0,
  items: [],
});

describe('portfolio performance scheduler', () => {
  it('只在 A 股交易日盘后返回待快照日期', () => {
    expect(duePortfolioPerformanceTradingDay(new Date('2026-08-14T07:59:00.000Z'))).toBeNull();
    expect(duePortfolioPerformanceTradingDay(new Date('2026-08-14T08:00:00.000Z'))).toBe(
      '2026-08-14',
    );
    expect(duePortfolioPerformanceTradingDay(new Date('2026-08-15T09:00:00.000Z'))).toBeNull();
  });

  it('同一进程同一交易日只运行一次，并在 stop 后停止', async () => {
    const ctx = await buildTestContext({
      clock: () => new Date('2026-08-14T08:01:00.000Z'),
    });
    let calls = 0;
    const scheduler = startPortfolioPerformanceScheduler(ctx, {
      intervalMs: 60_000,
      startImmediately: false,
      run: async (tradingDay) => {
        calls += 1;
        return { ok: true, data: output(tradingDay) };
      },
    });
    await scheduler.tick();
    await scheduler.tick();
    expect(calls).toBe(1);
    scheduler.stop();
    await scheduler.tick();
    expect(calls).toBe(1);
  });

  it('上一轮未结束时不会重叠执行', async () => {
    const ctx = await buildTestContext({
      clock: () => new Date('2026-08-14T08:01:00.000Z'),
    });
    let calls = 0;
    let finish: (() => void) | undefined;
    const scheduler = startPortfolioPerformanceScheduler(ctx, {
      intervalMs: 60_000,
      startImmediately: false,
      run: (tradingDay) => {
        calls += 1;
        return new Promise((resolve) => {
          finish = () => resolve({ ok: true, data: output(tradingDay) });
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
