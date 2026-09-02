import { describe, expect, it } from 'bun:test';
import { buildTestContext } from '@luoome/tools/testing';
import type { StrategyAutonomyWeeklyOutputT } from '@luoome/workflows';

import {
  isStrategyAutonomyDueDay,
  startOfWeekShanghai,
  startStrategyAutonomyScheduler,
  strategyAutonomyWeeklyRunId,
} from './strategy-autonomy-scheduler.js';

const emptyOutput = (): StrategyAutonomyWeeklyOutputT => ({
  evaluated: 0,
  paused: 0,
  failed: 0,
  items: [],
  archive: { evaluated: 0, archived: 0, failed: 0, items: [] },
  proposals: { evaluated: 0, validating: 0, skipped: 0, failed: 0, items: [] },
  validation: { evaluated: 0, advanced: 0, incomplete: 0, failed: 0, items: [] },
  promotion: { evaluated: 0, published: 0, blocked: 0, retry: 0, pending: 0, failed: 0, items: [] },
});

const SUNDAY = new Date('2026-08-30T02:00:00.000Z'); // Asia/Shanghai 2026-08-30 周日
const MONDAY = new Date('2026-08-31T02:00:00.000Z'); // Asia/Shanghai 2026-08-31 周一

describe('strategy autonomy scheduler', () => {
  it('只在周日（Asia/Shanghai）到期，周键按自然周切分', () => {
    expect(isStrategyAutonomyDueDay(SUNDAY)).toBe(true);
    expect(isStrategyAutonomyDueDay(new Date('2026-08-29T02:00:00.000Z'))).toBe(false);
    expect(isStrategyAutonomyDueDay(MONDAY)).toBe(false);
    expect(startOfWeekShanghai(SUNDAY).toISOString()).toBe('2026-08-23T16:00:00.000Z');
    expect(strategyAutonomyWeeklyRunId(SUNDAY)).toBe('strategy-autonomy-weekly:2026-08-23');
    expect(strategyAutonomyWeeklyRunId(MONDAY)).toBe('strategy-autonomy-weekly:2026-08-30');
  });

  it('非到期日不运行', async () => {
    const ctx = await buildTestContext({ clock: () => MONDAY });
    let calls = 0;
    const scheduler = startStrategyAutonomyScheduler(ctx, {
      intervalMs: 60_000,
      startImmediately: false,
      run: async () => {
        calls += 1;
        return { ok: true, data: emptyOutput() };
      },
    });
    await scheduler.tick();
    expect(calls).toBe(0);
    scheduler.stop();
  });

  it('同一自然周只跑一次；重挂调度器（模拟重启）仍按持久事实跳过', async () => {
    const ctx = await buildTestContext({ clock: () => SUNDAY });
    let calls = 0;
    const run = async () => {
      calls += 1;
      return { ok: true as const, data: emptyOutput() };
    };
    const first = startStrategyAutonomyScheduler(ctx, {
      intervalMs: 60_000,
      startImmediately: false,
      run,
    });
    await first.tick();
    await first.tick();
    expect(calls).toBe(1);
    const recorded = await ctx.repos.workflowRun.findById('strategy-autonomy-weekly:2026-08-23');
    expect(recorded?.status).toBe('succeeded');
    first.stop();

    const restarted = startStrategyAutonomyScheduler(ctx, {
      intervalMs: 60_000,
      startImmediately: false,
      run,
    });
    await restarted.tick();
    expect(calls).toBe(1);
    restarted.stop();
  });

  it('失败的运行允许同周重试，成功后被覆盖为终态', async () => {
    const ctx = await buildTestContext({ clock: () => SUNDAY });
    let calls = 0;
    const scheduler = startStrategyAutonomyScheduler(ctx, {
      intervalMs: 60_000,
      startImmediately: false,
      run: async () => {
        calls += 1;
        return calls === 1
          ? { ok: false as const, error: { kind: 'internal' as const, cause: 'boom' } }
          : { ok: true as const, data: emptyOutput() };
      },
    });
    await scheduler.tick();
    expect(
      (await ctx.repos.workflowRun.findById('strategy-autonomy-weekly:2026-08-23'))?.status,
    ).toBe('failed');
    await scheduler.tick();
    expect(calls).toBe(2);
    expect(
      (await ctx.repos.workflowRun.findById('strategy-autonomy-weekly:2026-08-23'))?.status,
    ).toBe('succeeded');
    scheduler.stop();
  });

  it('上一轮未结束时不会重叠执行', async () => {
    const ctx = await buildTestContext({ clock: () => SUNDAY });
    let calls = 0;
    let finish: (() => void) | undefined;
    const scheduler = startStrategyAutonomyScheduler(ctx, {
      intervalMs: 60_000,
      startImmediately: false,
      run: () => {
        calls += 1;
        return new Promise((resolve) => {
          finish = () => resolve({ ok: true, data: emptyOutput() });
        });
      },
    });
    const first = scheduler.tick();
    // 让第一个 tick 越过 dedupe 查询进入 run（running 标记置位后仍有 repo await）
    await new Promise((resolve) => setTimeout(resolve, 0));
    await scheduler.tick();
    expect(calls).toBe(1);
    finish?.();
    await first;
    scheduler.stop();
  });
});
