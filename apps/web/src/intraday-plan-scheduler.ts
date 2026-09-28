import { isAshareTradingSession, type ToolContext, type ToolResult } from '@luoome/core';
import { listAccountsTool } from '@luoome/tools';
import {
  type IntradayTradingPlanWatchOutputT,
  intradayTradingPlanWatchWorkflow,
} from '@luoome/workflows';

export const INTRADAY_PLAN_SCHEDULER_INTERVAL_MS = 60_000;

export const isIntradayPlanSession = isAshareTradingSession;

export interface IntradayPlanSchedulerHandle {
  readonly tick: () => Promise<void>;
  readonly stop: () => void;
}

export interface StartIntradayPlanSchedulerOptions {
  readonly intervalMs?: number;
  readonly startImmediately?: boolean;
  readonly runAccount?: (accountId: string) => Promise<ToolResult<IntradayTradingPlanWatchOutputT>>;
}

export const startIntradayPlanScheduler = (
  ctx: ToolContext,
  options: StartIntradayPlanSchedulerOptions = {},
): IntradayPlanSchedulerHandle => {
  const intervalMs = options.intervalMs ?? INTRADAY_PLAN_SCHEDULER_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`盘中计划调度间隔必须为正数: ${intervalMs}`);
  }
  const runAccount =
    options.runAccount ??
    ((accountId: string) => intradayTradingPlanWatchWorkflow.run({ accountId }, ctx));
  let stopped = false;
  let running = false;

  const tick = async (): Promise<void> => {
    if (stopped || running || !isIntradayPlanSession(ctx.clock())) return;
    running = true;
    try {
      const listed = await listAccountsTool.execute({}, ctx);
      if (!listed.ok) {
        ctx.logger.error('盘中计划调度列出账户失败', { error: listed.error });
        return;
      }
      for (const account of listed.data.accounts) {
        if (stopped || !isIntradayPlanSession(ctx.clock())) break;
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
