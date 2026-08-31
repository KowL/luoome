import {
  ACTIVE_SIGNAL_OBSERVATION_HORIZONS,
  type ActiveSignalObservationHorizon,
  DEFAULT_STRATEGY_RUN_ACCEPTANCE_POLICY,
  isHoliday,
  isWeekend,
  STRATEGY_OBSERVATION_BENCHMARK_DATASET_VERSION,
  STRATEGY_OBSERVATION_BENCHMARK_STOCK_ID,
  StrategyRecommendationPreflightSummarySchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineWorkflow, type WorkflowStep } from './define-workflow.js';

export const StrategyDailyCycleInput = z.object({
  owner: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(20).default(1),
  leaseMinutes: z.number().int().min(5).max(240).default(30),
  asOf: z.coerce.date().optional(),
  concurrency: z.number().int().min(1).max(64).default(8),
  maxStalenessTradingDays: z.number().int().min(0).max(30).default(1),
  maxRetries: z.number().int().min(0).max(5).default(2),
  requestTimeoutMs: z.number().int().min(500).max(120_000).default(20_000),
});
export type StrategyDailyCycleInputT = z.infer<typeof StrategyDailyCycleInput>;

const CycleItemSchema = z.object({
  strategyId: z.string(),
  scheduleId: z.string(),
  status: z.enum(['complete', 'partial', 'skipped', 'failed']),
  phase: z.enum(['claim', 'data-prep', 'run', 'observations', 'insight', 'finish']),
  runId: z.string().optional(),
  checkpointId: z.string().optional(),
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
  adviceCount: z.number().int().nonnegative().optional(),
  notificationFailed: z.number().int().nonnegative().optional(),
  preflight: StrategyRecommendationPreflightSummarySchema.optional(),
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

const utcDayKey = (value: Date): string => value.toISOString().slice(0, 10);

const parseSnapshotDate = (value: unknown): Date | undefined => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value;
  }
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

const scheduledRunDataAsOf = (run: {
  readonly dataAsOf: Date;
  readonly inputSnapshot: unknown;
}): Date => {
  const snapshot = run.inputSnapshot;
  if (typeof snapshot !== 'object' || snapshot === null || !('dataCheckpoint' in snapshot)) {
    return run.dataAsOf;
  }
  const checkpoint = snapshot.dataCheckpoint;
  if (typeof checkpoint !== 'object' || checkpoint === null || !('dataAsOf' in checkpoint)) {
    return run.dataAsOf;
  }
  // Scheduled StrategyRun.dataAsOf is conservatively allowed to be the oldest member bar.
  // The checkpoint timestamp is the cycle's trading-day key and is therefore the correct
  // identity for preventing a second cron tick on the same day.
  return parseSnapshotDate(checkpoint.dataAsOf) ?? run.dataAsOf;
};

const runCycle: WorkflowStep = async (previous, ctx) => {
  const input = previous as StrategyDailyCycleInputT;
  const owner = input.owner ?? `strategy-daily-cycle:${globalThis.crypto.randomUUID()}`;
  const reconciled = await ctx.tools.reconcile_stale_workflow_runs.execute({
    olderThanMinutes: Math.max(30, input.leaseMinutes * 2),
    limit: 100,
  });
  if (!reconciled.ok) {
    ctx.logger.warn('strategy-daily-cycle: stale workflow reconciliation failed', {
      error: reconciled.error,
    });
  }
  const claimed = await ctx.tools.claim_due_strategy_schedules.execute({
    owner,
    limit: input.limit,
    leaseMinutes: input.leaseMinutes,
  });
  if (!claimed.ok) return claimed;
  const items: z.infer<typeof CycleItemSchema>[] = [];
  for (const claim of claimed.data.items) {
    const { schedule, lease } = claim;
    let phase: z.infer<typeof CycleItemSchema>['phase'] = 'claim';
    let status: z.infer<typeof CycleItemSchema>['status'] = 'skipped';
    let reason = claim.reason;
    let runId: string | undefined;
    let checkpointId: string | undefined;
    let insightProvider: string | undefined;
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
    let adviceCount: number | undefined;
    let notificationFailed: number | undefined;
    let preflight: z.infer<typeof StrategyRecommendationPreflightSummarySchema> | undefined;
    let leaseRenewals = 0;
    let checkpointSummary:
      | {
          status: string;
          requestedCount: number;
          availableCount: number;
          failedCount: number;
          coverageRatio: number;
          fallbackUsed: boolean;
          providers: string[];
        }
      | undefined;
    let dataPreparationPerformance: Record<string, unknown> | undefined;
    let universeSync:
      | {
          status: 'succeeded' | 'skipped';
          syncId: string;
          source: string;
          observedCount: number;
          observedAt?: Date;
        }
      | undefined;
    let observationSummary:
      | {
          created: number;
          skipped: number;
          scanned: number;
          completed: number;
          pending: number;
          baselines: {
            available: number;
            unavailable: number;
            providers: Record<string, number>;
          };
          byHorizon: Record<
            ActiveSignalObservationHorizon,
            {
              created: number;
              skipped: number;
              scanned: number;
              completed: number;
              pending: number;
            }
          >;
        }
      | undefined;
    let benchmarkSync:
      | {
          status: 'succeeded' | 'partial' | 'failed' | 'skipped';
          dataVersion: string;
          stockId: string;
          barCount?: number;
          source?: string;
          reason?: string;
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
    const phaseTimings: Array<{
      phase: z.infer<typeof CycleItemSchema>['phase'];
      startedAt: Date;
      finishedAt?: Date;
      durationMs?: number;
    }> = [];
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
    let scheduleLeaseLost = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatInFlight = false;
    const renewScheduleLease = async (): Promise<boolean> => {
      if (scheduleLeaseLost) return false;
      const renewed = await ctx.tools.renew_strategy_schedule_claim.execute({
        scheduleId: schedule.id,
        owner,
        fence: lease.fence,
        leaseMinutes: input.leaseMinutes,
      });
      if (!renewed.ok || !renewed.data.renewed) {
        scheduleLeaseLost = true;
        return false;
      }
      leaseRenewals += 1;
      return true;
    };
    const stopHeartbeat = (): void => {
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    };
    const workflowRunId = `workflow-strategy-daily-cycle-${globalThis.crypto.randomUUID()}`;
    const workflowStartedAt = ctx.clock();
    const auditDataAsOf = input.asOf ?? workflowStartedAt;
    beginPhase('claim');
    const startedAudit = await ctx.tools.record_workflow_run.execute({
      run: {
        id: workflowRunId,
        workflowName: 'strategy-daily-cycle',
        mode: 'scheduled',
        status: 'running',
        startedAt: workflowStartedAt,
        inputSummary: {
          strategyId: schedule.strategyId,
          scheduleId: schedule.id,
          dataAsOf: auditDataAsOf,
          requestedBy: input.asOf === undefined ? 'scheduled' : 'historical',
        },
        providerStatuses: [],
      },
    });
    const finishAudit = async (item: z.infer<typeof CycleItemSchema>): Promise<void> => {
      const auditStatus =
        item.status === 'failed'
          ? ('failed' as const)
          : item.status === 'partial'
            ? ('partial' as const)
            : ('succeeded' as const);
      const finishedAt = ctx.clock();
      finishPhase(finishedAt);
      const audit = await ctx.tools.record_workflow_run.execute({
        run: {
          id: workflowRunId,
          workflowName: 'strategy-daily-cycle',
          mode: 'scheduled',
          status: auditStatus,
          startedAt: workflowStartedAt,
          finishedAt,
          inputSummary: {
            strategyId: schedule.strategyId,
            scheduleId: schedule.id,
            dataAsOf: auditDataAsOf,
            requestedBy: input.asOf === undefined ? 'scheduled' : 'historical',
          },
          outputSummary: {
            status: item.status,
            phase: item.phase,
            runId,
            checkpointId,
            publication,
            summary: runSummary,
            insightProvider,
            watchlistSync,
            adviceCount,
            notificationFailed,
            preflight,
            leaseRenewals,
            checkpoint: checkpointSummary,
            dataPreparationPerformance,
            universeSync,
            observations: observationSummary,
            benchmarkSync,
            phaseTimings,
          },
          providerStatuses,
          ...(item.reason === undefined ? {} : { error: item.reason }),
        },
      });
      if (!startedAudit.ok || !audit.ok) {
        ctx.logger.warn('strategy-daily-cycle: workflow audit write failed', {
          strategyId: schedule.strategyId,
          scheduleId: schedule.id,
          workflowRunId,
        });
      }
      items.push(item);
    };
    // A cron can be more frequent than the product's once-per-trading-day contract.  The
    // schedule lease prevents concurrent owners, but it does not prevent a later tick from
    // claiming the same schedule again after a successful run.  Check the persisted run facts
    // through the Tool boundary before doing external data work; a skipped claim is audited but
    // never becomes a production cycle.
    if (input.asOf === undefined) {
      const priorRuns = await ctx.tools.list_strategy_runs.execute({
        strategyId: schedule.strategyId,
        scope: 'operational',
        limit: 500,
      });
      if (!priorRuns.ok) {
        status = 'failed';
        phase = 'finish';
        reason = errorText(priorRuns.error);
        stopHeartbeat();
        await finishAudit({
          strategyId: schedule.strategyId,
          scheduleId: schedule.id,
          status,
          phase,
          reason,
        });
        continue;
      }
      const duplicate = priorRuns.data.runs.some(
        (run) =>
          run.mode === 'scheduled' &&
          run.inputSnapshot !== undefined &&
          run.inputSnapshot.requestedBy === 'scheduled' &&
          utcDayKey(scheduledRunDataAsOf(run)) === utcDayKey(auditDataAsOf),
      );
      if (duplicate) {
        status = 'skipped';
        phase = 'finish';
        reason = 'schedule-day-duplicate';
        stopHeartbeat();
        const finished = await ctx.tools.finish_strategy_schedule_claim.execute({
          scheduleId: schedule.id,
          owner,
          fence: lease.fence,
        });
        if (!finished.ok) {
          status = 'failed';
          reason = errorText(finished.error);
        }
        await finishAudit({
          strategyId: schedule.strategyId,
          scheduleId: schedule.id,
          status,
          phase,
          reason,
        });
        continue;
      }
    }
    if (!claim.eligible) {
      const finished = await ctx.tools.finish_strategy_schedule_claim.execute({
        scheduleId: schedule.id,
        owner,
        fence: lease.fence,
      });
      if (!finished.ok) {
        status = 'failed';
        phase = 'finish';
        reason = errorText(finished.error);
      }
      await finishAudit({
        strategyId: schedule.strategyId,
        scheduleId: schedule.id,
        status,
        phase,
        ...(reason === undefined ? {} : { reason }),
      });
      continue;
    }
    const now = auditDataAsOf;
    if (isWeekend(now) || isHoliday(now)) {
      reason = '非 A 股交易日，本次跳过并推进下一次运行';
      const finished = await ctx.tools.finish_strategy_schedule_claim.execute({
        scheduleId: schedule.id,
        owner,
        fence: lease.fence,
      });
      if (!finished.ok) {
        status = 'failed';
        phase = 'finish';
        reason = errorText(finished.error);
      }
      await finishAudit({
        strategyId: schedule.strategyId,
        scheduleId: schedule.id,
        status,
        phase,
        ...(reason === undefined ? {} : { reason }),
      });
      continue;
    }
    if (!(await renewScheduleLease())) {
      await finishAudit({
        strategyId: schedule.strategyId,
        scheduleId: schedule.id,
        status: 'failed',
        phase: 'claim',
        reason: 'lease_lost_before_commit',
      });
      continue;
    }
    heartbeatTimer = setInterval(
      () => {
        if (scheduleLeaseLost || heartbeatInFlight) return;
        heartbeatInFlight = true;
        void ctx.tools.renew_strategy_schedule_claim
          .execute({
            scheduleId: schedule.id,
            owner,
            fence: lease.fence,
            leaseMinutes: input.leaseMinutes,
          })
          .then((result) => {
            if (!result.ok || !result.data.renewed) {
              scheduleLeaseLost = true;
            } else {
              leaseRenewals += 1;
            }
          })
          .catch(() => {
            scheduleLeaseLost = true;
          })
          .finally(() => {
            heartbeatInFlight = false;
          });
      },
      Math.min(5 * 60_000, Math.max(60_000, Math.floor((input.leaseMinutes * 60_000) / 3))),
    );
    beginPhase('data-prep');
    // 生产日运行必须先把当日可见股票目录固化为 PIT snapshot；显式历史
    // asOf 只能读取已有快照，禁止在当前时点抓取数据伪装成历史版本。
    if (input.asOf === undefined) {
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
    if (status === 'failed') {
      beginPhase('finish');
      stopHeartbeat();
      const finished = await ctx.tools.finish_strategy_schedule_claim.execute({
        scheduleId: schedule.id,
        owner,
        fence: lease.fence,
      });
      if (!finished.ok) reason = errorText(finished.error);
      await finishAudit({
        strategyId: schedule.strategyId,
        scheduleId: schedule.id,
        status,
        phase,
        ...(reason === undefined ? {} : { reason }),
      });
      continue;
    }
    const prepared = await ctx.tools.prepare_strategy_data.execute({
      strategyId: schedule.strategyId,
      cachePolicy: 'reuse-fresh',
      concurrency: input.concurrency,
      maxStalenessTradingDays: input.maxStalenessTradingDays,
      maxRetries: input.maxRetries,
      requestTimeoutMs: input.requestTimeoutMs,
      ...(input.asOf === undefined ? {} : { asOf: input.asOf }),
    });
    if (scheduleLeaseLost) {
      status = 'failed';
      reason = 'lease_lost_before_commit';
    } else if (!prepared.ok) {
      status = 'failed';
      reason = errorText(prepared.error);
    } else if (
      prepared.data.checkpoint.status === 'failed' ||
      prepared.data.checkpoint.requestedCount === 0 ||
      prepared.data.checkpoint.availableCount / prepared.data.checkpoint.requestedCount <
        (schedule.acceptancePolicy ?? DEFAULT_STRATEGY_RUN_ACCEPTANCE_POLICY).minEvaluatedRatio
    ) {
      status = 'failed';
      reason = 'data-checkpoint-below-min';
    } else {
      checkpointId = prepared.data.checkpoint.id;
      checkpointSummary = {
        status: prepared.data.checkpoint.status,
        requestedCount: prepared.data.checkpoint.requestedCount,
        availableCount: prepared.data.checkpoint.availableCount,
        failedCount: prepared.data.checkpoint.failedCount,
        coverageRatio:
          prepared.data.checkpoint.requestedCount === 0
            ? 0
            : prepared.data.checkpoint.availableCount / prepared.data.checkpoint.requestedCount,
        fallbackUsed: prepared.data.checkpoint.providerStatuses.some((item) => item.fallbackUsed),
        providers: prepared.data.checkpoint.providerStatuses.map((item) => item.provider),
      };
      dataPreparationPerformance = prepared.data.performance;
      providerStatuses = prepared.data.checkpoint.providerStatuses.map((item) => ({
        provider: item.provider,
        ok: item.failed === 0 && item.freshness !== 'unavailable',
        ...(item.errorKinds[0] === undefined ? {} : { errorKind: item.errorKinds[0] }),
        ...(item.latencyMs === undefined ? {} : { latencyMs: item.latencyMs }),
      }));
      if (!(await renewScheduleLease())) {
        status = 'failed';
        reason = 'lease_lost_before_commit';
      }
    }
    if (status !== 'failed' && checkpointId !== undefined) {
      beginPhase('run');
      const run = await ctx.tools.run_strategy.execute({
        strategyId: schedule.strategyId,
        mode: 'scheduled',
        persist: true,
        concurrency: input.concurrency,
        dataCheckpointId: checkpointId,
        ...(schedule.acceptancePolicy === undefined
          ? {}
          : { acceptancePolicy: schedule.acceptancePolicy }),
      });
      if (scheduleLeaseLost) {
        status = 'failed';
        reason = 'lease_lost_before_commit';
      } else if (!run.ok) {
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
          reason = `StrategyRun ${run.data.run.publication?.status ?? 'without-publication'}，不创建生产观察/建议`;
        } else if (!(await renewScheduleLease())) {
          status = 'failed';
          reason = 'lease_lost_before_commit';
        } else {
          const synced = await ctx.tools.sync_strategy_watchlist_subscriptions.execute({
            strategyId: schedule.strategyId,
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
          beginPhase('observations');
          const candidates = await ctx.tools.create_strategy_observation_candidates.execute({
            runId,
          });
          if (!candidates.ok) {
            status = 'failed';
            reason = errorText(candidates.error);
          } else if (scheduleLeaseLost) {
            status = 'failed';
            reason = 'lease_lost_before_commit';
          } else {
            observationSummary = {
              created: candidates.data.created,
              skipped: candidates.data.skipped,
              scanned: 0,
              completed: 0,
              pending: 0,
              baselines: candidates.data.baselines,
              byHorizon: Object.fromEntries(
                ACTIVE_SIGNAL_OBSERVATION_HORIZONS.map((horizon) => [
                  horizon,
                  { ...candidates.data.horizons[horizon], scanned: 0, completed: 0, pending: 0 },
                ]),
              ) as NonNullable<typeof observationSummary>['byHorizon'],
            };
            if (input.asOf !== undefined) {
              benchmarkSync = {
                status: 'skipped',
                dataVersion: STRATEGY_OBSERVATION_BENCHMARK_DATASET_VERSION,
                stockId: STRATEGY_OBSERVATION_BENCHMARK_STOCK_ID,
                reason: '历史 asOf 只读已有 benchmark 日线，不触发实时同步',
              };
            } else {
              const benchmark = await ctx.tools.sync_daily_bars.execute({
                scope: 'explicit',
                stockIds: [STRATEGY_OBSERVATION_BENCHMARK_STOCK_ID],
                correctionWindowDays: 60,
              });
              if (!benchmark.ok) {
                benchmarkSync = {
                  status: 'failed',
                  dataVersion: STRATEGY_OBSERVATION_BENCHMARK_DATASET_VERSION,
                  stockId: STRATEGY_OBSERVATION_BENCHMARK_STOCK_ID,
                  reason: errorText(benchmark.error),
                };
                status = 'partial';
                reason = errorText(benchmark.error);
              } else {
                const item = benchmark.data.items.find(
                  (candidate) => candidate.stockId === STRATEGY_OBSERVATION_BENCHMARK_STOCK_ID,
                );
                benchmarkSync = {
                  status: item?.status === 'synced' ? 'succeeded' : benchmark.data.status,
                  dataVersion: STRATEGY_OBSERVATION_BENCHMARK_DATASET_VERSION,
                  stockId: STRATEGY_OBSERVATION_BENCHMARK_STOCK_ID,
                  ...(item?.status === 'synced'
                    ? { barCount: item.barCount, source: item.sources.join(',') }
                    : {}),
                  ...(item?.status === 'failed' ? { reason: item.reason } : {}),
                };
                if (item?.status !== 'synced') {
                  status = 'partial';
                  reason = item?.status === 'failed' ? item.reason : 'benchmark 日线不可用';
                }
              }
            }
            const completed = await ctx.tools.complete_strategy_observations.execute({
              limit: 1000,
            });
            const currentObservationSummary = observationSummary;
            observationSummary = {
              ...currentObservationSummary,
              scanned: completed.ok ? completed.data.scanned : 0,
              completed: completed.ok ? completed.data.completed : 0,
              pending: completed.ok ? completed.data.pending : 0,
              byHorizon: Object.fromEntries(
                ACTIVE_SIGNAL_OBSERVATION_HORIZONS.map((horizon) => [
                  horizon,
                  {
                    ...currentObservationSummary.byHorizon[horizon],
                    ...(completed.ok
                      ? completed.data.byHorizon[horizon]
                      : { scanned: 0, completed: 0, pending: 0 }),
                  },
                ]),
              ) as NonNullable<typeof observationSummary>['byHorizon'],
            };
            if (!completed.ok || completed.data.pending > 0) {
              status = 'partial';
              reason = !completed.ok ? errorText(completed.error) : '存在尚未完成的到期观察';
            }
            if (scheduleLeaseLost) {
              status = 'failed';
              reason = 'lease_lost_before_commit';
            } else {
              beginPhase('insight');
              const insight = await ctx.tools.generate_strategy_insight.execute({
                strategyId: schedule.strategyId,
                windowDays: 30,
              });
              if (insight.ok) {
                insightProvider = insight.data.provider;
                if (insight.data.provider === 'facts-only') status = 'partial';
              } else {
                status = 'partial';
                reason = errorText(insight.error);
              }
              if (scheduleLeaseLost) {
                reason = 'lease_lost_before_commit';
                status = 'failed';
              } else if (schedule.recommendationPolicy?.enabled && (await renewScheduleLease())) {
                const recommendations = await ctx.tools.generate_strategy_recommendations.execute({
                  strategyId: schedule.strategyId,
                  runId,
                  policy: schedule.recommendationPolicy,
                });
                if (!recommendations.ok) {
                  status = 'partial';
                  reason = errorText(recommendations.error);
                } else if (recommendations.data.notificationFailed > 0) {
                  adviceCount = recommendations.data.advices.length;
                  notificationFailed = recommendations.data.notificationFailed;
                  preflight = recommendations.data.preflight;
                  status = 'partial';
                  reason = `${recommendations.data.notificationFailed} 条通知发送失败`;
                } else {
                  adviceCount = recommendations.data.advices.length;
                  notificationFailed = recommendations.data.notificationFailed;
                  preflight = recommendations.data.preflight;
                }
                if (scheduleLeaseLost) {
                  status = 'failed';
                  reason = 'lease_lost_before_commit';
                }
              }
            }
          }
          if (status === 'skipped') status = 'complete';
        }
      }
    }
    beginPhase('finish');
    if (scheduleLeaseLost) {
      status = 'failed';
      reason = 'lease_lost_before_commit';
      stopHeartbeat();
      await finishAudit({
        strategyId: schedule.strategyId,
        scheduleId: schedule.id,
        status,
        phase,
        ...(reason === undefined ? {} : { reason }),
      });
      continue;
    }
    stopHeartbeat();
    const finished = await ctx.tools.finish_strategy_schedule_claim.execute({
      scheduleId: schedule.id,
      owner,
      fence: lease.fence,
      ...(runId === undefined ? {} : { lastRunId: runId }),
    });
    if (!finished.ok) {
      status = 'failed';
      reason = errorText(finished.error);
    }
    await finishAudit({
      strategyId: schedule.strategyId,
      scheduleId: schedule.id,
      status,
      phase,
      ...(runId === undefined ? {} : { runId }),
      ...(checkpointId === undefined ? {} : { checkpointId }),
      ...(insightProvider === undefined ? {} : { insightProvider }),
      ...(watchlistSync === undefined ? {} : { watchlistSync }),
      ...(adviceCount === undefined ? {} : { adviceCount }),
      ...(notificationFailed === undefined ? {} : { notificationFailed }),
      ...(preflight === undefined ? {} : { preflight }),
      ...(reason === undefined ? {} : { reason }),
    });
  }
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
  description: '按 claim→data-prep→run→observation→insight→finish 编排 Strategy 盘后日循环',
  input: StrategyDailyCycleInput,
  steps: [runCycle],
});
