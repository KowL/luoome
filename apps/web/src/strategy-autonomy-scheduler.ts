import type { ToolContext, ToolResult, WorkflowRun } from '@luoome/core';
import {
  type StrategyAutonomyWeeklyOutputT,
  strategyAutonomyWeeklyWorkflow,
} from '@luoome/workflows';

export const STRATEGY_AUTONOMY_SCHEDULER_INTERVAL_MS = 30 * 60_000;

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Asia/Shanghai 的自然日（weekday：0=周日）。 */
const shanghaiDate = (now: Date): Date => new Date(now.getTime() + SHANGHAI_OFFSET_MS);

/** 到期日：周日（A 股一周行情已完整，且周日永不落在节假日调休的交易日上）。 */
export const isStrategyAutonomyDueDay = (now: Date): boolean => shanghaiDate(now).getUTCDay() === 0;

/** Asia/Shanghai 自然周周一 00:00 对应的 UTC Date（周判重的持久事实键）。 */
export const startOfWeekShanghai = (now: Date): Date => {
  const local = shanghaiDate(now);
  const sinceMonday = (local.getUTCDay() + 6) % 7;
  const mondayLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return new Date(mondayLocal - sinceMonday * 86_400_000 - SHANGHAI_OFFSET_MS);
};

export const strategyAutonomyWeeklyRunId = (now: Date): string =>
  `strategy-autonomy-weekly:${startOfWeekShanghai(now).toISOString().slice(0, 10)}`;

export interface StrategyAutonomySchedulerHandle {
  readonly tick: () => Promise<void>;
  readonly stop: () => void;
}

export interface StartStrategyAutonomySchedulerOptions {
  readonly intervalMs?: number;
  readonly startImmediately?: boolean;
  readonly run?: () => Promise<ToolResult<StrategyAutonomyWeeklyOutputT>>;
}

/**
 * M2-S4 周度策略自治调度（docs/ddd/strategy-ai-lifecycle-detailed-design.md §3）。
 * weekly-report 没有既有周调度可挂，采用「周期 tick + 星期判断」；
 * 幂等防重不依赖内存：每周一条确定性 id 的 WorkflowRun 持久事实（save 同 id upsert），
 * 本周已有 running/succeeded/partial 记录则跳过；failed 允许重试，
 * 崩溃遗留的 running 由既有 reconcile_stale_workflow_runs 判死后重试。
 */
export const startStrategyAutonomyScheduler = (
  ctx: ToolContext,
  options: StartStrategyAutonomySchedulerOptions = {},
): StrategyAutonomySchedulerHandle => {
  const intervalMs = options.intervalMs ?? STRATEGY_AUTONOMY_SCHEDULER_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`策略自治调度间隔必须为正数: ${intervalMs}`);
  }
  const run =
    options.run ?? (() => strategyAutonomyWeeklyWorkflow.run({ mode: 'scheduled' as const }, ctx));
  let stopped = false;
  let running = false;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const now = ctx.clock();
      if (!isStrategyAutonomyDueDay(now)) return;
      const runId = strategyAutonomyWeeklyRunId(now);
      const existing = await ctx.repos.workflowRun.findById(runId);
      if (existing !== null && existing.status !== 'failed') return;
      const startedAt = ctx.clock();
      const base: WorkflowRun = {
        id: runId,
        workflowName: 'strategy-autonomy-weekly',
        mode: 'scheduled',
        status: 'running',
        startedAt,
        providerStatuses: [],
      };
      await ctx.repos.workflowRun.save(base);
      const result = await run();
      const finishedAt = ctx.clock();
      if (!result.ok) {
        await ctx.repos.workflowRun.save({
          ...base,
          status: 'failed',
          finishedAt,
          error:
            'message' in result.error ? String(result.error.message) : String(result.error.kind),
        });
        ctx.logger.error('策略自治周调度失败', { runId, error: result.error });
        return;
      }
      const failedCount =
        result.data.failed +
        result.data.proposals.failed +
        result.data.validation.failed +
        result.data.promotion.failed +
        (result.data.weeklyReport?.status === 'failed' ? 1 : 0);
      await ctx.repos.workflowRun.save({
        ...base,
        status: failedCount > 0 ? 'partial' : 'succeeded',
        finishedAt,
        outputSummary: {
          evaluated: result.data.evaluated,
          paused: result.data.paused,
          proposalsValidating: result.data.proposals.validating,
          promotionPublished: result.data.promotion.published,
          promotionBlocked: result.data.promotion.blocked,
          weeklyReport: result.data.weeklyReport?.status,
        },
      });
      ctx.logger.info('策略自治周调度完成', {
        runId,
        evaluated: result.data.evaluated,
        paused: result.data.paused,
        validating: result.data.proposals.validating,
        published: result.data.promotion.published,
        blocked: result.data.promotion.blocked,
      });
    } catch (error) {
      ctx.logger.error('策略自治周调度异常', {
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
