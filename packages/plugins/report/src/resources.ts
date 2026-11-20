import { PluginExecutionDenied, type ToolContext, type ToolResult } from '@luoome/core';

export const WEEKLY_REPORT_SCHEDULER_INTERVAL_MS = 60_000;

/** 每周成绩单在周一开盘前生成，回顾上周一到周五的建议。 */
export const WEEKLY_REPORT_WEEKDAY = 1;
export const WEEKLY_REPORT_HOUR_SHANGHAI = 8;

export interface ReportResourceOperations {
  /** 生成每周建议成绩单；由宿主注入，失败时返回 ToolResult 错误。 */
  readonly report: { run(ctx: ToolContext): Promise<ToolResult<unknown>> };
}

const shanghaiParts = (now: Date): { weekday: number; hour: number; date: string } => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(now);
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    weekday: weekdays.indexOf(pick('weekday')),
    hour: Number(pick('hour')),
    date: `${pick('year')}-${pick('month')}-${pick('day')}`,
  };
};

/** 返回本次 tick 应生成的周期日期（上海时区的周一）；不该生成时返回 null。 */
export const dueWeeklyReportDate = (now: Date): string | null => {
  const { weekday, hour, date } = shanghaiParts(now);
  if (weekday !== WEEKLY_REPORT_WEEKDAY) return null;
  if (hour < WEEKLY_REPORT_HOUR_SHANGHAI) return null;
  return date;
};

export interface WeeklyReportSchedulerHandle {
  readonly tick: () => Promise<void>;
  readonly stop: () => void;
}

export const startWeeklyReportScheduler = (
  operations: ReportResourceOperations,
  context: ToolContext,
  options: {
    readonly intervalMs?: number;
    readonly startImmediately?: boolean;
    readonly run?: () => Promise<ToolResult<unknown>>;
    readonly dispatch?: (operation: () => Promise<void>) => Promise<void>;
  } = {},
): WeeklyReportSchedulerHandle => {
  const intervalMs = options.intervalMs ?? WEEKLY_REPORT_SCHEDULER_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0)
    throw new Error('invalid weekly report interval');
  let stopped = false;
  const policy = context.executionPolicy?.bind();
  const active = () => {
    if (stopped || policy?.isEnabled('business.report') === false) return false;
    try {
      context.executionGuard?.();
      return true;
    } catch {
      return false;
    }
  };
  const ctx: ToolContext = {
    ...context,
    ...(policy === undefined ? {} : { executionPolicy: policy }),
    executionGuard: () => {
      if (!active()) throw new PluginExecutionDenied('plugin:business.report');
    },
  };
  const dispatch: (operation: () => Promise<void>) => Promise<void> =
    options.dispatch ?? ((operation) => operation());
  const run = options.run ?? (() => operations.report.run(ctx));
  let running = false;
  let lastPeriodEnd: string | null = null;

  const runTick = async (): Promise<void> => {
    if (!active() || running) return;
    const periodEnd = dueWeeklyReportDate(ctx.clock());
    if (periodEnd === null || periodEnd === lastPeriodEnd) return;
    running = true;
    try {
      const result = await run();
      if (!result.ok) {
        ctx.logger.error('每周成绩单生成失败', { periodEnd, error: result.error });
        return;
      }
      // 成功后记住周期，进程重启后同一天也不会重复生成。
      lastPeriodEnd = periodEnd;
    } catch (error) {
      ctx.logger.error('每周成绩单生成异常', {
        cause: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void dispatch(runTick);
  }, intervalMs);
  timer.unref?.();
  if (options.startImmediately === true) void dispatch(runTick);
  return {
    tick: () => dispatch(runTick),
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
};
