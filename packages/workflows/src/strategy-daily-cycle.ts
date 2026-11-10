import {
  createStrategyDailyCycleAuditInputSummary,
  createStrategyDailyCycleAuditOutputSummary,
  dateInShanghai,
  isHoliday,
  isWeekend,
} from '@luoome/core';
import { z } from 'zod';

import { defineWorkflow, type WorkflowStep } from './define-workflow.js';

export const StrategyDailyCycleInput = z.object({
  strategyId: z.string().min(1),
  concurrency: z.number().int().min(1).max(64).default(8),
});
export type StrategyDailyCycleInputT = z.infer<typeof StrategyDailyCycleInput>;

const CycleItemSchema = z.object({
  strategyId: z.string(),
  status: z.enum(['complete', 'partial', 'skipped', 'failed']),
  phase: z.enum(['run', 'observations', 'insight', 'finish']),
  runId: z.string().optional(),
  insightProvider: z.string().optional(),
  watchlistSync: z
    .object({
      status: z.enum(['complete', 'partial', 'failed', 'skipped']),
      complete: z.number().int().nonnegative().optional(),
      partial: z.number().int().nonnegative().optional(),
      failed: z.number().int().nonnegative().optional(),
      skipped: z.number().int().nonnegative().optional(),
      reason: z.string().optional(),
      error: z.string().optional(),
    })
    .optional(),
  reason: z.string().optional(),
});
export const StrategyDailyCycleOutput = z.object({
  items: z.array(CycleItemSchema),
  complete: z.number().int().nonnegative(),
  partial: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type StrategyDailyCycleOutputT = z.infer<typeof StrategyDailyCycleOutput>;

const errorText = (error: {
  readonly kind?: unknown;
  readonly message?: unknown;
  readonly cause?: unknown;
}): string =>
  typeof error.message === 'string'
    ? error.message
    : typeof error.cause === 'string'
      ? error.cause
      : String(error.kind ?? 'unknown error');

const dayKey = (value: Date): string => dateInShanghai(value);

const runCycle: WorkflowStep = async (previous, ctx) => {
  const input = previous as StrategyDailyCycleInputT;
  const strategyResult = await ctx.tools.get_strategy.execute({ strategyId: input.strategyId });
  if (!strategyResult.ok) return strategyResult;
  const strategy = strategyResult.data.strategy;

  const workflowRunId = `workflow-strategy-daily-cycle-${globalThis.crypto.randomUUID()}`;
  const workflowStartedAt = ctx.clock();
  const auditDataAsOf = workflowStartedAt;
  const phaseTimings: Array<{
    phase: z.infer<typeof CycleItemSchema>['phase'];
    startedAt: Date;
    finishedAt?: Date;
    durationMs?: number;
  }> = [];
  let phase: z.infer<typeof CycleItemSchema>['phase'] = 'run';
  const beginPhase = (next: z.infer<typeof CycleItemSchema>['phase']): void => {
    const now = ctx.clock();
    const current = phaseTimings.at(-1);
    if (current !== undefined && current.finishedAt === undefined) {
      current.finishedAt = now;
      current.durationMs = Math.max(0, now.getTime() - current.startedAt.getTime());
    }
    phase = next;
    phaseTimings.push({ phase: next, startedAt: now });
  };
  const finishPhase = (at: Date): void => {
    const current = phaseTimings.at(-1);
    if (current !== undefined && current.finishedAt === undefined) {
      current.finishedAt = at;
      current.durationMs = Math.max(0, at.getTime() - current.startedAt.getTime());
    }
  };

  const auditInputSummary = createStrategyDailyCycleAuditInputSummary({
    strategyId: strategy.id,
    // 独立 schedule 记录已并入 Strategy；该审计字段继续记录本次调度归属键。
    scheduleId: strategy.id,
    dataAsOf: auditDataAsOf,
    requestedBy: 'scheduled',
  });
  beginPhase('run');
  const startedAudit = await ctx.tools.record_workflow_run.execute({
    run: {
      id: workflowRunId,
      workflowName: 'strategy-daily-cycle',
      mode: 'scheduled',
      status: 'running',
      startedAt: workflowStartedAt,
      inputSummary: auditInputSummary,
      providerStatuses: [],
    },
  });

  let status: z.infer<typeof CycleItemSchema>['status'] = 'complete';
  let reason: string | undefined;
  let runId: string | undefined;
  let insightProvider: string | undefined;
  let insightFacts: Record<string, unknown> | undefined;
  let watchlistSync:
    | {
        status: 'complete' | 'partial' | 'failed' | 'skipped';
        complete?: number;
        partial?: number;
        failed?: number;
        skipped?: number;
        reason?: string;
        error?: string;
      }
    | undefined;
  let publication: string | undefined;
  let runSummary: Record<string, unknown> | undefined;
  let providerStatuses: Array<{
    provider: string;
    ok: boolean;
    errorKind?: string | undefined;
    latencyMs?:
      | {
          samples: number;
          p50Ms: number;
          p95Ms: number;
          maxMs: number;
        }
      | undefined;
  }> = [];
  let universeSync:
    | {
        status: 'succeeded' | 'skipped';
        syncId: string;
        source: string;
        observedCount: number;
        observedAt?: Date;
      }
    | undefined;

  // cron 可能比产品的「每交易日一次」契约更频繁：先查已持久化的正式运行事实，
  // 同一交易日重复 tick 只审计 skipped，不重复做外部数据工作。
  const priorRuns = await ctx.tools.list_strategy_runs.execute({
    strategyId: strategy.id,
    scope: 'operational',
    limit: 500,
  });
  if (!priorRuns.ok) {
    status = 'failed';
    reason = errorText(priorRuns.error);
  } else {
    const duplicate = priorRuns.data.runs.find(
      (run) => run.mode === 'scheduled' && dayKey(run.dataAsOf) === dayKey(auditDataAsOf),
    );
    if (duplicate !== undefined) {
      status = 'skipped';
      reason = 'schedule-day-duplicate';
    }
  }

  if (status === 'complete' && (isWeekend(auditDataAsOf) || isHoliday(auditDataAsOf))) {
    status = 'skipped';
    reason = '非 A 股交易日，本次跳过并推进下一次运行';
  }

  // 运行前先把当日可见股票目录固化为 PIT snapshot。
  if (status === 'complete' && !ctx.abortSignal?.aborted) {
    const synced = await ctx.tools.sync_stock_universe.execute({
      coverage: 'CN_A_SHARES_SH_SZ',
      force: false,
    });
    if (!synced.ok) {
      status = 'failed';
      reason = errorText(synced.error);
    } else {
      universeSync = {
        status: synced.data.status === 'succeeded' ? 'succeeded' : 'skipped',
        syncId: synced.data.syncId,
        source: synced.data.source,
        observedCount: synced.data.observedCount,
        ...(synced.data.observedAt === null ? {} : { observedAt: synced.data.observedAt }),
      };
    }
  }

  if (status === 'complete' && !ctx.abortSignal?.aborted) {
    beginPhase('run');
    const run = await ctx.tools.run_strategy.execute({
      strategyId: strategy.id,
      mode: 'scheduled',
      persist: true,
      concurrency: input.concurrency,
    });
    if (!run.ok) {
      status = 'failed';
      reason = errorText(run.error);
    } else {
      runId = run.data.run.id;
      runSummary =
        run.data.run.summary !== undefined && typeof run.data.run.summary === 'object'
          ? (run.data.run.summary as Record<string, unknown>)
          : undefined;
      providerStatuses = run.data.run.providerStatuses;
      publication = run.data.run.publication?.status;
      if (run.data.run.status === 'failed') {
        status = 'failed';
        reason = run.data.run.error ?? 'StrategyRun failed';
      } else if (run.data.run.publication?.status !== 'published') {
        status = 'partial';
        reason = `StrategyRun ${run.data.run.publication?.status ?? 'without-publication'}，不创建生产建议`;
      } else {
        const synced = await ctx.tools.sync_strategy_watchlist_subscriptions.execute({
          strategyId: strategy.id,
          producerRunId: run.data.run.id,
        });
        if (!synced.ok) {
          status = 'partial';
          reason = errorText(synced.error);
          watchlistSync = { status: 'failed', error: reason };
        } else {
          watchlistSync = {
            status: synced.data.status,
            complete: synced.data.complete,
            partial: synced.data.partial,
            failed: synced.data.failed,
            skipped: synced.data.skipped,
            ...(synced.data.reason === undefined ? {} : { reason: synced.data.reason }),
          };
          if (synced.data.status === 'partial') {
            status = 'partial';
            reason = 'Strategy→Watchlist source partial sync；未根据缺失集合结束来源';
          } else if (synced.data.status === 'failed') {
            status = 'partial';
            reason = 'Strategy→Watchlist source sync failed；未改变其它来源';
          }
        }
        if (!ctx.abortSignal?.aborted) {
          beginPhase('insight');
          const insight = await ctx.tools.generate_strategy_insight.execute({
            strategyId: strategy.id,
            runId,
            windowDays: 30,
          });
          if (insight.ok) {
            insightProvider = insight.data.provider;
            insightFacts = insight.data.facts;
            if (insight.data.provider === 'facts-only') status = 'partial';
          } else {
            status = 'partial';
            reason = errorText(insight.error);
            const facts = await ctx.tools.get_strategy_insight_facts.execute({
              strategyId: strategy.id,
              windowDays: 30,
            });
            if (facts.ok) {
              insightProvider = 'facts-only';
              insightFacts = facts.data;
            }
          }
        }
      }
    }
  }

  beginPhase('finish');
  const finishedAt = ctx.clock();
  finishPhase(finishedAt);
  const auditStatus =
    status === 'failed'
      ? ('failed' as const)
      : status === 'partial'
        ? ('partial' as const)
        : ('succeeded' as const);
  const audit = await ctx.tools.record_workflow_run.execute({
    run: {
      id: workflowRunId,
      workflowName: 'strategy-daily-cycle',
      mode: 'scheduled',
      status: auditStatus,
      startedAt: workflowStartedAt,
      finishedAt,
      inputSummary: auditInputSummary,
      outputSummary: createStrategyDailyCycleAuditOutputSummary({
        status,
        phase,
        ...(runId === undefined ? {} : { runId }),
        ...(publication === undefined ? {} : { publication }),
        ...(runSummary === undefined ? {} : { summary: runSummary }),
        ...(insightProvider === undefined ? {} : { insightProvider }),
        ...(insightFacts === undefined ? {} : { insightFacts }),
        ...(watchlistSync === undefined ? {} : { watchlistSync }),
        leaseRenewals: 0,
        ...(universeSync === undefined ? {} : { universeSync }),
        phaseTimings,
      }),
      providerStatuses,
      ...(reason === undefined ? {} : { error: reason }),
    },
  });
  if (!startedAudit.ok || !audit.ok) {
    ctx.logger.warn('strategy-daily-cycle: workflow audit write failed', {
      strategyId: strategy.id,
      workflowRunId,
    });
  }
  const items: z.infer<typeof CycleItemSchema>[] = [
    {
      strategyId: strategy.id,
      status,
      phase,
      ...(runId === undefined ? {} : { runId }),
      ...(insightProvider === undefined ? {} : { insightProvider }),
      ...(watchlistSync === undefined ? {} : { watchlistSync }),
      ...(reason === undefined ? {} : { reason }),
    },
  ];

  return StrategyDailyCycleOutput.parse({
    items,
    complete: items.filter((item) => item.status === 'complete').length,
    partial: items.filter((item) => item.status === 'partial').length,
    skipped: items.filter((item) => item.status === 'skipped').length,
    failed: items.filter((item) => item.status === 'failed').length,
  });
};

export const strategyDailyCycleWorkflow = defineWorkflow<
  StrategyDailyCycleInputT,
  StrategyDailyCycleOutputT
>({
  name: 'strategy-daily-cycle',
  description: '按 run→insight→finish 编排单个 Strategy 的盘后日循环',
  input: StrategyDailyCycleInput,
  steps: [runCycle],
});
