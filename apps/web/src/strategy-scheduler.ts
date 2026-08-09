import type { ToolContext, ToolResult } from '@luoome/core';
import { type RunStrategySchedulesOutputT, runStrategySchedulesWorkflow } from '@luoome/workflows';

export const STRATEGY_SCHEDULER_INTERVAL_MS = 60_000;

export interface StrategySchedulerHandle {
  readonly tick: () => Promise<void>;
  readonly stop: () => void;
}

export interface StartStrategySchedulerOptions {
  readonly intervalMs?: number;
  readonly startImmediately?: boolean;
  readonly owner?: string;
  readonly run?: () => Promise<ToolResult<RunStrategySchedulesOutputT>>;
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
  const run = options.run ?? (() => runStrategySchedulesWorkflow.run({ owner }, ctx));
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
        ctx.logger.info('策略调度 tick 完成', {
          ran: result.data.ran,
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
