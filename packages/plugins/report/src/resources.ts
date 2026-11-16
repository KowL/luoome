import { PluginExecutionDenied, type ToolContext, type ToolResult } from '@luoome/core';
export const CLOSING_REPORT_SCHEDULER_INTERVAL_MS = 60_000;
export interface ClosingReportSummary {
  readonly failed: readonly unknown[];
}
export interface ReportResourceOperations {
  readonly report: { run(ctx: ToolContext): Promise<ToolResult<ClosingReportSummary>> };
}

export const startClosingReportScheduler = (
  operations: ReportResourceOperations,
  context: ToolContext,
  options: {
    readonly intervalMs?: number;
    readonly startImmediately?: boolean;
    readonly runCutoff?: () => Promise<ToolResult<ClosingReportSummary>>;
    readonly dispatch?: (operation: () => Promise<void>) => Promise<void>;
  } = {},
): { tick(): Promise<void>; stop(): void } => {
  const intervalMs = options.intervalMs ?? CLOSING_REPORT_SCHEDULER_INTERVAL_MS;
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
  const runCutoff = options.runCutoff ?? (() => operations.report.run(ctx));
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
