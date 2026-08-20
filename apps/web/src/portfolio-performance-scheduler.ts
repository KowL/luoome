import {
  dateInShanghai,
  isHoliday,
  isWeekend,
  type ToolContext,
  type ToolResult,
} from '@luoome/core';
import {
  type SnapshotAccountPerformanceOutputT,
  snapshotAccountPerformanceWorkflow,
} from '@luoome/workflows';

export const PORTFOLIO_PERFORMANCE_SCHEDULER_INTERVAL_MS = 5 * 60_000;
export const PORTFOLIO_PERFORMANCE_CLOSE_HOUR_SHANGHAI = 16;

export interface PortfolioPerformanceSchedulerHandle {
  readonly tick: () => Promise<void>;
  readonly stop: () => void;
}

export interface StartPortfolioPerformanceSchedulerOptions {
  readonly intervalMs?: number;
  readonly startImmediately?: boolean;
  readonly closeHourShanghai?: number;
  readonly run?: (tradingDay: string) => Promise<ToolResult<SnapshotAccountPerformanceOutputT>>;
}

const shanghaiHour = (date: Date): number =>
  new Date(date.getTime() + 8 * 60 * 60 * 1_000).getUTCHours();

export const duePortfolioPerformanceTradingDay = (
  now: Date,
  closeHourShanghai = PORTFOLIO_PERFORMANCE_CLOSE_HOUR_SHANGHAI,
): string | null => {
  if (!Number.isInteger(closeHourShanghai) || closeHourShanghai < 0 || closeHourShanghai > 23) {
    throw new Error(`账户绩效盘后小时必须为 0..23: ${closeHourShanghai}`);
  }
  if (shanghaiHour(now) < closeHourShanghai || isWeekend(now) || isHoliday(now)) return null;
  return dateInShanghai(now);
};

export const startPortfolioPerformanceScheduler = (
  ctx: ToolContext,
  options: StartPortfolioPerformanceSchedulerOptions = {},
): PortfolioPerformanceSchedulerHandle => {
  const intervalMs = options.intervalMs ?? PORTFOLIO_PERFORMANCE_SCHEDULER_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`账户绩效调度间隔必须为正数: ${intervalMs}`);
  }
  const run =
    options.run ??
    ((tradingDay: string) =>
      snapshotAccountPerformanceWorkflow.run({ to: tradingDay, mode: 'scheduled' }, ctx));
  let stopped = false;
  let running = false;
  let lastAttemptedTradingDay: string | null = null;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    const tradingDay = duePortfolioPerformanceTradingDay(ctx.clock(), options.closeHourShanghai);
    if (tradingDay === null || tradingDay === lastAttemptedTradingDay) return;
    running = true;
    lastAttemptedTradingDay = tradingDay;
    try {
      const result = await run(tradingDay);
      if (!result.ok) {
        ctx.logger.error('账户绩效快照调度失败', { error: result.error });
        return;
      }
      ctx.logger.info('账户绩效快照调度完成', {
        tradingDay,
        status: result.data.status,
        requestedAccounts: result.data.requestedAccounts,
        completedAccounts: result.data.completedAccounts,
        partialAccounts: result.data.partialAccounts,
        failedAccounts: result.data.failedAccounts,
        createdSnapshots: result.data.createdSnapshots,
        reusedSnapshots: result.data.reusedSnapshots,
        durationMs: result.data.durationMs,
      });
    } catch (error) {
      ctx.logger.error('账户绩效快照调度异常', {
        cause: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  if (options.startImmediately !== false) void tick();

  return {
    tick,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
};
