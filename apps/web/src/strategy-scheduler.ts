import {
  dateInShanghai,
  PluginExecutionDenied,
  type ToolContext,
  type ToolResult,
} from '@luoome/core';
import {
  type ClosingReportCutoffOutputT,
  closingReportCutoffWorkflow,
  previousTradingDay,
  type RunStrategySchedulesOutputT,
  runStrategySchedulesOperation,
} from '@luoome/workflows';

export const STRATEGY_SCHEDULER_INTERVAL_MS = 60_000;
/** 单次 tick 处理同一生产日的全部到期 Strategy（进程内互斥）。 */
export const STRATEGY_SCHEDULER_BATCH_LIMIT = 100;

export interface StrategySchedulerTuning {
  readonly leaseMinutes: number;
  readonly concurrency: number;
  readonly maxStalenessTradingDays: number;
  readonly maxRetries: number;
  readonly requestTimeoutMs: number;
}

const boundedInteger = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number => {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} 必须是 ${min}～${max} 的整数`);
  }
  return parsed;
};

export const strategySchedulerTuningFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): StrategySchedulerTuning => ({
  leaseMinutes: boundedInteger(env, 'LUOOME_STRATEGY_SCHEDULE_LEASE_MINUTES', 30, 5, 240),
  concurrency: boundedInteger(env, 'LUOOME_STRATEGY_DATA_CONCURRENCY', 8, 1, 64),
  maxStalenessTradingDays: boundedInteger(
    env,
    'LUOOME_STRATEGY_DATA_MAX_STALENESS_TRADING_DAYS',
    1,
    0,
    30,
  ),
  maxRetries: boundedInteger(env, 'LUOOME_STRATEGY_DATA_MAX_RETRIES', 2, 0, 5),
  requestTimeoutMs: boundedInteger(
    env,
    'LUOOME_STRATEGY_DATA_REQUEST_TIMEOUT_MS',
    20_000,
    500,
    120_000,
  ),
});

export interface StrategySchedulerHandle {
  readonly tick: () => Promise<void>;
  readonly stop: () => void;
}

export interface StartStrategySchedulerOptions {
  readonly intervalMs?: number;
  readonly startImmediately?: boolean;
  readonly owner?: string;
  readonly tuning?: StrategySchedulerTuning;
  readonly run?: () => Promise<ToolResult<RunStrategySchedulesOutputT>>;
  readonly dispatch?: (operation: () => Promise<void>) => Promise<void>;
  readonly runCutoff?: () => Promise<ToolResult<ClosingReportCutoffOutputT>>;
}

/** Web/luoome start 进程内的策略调度 tick；同进程防重由 workflow 内 Set 保证。 */
export const startStrategyScheduler = (
  ctx: ToolContext,
  options: StartStrategySchedulerOptions = {},
): StrategySchedulerHandle => {
  const intervalMs = options.intervalMs ?? STRATEGY_SCHEDULER_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`策略调度间隔必须为正数: ${intervalMs}`);
  }
  const tuning = options.tuning ?? strategySchedulerTuningFromEnv();
  const run =
    options.run ??
    (() =>
      runStrategySchedulesOperation.run(
        {
          limit: STRATEGY_SCHEDULER_BATCH_LIMIT,
          concurrency: tuning.concurrency,
          deferReports: true,
        },
        ctx,
      ));
  let stopped = false;
  let running = false;

  const runTick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await run();
      if (!result.ok) {
        ctx.logger.error('策略调度 tick 失败', { error: result.error });
        return;
      }
      if (result.data.items.length > 0) {
        ctx.logger.info('策略调度 tick 完成', {
          ran: result.data.ran,
          partial: result.data.partial,
          skipped: result.data.skipped,
          failed: result.data.failed,
        });
      }
    } catch (error) {
      ctx.logger.error('策略调度 tick 异常', {
        cause: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
    }
  };

  const tick = () => (options.dispatch === undefined ? runTick() : options.dispatch(runTick));
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  if (options.startImmediately !== false) {
    void tick();
  }

  return {
    tick,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
};

export const startClosingReportScheduler = (
  context: ToolContext,
  options: Pick<
    StartStrategySchedulerOptions,
    'intervalMs' | 'startImmediately' | 'runCutoff' | 'dispatch'
  > = {},
): { tick(): Promise<void>; stop(): void } => {
  const intervalMs = options.intervalMs ?? STRATEGY_SCHEDULER_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0)
    throw new Error('invalid closing report interval');
  let stopped = false;
  const policy = context.executionPolicy?.bind();
  const admission = policy?.acquire('business.report');
  const active = () => {
    if (stopped || !admission?.ok || !policy?.valid(admission.permit)) return false;
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
  const runCutoff =
    options.runCutoff ??
    (async () => {
      const priorDate = previousTradingDay(dateInShanghai(ctx.clock()));
      const recovered = await closingReportCutoffWorkflow.run({ date: priorDate }, ctx);
      if (!recovered.ok || recovered.data.failed.length > 0)
        ctx.logger.error('前一交易日收盘报告补投失败', {
          date: priorDate,
          error: recovered.ok ? recovered.data.failed : recovered.error,
        });
      ctx.executionGuard?.();
      return closingReportCutoffWorkflow.run({}, ctx);
    });
  let cutoffRunning = false;

  const runTick = async (): Promise<void> => {
    if (!active() || cutoffRunning) return;
    cutoffRunning = true;
    try {
      const result = await runCutoff();
      if (!result.ok || result.data.failed.length > 0)
        ctx.logger.error('收盘报告截止 tick 失败', {
          error: result.ok ? result.data.failed : result.error,
        });
    } catch (error) {
      ctx.logger.error('收盘报告截止 tick 异常', {
        cause: error instanceof Error ? error.message : String(error),
      });
    } finally {
      cutoffRunning = false;
    }
  };

  const tick = () => (options.dispatch === undefined ? runTick() : options.dispatch(runTick));
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
