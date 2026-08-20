import type { ToolContext, ToolResult } from '@luoome/core';
import {
  type RunStrategySchedulesOutputT,
  type StrategyDailyCycleOutputT,
  strategyDailyCycleWorkflow,
} from '@luoome/workflows';

export const STRATEGY_SCHEDULER_INTERVAL_MS = 60_000;

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
  readonly run?: () => Promise<ToolResult<RunStrategySchedulesOutputT | StrategyDailyCycleOutputT>>;
}

/** Web/luoome start 进程内的策略调度 tick；跨进程防重仍由 StrategySchedule lease 保证。 */
export const startStrategyScheduler = (
  ctx: ToolContext,
  options: StartStrategySchedulerOptions = {},
): StrategySchedulerHandle => {
  const intervalMs = options.intervalMs ?? STRATEGY_SCHEDULER_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`策略调度间隔必须为正数: ${intervalMs}`);
  }
  const owner = options.owner ?? `luoome:${process.pid}:${globalThis.crypto.randomUUID()}`;
  const tuning = options.tuning ?? strategySchedulerTuningFromEnv();
  const run =
    options.run ?? (() => strategyDailyCycleWorkflow.run({ owner, limit: 1, ...tuning }, ctx));
  let stopped = false;
  let running = false;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await run();
      if (!result.ok) {
        ctx.logger.error('策略调度 tick 失败', { error: result.error });
        return;
      }
      if (result.data.items.length > 0) {
        const summary =
          'complete' in result.data
            ? {
                ran: result.data.complete,
                partial: result.data.partial,
                skipped: result.data.skipped,
                failed: result.data.failed,
              }
            : result.data;
        ctx.logger.info('策略调度 tick 完成', {
          ...summary,
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
