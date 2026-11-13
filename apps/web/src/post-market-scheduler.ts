import {
  dateInShanghai,
  isHoliday,
  isWeekend,
  type ToolContext,
  type ToolResult,
} from '@luoome/core';
import { type PostMarketDataOutput, postMarketDataWorkflow } from '@luoome/workflows';

export const POST_MARKET_SCHEDULER_INTERVAL_MS = 5 * 60_000;
/** A 股 15:00 收盘，dump 通常收盘后发布；16:00 起视为盘后窗口。 */
export const POST_MARKET_HOUR_SHANGHAI = 16;

export interface PostMarketSchedulerHandle {
  readonly tick: () => Promise<void>;
  readonly stop: () => void;
}

export interface StartPostMarketSchedulerOptions {
  readonly intervalMs?: number;
  readonly startImmediately?: boolean;
  readonly closeHourShanghai?: number;
  readonly run?: (tradingDay: string) => Promise<ToolResult<PostMarketDataOutput>>;
}

const shanghaiHour = (date: Date): number =>
  new Date(date.getTime() + 8 * 60 * 60 * 1_000).getUTCHours();

/** 盘后窗口内的交易日 key；非交易日或未到点返回 null。 */
export const duePostMarketTradingDay = (
  now: Date,
  closeHourShanghai = POST_MARKET_HOUR_SHANGHAI,
): string | null => {
  if (!Number.isInteger(closeHourShanghai) || closeHourShanghai < 0 || closeHourShanghai > 23) {
    throw new Error(`盘后同步小时必须为 0..23: ${closeHourShanghai}`);
  }
  if (shanghaiHour(now) < closeHourShanghai || isWeekend(now) || isHoliday(now)) return null;
  return dateInShanghai(now);
};

/**
 * 每交易日盘后跑一次 `post-market-data`：股票目录 + 全市场 dump（日 K 增量 + 复权因子）。
 *
 * 与账户绩效调度同一模式：进程内按交易日去重，重启后重跑一次（导入是幂等 upsert）。
 */
export const startPostMarketScheduler = (
  ctx: ToolContext,
  options: StartPostMarketSchedulerOptions = {},
): PostMarketSchedulerHandle => {
  const intervalMs = options.intervalMs ?? POST_MARKET_SCHEDULER_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`盘后同步调度间隔必须为正数: ${intervalMs}`);
  }
  const run =
    options.run ??
    ((tradingDay: string) =>
      postMarketDataWorkflow.run(
        {},
        { ...ctx, clock: () => new Date(`${tradingDay}T16:00:00+08:00`) },
      ));
  let stopped = false;
  let running = false;
  let lastAttemptedTradingDay: string | null = null;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    const tradingDay = duePostMarketTradingDay(ctx.clock(), options.closeHourShanghai);
    if (tradingDay === null || tradingDay === lastAttemptedTradingDay) return;
    running = true;
    lastAttemptedTradingDay = tradingDay;
    try {
      const result = await run(tradingDay);
      if (!result.ok) {
        ctx.logger.error('盘后数据同步调度失败', { error: result.error });
        return;
      }
      ctx.logger.info('盘后数据同步调度完成', {
        tradingDay,
        status: result.data.status,
        bars: (result.data.dailyBars as { bars?: number }).bars,
        factors: (result.data.dailyBars as { factors?: number }).factors,
      });
    } catch (error) {
      ctx.logger.error('盘后数据同步调度异常', {
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
