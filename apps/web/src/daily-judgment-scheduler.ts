import {
  dateInShanghai,
  isHoliday,
  isWeekend,
  type ToolContext,
  type ToolResult,
} from '@luoome/core';
import {
  type DailyAdviceOutput,
  dailyAdviceWorkflow,
  dailyStockBriefsWorkflow,
} from '@luoome/workflows';

export const DAILY_JUDGMENT_SCHEDULER_INTERVAL_MS = 5 * 60_000;
/** 盘后 17:30 出当日判断：17:00 dump 增量已落库，留 30 分钟给行情同步。 */
export const DAILY_JUDGMENT_HOUR_SHANGHAI = 17;
export const DAILY_JUDGMENT_MINUTE_SHANGHAI = 30;

/**
 * 回退开关：true 时 17:30 只跑旧 `daily-advice`（内部逐只 analyze_stock），不再跑 briefs。
 * 默认新路径（briefs → daily-advice briefsOnly）；兼容一个版本周期后随旧分支一起删除。
 */
export const DAILY_JUDGMENT_LEGACY_ENV = 'LUOOME_DAILY_JUDGMENT_LEGACY';

export const readDailyJudgmentLegacy = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env[DAILY_JUDGMENT_LEGACY_ENV] === 'true';

export interface DailyJudgmentSchedulerHandle {
  readonly tick: () => Promise<void>;
  readonly stop: () => void;
}

export interface StartDailyJudgmentSchedulerOptions {
  readonly intervalMs?: number;
  readonly startImmediately?: boolean;
  readonly run?: (tradingDay: string) => Promise<ToolResult<DailyAdviceOutput>>;
  /** 显式覆盖回退开关（测试用）；缺省读 `LUOOME_DAILY_JUDGMENT_LEGACY`。 */
  readonly legacy?: boolean;
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

/** 17:30 默认先跑 `daily-stock-briefs`，再用 `daily-advice(briefsOnly)` 从当日 brief 派生判断。 */
const runScheduledJudgment = async (
  ctx: ToolContext,
  tradingDay: string,
  legacy: boolean,
): Promise<ToolResult<DailyAdviceOutput>> => {
  const scheduledCtx: ToolContext = {
    ...ctx,
    clock: () => new Date(`${tradingDay}T17:30:00+08:00`),
  };
  if (legacy) {
    return dailyAdviceWorkflow.run({ mode: 'scheduled', briefsOnly: false }, scheduledCtx);
  }
  const briefs = await dailyStockBriefsWorkflow.run(
    { mode: 'scheduled', phase: 'post-market', tradingDate: tradingDay },
    scheduledCtx,
  );
  if (briefs.ok) {
    ctx.logger.info('当日判断调度：个股观察批次完成', {
      tradingDay,
      workflowRunId: briefs.data.workflowRunId,
      coverage: briefs.data.coverage,
      budget: briefs.data.budget,
      llmHttpCalls: briefs.data.briefs.summary.llmHttpCalls,
    });
  } else {
    // 不回退到 analyze_stock：用当日已有观察（可能是「今日不动」/部分 brief）继续出结论。
    ctx.logger.error('当日判断调度：个股观察批次失败，继续用当日已有观察派生结论', {
      tradingDay,
      error: briefs.error,
    });
  }
  return dailyAdviceWorkflow.run({ mode: 'scheduled', briefsOnly: true }, scheduledCtx);
};

/**
 * 每交易日 17:30 跑一次当日判断：先 `daily-stock-briefs`（唯一 LLM 入口），
 * 再 `daily-advice(briefsOnly)` 从当日 brief 派生「今日不动/今日可动」。
 * `LUOOME_DAILY_JUDGMENT_LEGACY=true` 可回退到旧的 daily-advice 生成路径。
 *
 * 与盘后同步同一模式：进程内按交易日去重，重启后重跑一次（brief/advice 幂等入库）。
 */
export const startDailyJudgmentScheduler = (
  ctx: ToolContext,
  options: StartDailyJudgmentSchedulerOptions = {},
): DailyJudgmentSchedulerHandle => {
  const intervalMs = options.intervalMs ?? DAILY_JUDGMENT_SCHEDULER_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`当日判断调度间隔必须为正数: ${intervalMs}`);
  }
  const legacy = options.legacy ?? readDailyJudgmentLegacy();
  const run =
    options.run ?? ((tradingDay: string) => runScheduledJudgment(ctx, tradingDay, legacy));
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
