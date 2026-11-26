import {
  dateInShanghai,
  isHoliday,
  isWeekend,
  type ThemeLibraryAutoRun,
  type ToolContext,
  type ToolResult,
} from '@luoome/core';
import { runThemeLibraryAutoMaintenanceTool } from '@luoome/tools';

export const THEME_LIBRARY_AUTO_SCHEDULER_INTERVAL_MS = 5 * 60_000;
/** A 股 15:00 收盘：此后当日封板与涨停原因为终值，可以跑自动维护。 */
export const THEME_LIBRARY_AUTO_HOUR_SHANGHAI = 15;
/** 上游涨停池常滞后发布：同一交易日最多重试 6 次（间隔 5 分钟）后停手，次日再来。 */
export const THEME_LIBRARY_AUTO_MAX_ATTEMPTS_PER_DAY = 6;

export interface ThemeLibraryAutoSchedulerHandle {
  readonly tick: () => Promise<void>;
  readonly stop: () => void;
}

export interface StartThemeLibraryAutoSchedulerOptions {
  readonly intervalMs?: number;
  readonly startImmediately?: boolean;
  readonly closeHourShanghai?: number;
  readonly maxAttemptsPerDay?: number;
  readonly run?: (tradingDay: string) => Promise<ToolResult<ThemeLibraryAutoRun>>;
}

const shanghaiHour = (date: Date): number =>
  new Date(date.getTime() + 8 * 60 * 60 * 1_000).getUTCHours();

/** 收盘后的交易日 key；非交易日或未到收盘返回 null。 */
export const dueThemeLibraryAutoTradingDay = (
  now: Date,
  closeHourShanghai = THEME_LIBRARY_AUTO_HOUR_SHANGHAI,
): string | null => {
  if (!Number.isInteger(closeHourShanghai) || closeHourShanghai < 0 || closeHourShanghai > 23) {
    throw new Error(`题材库自动维护小时必须为 0..23: ${closeHourShanghai}`);
  }
  if (shanghaiHour(now) < closeHourShanghai || isWeekend(now) || isHoliday(now)) return null;
  return dateInShanghai(now);
};

/**
 * 每个交易日盘后跑一次系统题材库自动维护（独立于其它盘后任务）。
 *
 * - 只在管理页显式启用后运行；未启用时每轮只看开关，不取数、不写库；
 * - 数据不完整 / 上游滞后导致的 skipped、failed 允许重试（最多 maxAttemptsPerDay 次）；
 *   已成功的交易日在 repository 侧是终态，重跑直接返回原结果，不重复写成分；
 * - 进程重启后按 repository 状态重新判断，不重复执行已成功的交易日。
 */
export const startThemeLibraryAutoScheduler = (
  ctx: ToolContext,
  options: StartThemeLibraryAutoSchedulerOptions = {},
): ThemeLibraryAutoSchedulerHandle => {
  const intervalMs = options.intervalMs ?? THEME_LIBRARY_AUTO_SCHEDULER_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`题材库自动维护调度间隔必须为正数: ${intervalMs}`);
  }
  const maxAttempts = options.maxAttemptsPerDay ?? THEME_LIBRARY_AUTO_MAX_ATTEMPTS_PER_DAY;
  const run =
    options.run ??
    ((tradingDay: string) =>
      runThemeLibraryAutoMaintenanceTool.execute({ tradingDate: tradingDay }, ctx));
  let stopped = false;
  let running = false;
  const attemptsByDay = new Map<string, number>();

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    const settings = await ctx.repos.themeLibrary.getAutoSettings();
    if (!settings.enabled) return;
    const tradingDay = dueThemeLibraryAutoTradingDay(ctx.clock(), options.closeHourShanghai);
    if (tradingDay === null) return;
    const attempts = attemptsByDay.get(tradingDay) ?? 0;
    if (attempts >= maxAttempts) return;
    running = true;
    try {
      const consumed = attemptsByDay.get(tradingDay) ?? 0;
      attemptsByDay.set(tradingDay, consumed + 1);
      const result = await run(tradingDay);
      if (!result.ok) {
        ctx.logger.error('题材库自动维护调度失败', { tradingDay, error: result.error });
        return;
      }
      ctx.logger.info('题材库自动维护调度完成', {
        tradingDay,
        status: result.data.status,
        createdThemes: result.data.createdThemes,
        createdMembers: result.data.createdMembers,
        pendingCount: result.data.pendingCount,
      });
      if (result.data.status === 'succeeded') attemptsByDay.set(tradingDay, maxAttempts);
    } catch (error) {
      ctx.logger.error('题材库自动维护调度异常', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref();
  if (options.startImmediately === true) void tick();

  return {
    tick,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
};
