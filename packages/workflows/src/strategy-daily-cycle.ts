import { DEFAULT_STRATEGY_RUN_ACCEPTANCE_POLICY, isHoliday, isWeekend } from '@luoome/core';
import { z } from 'zod';

import { defineWorkflow, type WorkflowStep } from './define-workflow.js';

export const StrategyDailyCycleInput = z.object({
  owner: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(20).default(1),
  leaseMinutes: z.number().int().min(5).max(240).default(30),
  asOf: z.coerce.date().optional(),
  concurrency: z.number().int().min(1).max(64).default(8),
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
  adviceCount: z.number().int().nonnegative().optional(),
  notificationFailed: z.number().int().nonnegative().optional(),
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

const runCycle: WorkflowStep = async (previous, ctx) => {
  const input = previous as StrategyDailyCycleInputT;
  const owner = input.owner ?? `strategy-daily-cycle:${globalThis.crypto.randomUUID()}`;
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
    let adviceCount: number | undefined;
    let notificationFailed: number | undefined;
    let publication: string | undefined;
    let scheduleLeaseLost = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatInFlight = false;
    const stopHeartbeat = (): void => {
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    };
    const workflowRunId = `workflow-strategy-daily-cycle-${globalThis.crypto.randomUUID()}`;
    const workflowStartedAt = ctx.clock();
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
          dataAsOf: input.asOf,
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
            dataAsOf: input.asOf,
          },
          outputSummary: {
            status: item.status,
            phase: item.phase,
            runId,
            checkpointId,
            publication,
            insightProvider,
            adviceCount,
            notificationFailed,
          },
          providerStatuses: [],
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
    const now = input.asOf ?? ctx.clock();
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
    const renewed = await ctx.tools.renew_strategy_schedule_claim.execute({
      scheduleId: schedule.id,
      owner,
      fence: lease.fence,
      leaseMinutes: input.leaseMinutes,
    });
    if (!renewed.ok || !renewed.data.renewed) {
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
            if (!result.ok || !result.data.renewed) scheduleLeaseLost = true;
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
    phase = 'data-prep';
    const prepared = await ctx.tools.prepare_strategy_data.execute({
      strategyId: schedule.strategyId,
      cachePolicy: 'reuse-fresh',
      concurrency: input.concurrency,
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
      phase = 'run';
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
        publication = run.data.run.publication?.status;
        if (run.data.run.status === 'failed') {
          status = 'failed';
          reason = run.data.run.error ?? 'StrategyRun failed';
        } else if (run.data.run.publication?.status !== 'published') {
          status = 'partial';
          reason = `StrategyRun ${run.data.run.publication?.status ?? 'without-publication'}，不创建生产观察/建议`;
        } else if (scheduleLeaseLost) {
          status = 'failed';
          reason = 'lease_lost_before_commit';
        } else {
          phase = 'observations';
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
            const completed = await ctx.tools.complete_strategy_observations.execute({
              limit: 1000,
            });
            if (!completed.ok || completed.data.pending > 0) {
              status = 'partial';
              reason = !completed.ok ? errorText(completed.error) : '存在尚未完成的到期观察';
            }
            if (scheduleLeaseLost) {
              status = 'failed';
              reason = 'lease_lost_before_commit';
            } else {
              phase = 'insight';
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
              } else if (schedule.recommendationPolicy?.enabled) {
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
                  status = 'partial';
                  reason = `${recommendations.data.notificationFailed} 条通知发送失败`;
                } else {
                  adviceCount = recommendations.data.advices.length;
                  notificationFailed = recommendations.data.notificationFailed;
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
    phase = 'finish';
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
      ...(adviceCount === undefined ? {} : { adviceCount }),
      ...(notificationFailed === undefined ? {} : { notificationFailed }),
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
