import { describe, expect, it } from 'bun:test';
import type { MarketSnapshotBatch } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';

import {
  isMarketBatchSession,
  type StartMarketBatchSchedulerOptions,
  startMarketBatchScheduler,
} from './market-batch-scheduler.js';

const shanghai = (time: string): Date => new Date(`2026-09-28T${time}+08:00`);

const batch: MarketSnapshotBatch = {
  id: 'CN_A_SHARES_SH_SZ|2026-09-28T02:15:00.000Z',
  coverage: 'CN_A_SHARES_SH_SZ',
  tradingDate: '2026-09-28',
  sampledAt: new Date('2026-09-28T02:15:00.000Z'),
  source: 'market-day-fixture',
  fetchedAt: new Date('2026-09-28T02:16:00.000Z'),
  completeness: {
    expectedCount: 1,
    receivedCount: 1,
    missingCount: 0,
    duplicateCount: 0,
    complete: true,
  },
  gaps: [],
  items: [
    {
      id: '600519.SH',
      code: '600519',
      exchange: 'SH',
      name: '贵州茅台',
      close: 1500,
      amount: 3_000_000_000,
    },
  ],
};

const start = async (
  now: () => Date,
  options: StartMarketBatchSchedulerOptions = {},
): Promise<{
  readonly handle: ReturnType<typeof startMarketBatchScheduler>;
  calls: () => number;
}> => {
  const ctx = await buildTestContext({ clock: now });
  let calls = 0;
  const handle = startMarketBatchScheduler(ctx, {
    startImmediately: false,
    intervalMs: 60_000,
    ...options,
    ...(options.collect === undefined
      ? {
          collect: async () => {
            calls += 1;
            return { ok: true as const, data: { created: true, batch, warnings: [] } };
          },
        }
      : {}),
  });
  return { handle, calls: () => calls };
};

describe('盘中全市场批次调度', () => {
  it('只在交易日连续竞价时段运行', () => {
    const checks: ReadonlyArray<readonly [string, boolean]> = [
      ['09:29:59', false],
      ['09:30:00', true],
      ['11:29:59', true],
      ['11:30:00', false],
      ['13:00:00', true],
      ['14:59:59', true],
      ['15:00:00', false],
    ];
    for (const [time, expected] of checks) {
      expect(isMarketBatchSession(shanghai(time)), time).toBe(expected);
    }
  });

  it('未显式开启外部访问时不启动定时采集', async () => {
    const { handle, calls } = await start(() => shanghai('10:00:00'), { enabled: false });
    try {
      await handle.tick();
      expect(calls()).toBe(0);
    } finally {
      handle.stop();
    }
  });

  it('交易时段 tick 采集一次，午休与闭市跳过', async () => {
    let now = shanghai('10:00:00');
    const { handle, calls } = await start(() => now, { enabled: true });
    try {
      await handle.tick();
      expect(calls()).toBe(1);
      now = shanghai('11:45:00');
      await handle.tick();
      expect(calls()).toBe(1);
      now = shanghai('13:05:00');
      await handle.tick();
      expect(calls()).toBe(2);
      now = shanghai('15:00:00');
      await handle.tick();
      expect(calls()).toBe(2);
    } finally {
      handle.stop();
    }
  });

  it('stop 后不再采集', async () => {
    let now = shanghai('10:00:00');
    const { handle, calls } = await start(() => now, { enabled: true });
    await handle.tick();
    handle.stop();
    now = shanghai('10:30:00');
    await handle.tick();
    expect(calls()).toBe(1);
  });
});
