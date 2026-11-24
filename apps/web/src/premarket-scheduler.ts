import {
  dateInShanghai,
  isHoliday,
  isWeekend,
  type ToolContext,
  type ToolResult,
} from '@luoome/core';
import { type DailyStockBriefsOutput, dailyStockBriefsWorkflow } from '@luoome/workflows';

export const PREMARKET_SCHEDULER_INTERVAL_MS = 5 * 60_000;
/** 交易日 08:45 出盘前研究名单：开盘前 45 分钟，隔夜新闻与昨日事实已可拉取。 */
export const PREMARKET_HOUR_SHANGHAI = 8;
export const PREMARKET_MINUTE_SHANGHAI = 45;

export interface PremarketSchedulerHandle {
  readonly tick: () => Promise<void>;
  readonly stop: () => void;
}

export interface StartPremarketSchedulerOptions {
  readonly intervalMs?: number;
  readonly startImmediately?: boolean;
  readonly run?: (tradingDay: string) => Promise<ToolResult<DailyStockBriefsOutput>>;
}

const shanghaiParts = (date: Date): { hour: number; minute: number } => {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1_000);
  return { hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes() };
};

/** 盘前批次的触发窗口：交易日 08:45 之后返回交易日 key，否则 null。 */
export const duePremarketTradingDay = (
  now: Date,
  hour = PREMARKET_HOUR_SHANGHAI,
  minute = PREMARKET_MINUTE_SHANGHAI,
): string | null => {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`盘前调度小时必须为 0..23: ${hour}`);
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error(`盘前调度分钟必须为 0..59: ${minute}`);
  }
  if (isWeekend(now) || isHoliday(now)) return null;
  const parts = shanghaiParts(now);
  if (parts.hour < hour || (parts.hour === hour && parts.minute < minute)) return null;
  return dateInShanghai(now);
};

/**
 * 盘前只出研究名单：`phase='premarket'` 走事实包 + 规则预筛，0 次 LLM、不写 advices（design §9.1）。
 * 经 `daily-stock-briefs` 编排以保留 workflow 审计行。
 */
const runScheduledPremarket = async (
  ctx: ToolContext,
  tradingDay: string,
): Promise<ToolResult<DailyStockBriefsOutput>> => {
  const scheduledCtx: ToolContext = {
    ...ctx,
    clock: () => new Date(`${tradingDay}T08:45:00+08:00`),
  };
  return dailyStockBriefsWorkflow.run(
    { mode: 'scheduled', phase: 'premarket', tradingDate: tradingDay },
    scheduledCtx,
  );
};

/**
 * 每交易日 08:45 跑一次盘前批次：只产研究名单与隔夜新闻，不调用 AI、不写建议。
 *
 * 与盘后 / 当日判断同一模式：进程内按交易日去重，重启后重跑一次（同日同阶段写库幂等）。
 */
export const startPremarketScheduler = (
  ctx: ToolContext,
  options: StartPremarketSchedulerOptions = {},
): PremarketSchedulerHandle => {
  const intervalMs = options.intervalMs ?? PREMARKET_SCHEDULER_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`盘前调度间隔必须为正数: ${intervalMs}`);
  }
  const run = options.run ?? ((tradingDay: string) => runScheduledPremarket(ctx, tradingDay));
  let stopped = false;
  let running = false;
  let lastAttemptedTradingDay: string | null = null;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    const tradingDay = duePremarketTradingDay(ctx.clock());
    if (tradingDay === null || tradingDay === lastAttemptedTradingDay) return;
    running = true;
    lastAttemptedTradingDay = tradingDay;
    try {
      const result = await run(tradingDay);
      if (!result.ok) {
        ctx.logger.error('盘前研究名单调度失败', { error: result.error });
        return;
      }
      ctx.logger.info('盘前研究名单调度完成', {
        tradingDay,
        workflowRunId: result.data.workflowRunId,
        coverage: result.data.coverage,
        llmHttpCalls: result.data.briefs.summary.llmHttpCalls,
        ruleOnlyBriefs: result.data.briefs.summary.ruleOnlyBriefs,
      });
    } catch (error) {
      ctx.logger.error('盘前研究名单调度异常', {
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
