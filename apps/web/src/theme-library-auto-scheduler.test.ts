import type { ThemeLibraryAutoRun, ToolContext } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import {
  dueThemeLibraryAutoTradingDay,
  startThemeLibraryAutoScheduler,
} from './theme-library-auto-scheduler.js';

const run = (overrides: Partial<ThemeLibraryAutoRun> = {}): ThemeLibraryAutoRun => ({
  tradingDay: '2026-11-26',
  source: 'fuyao-limit-up-market',
  status: 'succeeded',
  attempt: 1,
  startedAt: new Date('2026-11-26T15:05:00+08:00'),
  finishedAt: new Date('2026-11-26T15:05:00+08:00'),
  effectiveFrom: new Date('2026-11-26T15:00:00+08:00'),
  appliedAt: new Date('2026-11-26T15:05:00+08:00'),
  createdThemes: 1,
  createdMembers: 2,
  skippedMembers: 0,
  poolCount: 10,
  pendingCount: 0,
  plan: null,
  pending: [],
  skipReason: null,
  errorKind: null,
  errorMessage: null,
  ...overrides,
});

const fakeCtx = (input: { clock: () => Date; enabled: boolean }) =>
  ({
    clock: input.clock,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    repos: {
      themeLibrary: {
        getAutoSettings: async () => ({ enabled: input.enabled, updatedAt: null }),
      },
    },
  }) as unknown as ToolContext;

describe('dueThemeLibraryAutoTradingDay', () => {
  it('收盘前不触发，收盘后返回交易日 key', () => {
    // 2026-11-26 14:59 北京 = 06:59 UTC
    expect(dueThemeLibraryAutoTradingDay(new Date('2026-11-26T06:59:00.000Z'))).toBeNull();
    expect(dueThemeLibraryAutoTradingDay(new Date('2026-11-26T07:05:00.000Z'))).toBe('2026-11-26');
  });

  it('周末与节假日不触发', () => {
    expect(dueThemeLibraryAutoTradingDay(new Date('2026-11-28T08:05:00.000Z'))).toBeNull();
    expect(dueThemeLibraryAutoTradingDay(new Date('2026-10-01T08:05:00.000Z'))).toBeNull();
  });
});

describe('startThemeLibraryAutoScheduler', () => {
  it('未启用时只看开关，不取数也不跑任务', async () => {
    const calls: string[] = [];
    const scheduler = startThemeLibraryAutoScheduler(
      fakeCtx({ clock: () => new Date('2026-11-26T08:05:00.000Z'), enabled: false }),
      {
        intervalMs: 60_000,
        run: async (tradingDay) => {
          calls.push(tradingDay);
          return { ok: true, data: run() };
        },
      },
    );
    await scheduler.tick();
    scheduler.stop();
    expect(calls).toEqual([]);
  });

  it('启用后每个交易日只跑一次', async () => {
    const calls: string[] = [];
    const scheduler = startThemeLibraryAutoScheduler(
      fakeCtx({ clock: () => new Date('2026-11-26T08:05:00.000Z'), enabled: true }),
      {
        intervalMs: 60_000,
        run: async (tradingDay) => {
          calls.push(tradingDay);
          return { ok: true, data: run() };
        },
      },
    );
    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();
    scheduler.stop();
    expect(calls).toEqual(['2026-11-26']);
  });

  it('数据不完整 / 失败时在同一交易日内重试，达到上限后停手', async () => {
    const calls: string[] = [];
    const scheduler = startThemeLibraryAutoScheduler(
      fakeCtx({ clock: () => new Date('2026-11-26T08:05:00.000Z'), enabled: true }),
      {
        intervalMs: 60_000,
        maxAttemptsPerDay: 3,
        run: async (tradingDay) => {
          calls.push(tradingDay);
          return { ok: true, data: run({ status: 'skipped', skipReason: 'empty_pool' }) };
        },
      },
    );
    for (let index = 0; index < 6; index += 1) await scheduler.tick();
    scheduler.stop();
    expect(calls).toHaveLength(3);
  });

  it('成功后不再重试，停止后 tick 不再执行', async () => {
    const calls: string[] = [];
    const scheduler = startThemeLibraryAutoScheduler(
      fakeCtx({ clock: () => new Date('2026-11-26T08:05:00.000Z'), enabled: true }),
      {
        intervalMs: 60_000,
        run: async (tradingDay) => {
          calls.push(tradingDay);
          return { ok: true, data: run() };
        },
      },
    );
    await scheduler.tick();
    await scheduler.tick();
    scheduler.stop();
    await scheduler.tick();
    expect(calls).toEqual(['2026-11-26']);
  });

  it('工具返回错误时记录失败但不抛出', async () => {
    const scheduler = startThemeLibraryAutoScheduler(
      fakeCtx({ clock: () => new Date('2026-11-26T08:05:00.000Z'), enabled: true }),
      {
        intervalMs: 60_000,
        run: async () => ({
          ok: false as const,
          error: {
            kind: 'adapter_error' as const,
            adapter: 'limit-up-market',
            cause: 'x',
            recoverable: true,
          },
        }),
      },
    );
    await expect(scheduler.tick()).resolves.toBeUndefined();
    scheduler.stop();
  });
});
