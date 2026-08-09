import { describe, expect, it } from 'bun:test';
import { buildTestContext } from '@luoome/tools/testing';
import type { RunStrategySchedulesOutputT } from '@luoome/workflows';

import { startStrategyScheduler } from './strategy-scheduler.js';

const emptyResult = (): RunStrategySchedulesOutputT => ({
  items: [],
  ran: 0,
  skipped: 0,
  failed: 0,
});

describe('strategy scheduler', () => {
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
