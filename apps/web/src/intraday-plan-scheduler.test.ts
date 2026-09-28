import { describe, expect, it } from 'bun:test';
import { TEST_ACCOUNTS } from '@luoome/adapters/testing';
import { buildTestContext } from '@luoome/tools/testing';

import { isIntradayPlanSession, startIntradayPlanScheduler } from './intraday-plan-scheduler.js';

const shanghai = (date: string, time: string): Date => new Date(`${date}T${time}+08:00`);

describe('盘中交易计划调度', () => {
  it('只在交易日的上午和下午连续竞价时段运行', () => {
    const checks: ReadonlyArray<readonly [string, string, boolean]> = [
      ['2026-09-28', '09:29:59', false],
      ['2026-09-28', '09:30:00', true],
      ['2026-09-28', '11:29:59', true],
      ['2026-09-28', '11:30:00', false],
      ['2026-09-28', '13:00:00', true],
      ['2026-09-28', '15:00:00', false],
      ['2026-09-25', '10:00:00', false],
      ['2026-09-27', '10:00:00', false],
    ];
    for (const [date, time, expected] of checks) {
      expect(isIntradayPlanSession(shanghai(date, time))).toBe(expected);
    }
  });

  it('交易时段启动后立即检查，不等待首个定时器', async () => {
    const ctx = await buildTestContext({
      clock: () => shanghai('2026-09-28', '10:00:00'),
    });
    let entered: (() => void) | undefined;
    const firstCall = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const scheduler = startIntradayPlanScheduler(ctx, {
      intervalMs: 60_000,
      runAccount: async (accountId) => {
        entered?.();
        return {
          ok: true,
          data: {
            accountId,
            date: '2026-09-28',
            status: 'complete',
            checkedPlans: 0,
            freshQuotes: 0,
            stalePlans: 0,
            triggers: [],
            notified: 0,
            delivered: 0,
            suppressedByCooldown: 0,
            suppressedByDailyLimit: 0,
            notifyFailed: 0,
            errors: [],
          },
        };
      },
    });
    try {
      await firstCall;
    } finally {
      scheduler.stop();
    }
  });

  it('检查全部账户，阻止重叠 tick，停止后不再运行', async () => {
    let now = shanghai('2026-09-28', '09:30:00');
    const ctx = await buildTestContext({ clock: () => now });
    const seen: string[] = [];
    let firstEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let releaseFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const scheduler = startIntradayPlanScheduler(ctx, {
      startImmediately: false,
      runAccount: async (accountId) => {
        seen.push(accountId);
        if (seen.length === 1) {
          firstEntered?.();
          await firstPending;
        }
        return {
          ok: true,
          data: {
            accountId,
            date: '2026-09-28',
            status: 'complete',
            checkedPlans: 0,
            freshQuotes: 0,
            stalePlans: 0,
            triggers: [],
            notified: 0,
            delivered: 0,
            suppressedByCooldown: 0,
            suppressedByDailyLimit: 0,
            notifyFailed: 0,
            errors: [],
          },
        };
      },
    });
    try {
      const first = scheduler.tick();
      await entered;
      expect(seen).toHaveLength(1);
      expect(TEST_ACCOUNTS.map((account) => account.id).includes(seen[0] ?? '')).toBe(true);
      await scheduler.tick();
      expect(seen).toHaveLength(1);
      releaseFirst?.();
      await first;
      expect(seen.toSorted()).toEqual(TEST_ACCOUNTS.map((account) => account.id).toSorted());
      now = shanghai('2026-09-28', '11:30:00');
      await scheduler.tick();
      expect(seen).toHaveLength(TEST_ACCOUNTS.length);
      scheduler.stop();
      now = shanghai('2026-09-28', '13:00:00');
      await scheduler.tick();
      expect(seen).toHaveLength(TEST_ACCOUNTS.length);
    } finally {
      releaseFirst?.();
      scheduler.stop();
    }
  });
});
