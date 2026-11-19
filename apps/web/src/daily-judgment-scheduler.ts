import {
  dateInShanghai,
  isHoliday,
  isWeekend,
  type ToolContext,
  type ToolResult,
} from '@luoome/core';
import { type DailyAdviceOutput, dailyAdviceWorkflow } from '@luoome/workflows';

export const DAILY_JUDGMENT_SCHEDULER_INTERVAL_MS = 5 * 60_000;
/** 盘后 17:30 出当日判断：17:00 dump 增量已落库，留 30 分钟给行情同步。 */
export const DAILY_JUDGMENT_HOUR_SHANGHAI = 17;
export const DAILY_JUDGMENT_MINUTE_SHANGHAI = 30;

export interface DailyJudgmentSchedulerHandle {
  readonly tick: () => Promise<void>;
  readonly stop: () => void;
}

export interface StartDailyJudgmentSchedulerOptions {
  readonly intervalMs?: number;
  readonly startImmediately?: boolean;
  readonly run?: (tradingDay: string) => Promise<ToolResult<DailyAdviceOutput>>;
}

const shanghaiParts = (date: Date): { hour: number; minute: number } => {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1_000);
  return { hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes() };
};

/** 当日判断的触发窗口：交易日 17:30 之后返回交易日 key，否则 null。 */
export const dueDailyJudgmentTradingDay = (
  now: Date,
  hour = DAILY_JUDGMENT_HOUR_SHANGHAI,
  minute = DAILY_JUDGMENT_MINUTE_SHANGHAI,
): string | null => {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`当日判断小时必须为 0..23: ${hour}`);
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error(`当日判断分钟必须为 0..59: ${minute}`);
  }
  if (isWeekend(now) || isHoliday(now)) return null;
  const parts = shanghaiParts(now);
  if (parts.hour < hour || (parts.hour === hour && parts.minute < minute)) return null;
  return dateInShanghai(now);
};

/**
 * 每交易日 17:30 跑一次 `daily-advice`（持仓 + 候选池 → 今日不动/今日可动）。
 *
 * 与盘后同步同一模式：进程内按交易日去重，重启后重跑一次（analyze_stock 幂等入库）。
 */
export const startDailyJudgmentScheduler = (
  ctx: ToolContext,
  options: StartDailyJudgmentSchedulerOptions = {},
): DailyJudgmentSchedulerHandle => {
  const intervalMs = options.intervalMs ?? DAILY_JUDGMENT_SCHEDULER_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`当日判断调度间隔必须为正数: ${intervalMs}`);
  }
  const run =
    options.run ??
    ((tradingDay: string) =>
      dailyAdviceWorkflow.run(
        {},
        { ...ctx, clock: () => new Date(`${tradingDay}T17:30:00+08:00`) },
      ));
  let stopped = false;
  let running = false;
  let lastAttemptedTradingDay: string | null = null;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    const tradingDay = dueDailyJudgmentTradingDay(ctx.clock());
    if (tradingDay === null || tradingDay === lastAttemptedTradingDay) return;
    running = true;
    lastAttemptedTradingDay = tradingDay;
    try {
      const result = await run(tradingDay);
      if (!result.ok) {
        ctx.logger.error('当日判断调度失败', { error: result.error });
        return;
      }
      ctx.logger.info('当日判断调度完成', {
        tradingDay,
        judgment: result.data.judgment.action,
        total: result.data.summary.total,
      });
    } catch (error) {
      ctx.logger.error('当日判断调度异常', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  if (options.startImmediately !== false) void tick();

  return {
    tick,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
};
