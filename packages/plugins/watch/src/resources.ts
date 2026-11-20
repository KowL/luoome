import {
  isAshareTradingSession,
  PluginExecutionDenied,
  type ToolContext,
  type ToolResult,
} from '@luoome/core';
import { listAccountsTool } from '@luoome/toolkit';
export interface WatchAccountSummary {
  readonly status: string;
  readonly errors: readonly unknown[];
}
export interface WatchResourceOperations {
  readonly watch: {
    runAccount(ctx: ToolContext, accountId: string): Promise<ToolResult<WatchAccountSummary>>;
  };
}

export const INTRADAY_PLAN_SCHEDULER_INTERVAL_MS = 60_000;

export const isIntradayPlanSession = isAshareTradingSession;

export interface IntradayPlanSchedulerHandle {
  readonly tick: () => Promise<void>;
  readonly stop: () => void;
}

export interface StartIntradayPlanSchedulerOptions {
  readonly intervalMs?: number;
  readonly startImmediately?: boolean;
  readonly dispatch?: (operation: () => Promise<void>) => Promise<void>;
  readonly runAccount?: (accountId: string) => Promise<ToolResult<WatchAccountSummary>>;
}

export const startIntradayPlanScheduler = (
  operations: WatchResourceOperations,
  context: ToolContext,
  options: StartIntradayPlanSchedulerOptions = {},
): IntradayPlanSchedulerHandle => {
  let stopped = false;
  const policy = context.executionPolicy?.bind();
  const active = () => {
    if (stopped || policy?.isEnabled('business.watch-monitoring') === false) return false;
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
      if (!active()) throw new PluginExecutionDenied('plugin:business.watch-monitoring');
    },
  };
  const intervalMs = options.intervalMs ?? INTRADAY_PLAN_SCHEDULER_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`盘中计划调度间隔必须为正数: ${intervalMs}`);
  }
  const runAccount =
    options.runAccount ?? ((accountId: string) => operations.watch.runAccount(ctx, accountId));
  let running = false;

  const runTick = async (): Promise<void> => {
    if (!active() || running || !isIntradayPlanSession(ctx.clock())) return;
    running = true;
    try {
      const listed = await listAccountsTool.execute({}, ctx);
      if (!listed.ok) {
        ctx.logger.error('盘中计划调度列出账户失败', { error: listed.error });
        return;
      }
      for (const account of listed.data.accounts) {
        if (!active() || !isIntradayPlanSession(ctx.clock())) break;
        try {
          const result = await runAccount(account.id);
          if (!result.ok || result.data.status !== 'complete') {
            ctx.logger.error('盘中计划账户监控未完成', {
              accountId: account.id,
              error: result.ok ? result.data.errors : result.error,
            });
          }
        } catch (error) {
          ctx.logger.error('盘中计划账户监控异常', {
            accountId: account.id,
            cause: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      ctx.logger.error('盘中计划调度异常', {
        cause: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
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
