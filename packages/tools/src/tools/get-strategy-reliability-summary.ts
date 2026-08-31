import {
  ACTIVE_SIGNAL_OBSERVATION_HORIZONS,
  type ActiveSignalObservationHorizon,
  ActiveSignalObservationHorizonSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

const dateValue = (value: unknown): Date | undefined => {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : undefined;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
};

const dayKey = (value: Date): string => value.toISOString().slice(0, 10);

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const numberValue = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export const GetStrategyReliabilitySummaryInput = z.object({
  strategyId: z.string().min(1).optional(),
  scheduleId: z.string().min(1).optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  targetTradingDays: z.number().int().min(1).max(365).default(30),
  limit: z.number().int().positive().max(1000).default(1000),
});

export const GetStrategyReliabilitySummaryOutput = z.object({
  workflowName: z.literal('strategy-daily-cycle'),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  strategyId: z.string().optional(),
  scheduleId: z.string().optional(),
  runCount: z.number().int().nonnegative(),
  /** 显式 asOf/历史尝试保留在 WorkflowRun 审计中，但不计入生产门禁。 */
  historicalRunCount: z.number().int().nonnegative(),
  scheduleCount: z.number().int().nonnegative(),
  tradingDays: z.number().int().nonnegative(),
  tradingDayKeys: z.array(z.string()),
  scheduleTradingDayKeys: z.record(z.string(), z.array(z.string())),
  statuses: z.object({
    running: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    partial: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  publications: z.object({
    published: z.number().int().nonnegative(),
    withheld: z.number().int().nonnegative(),
    nonPublishing: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
  }),
  leases: z.object({
    totalRenewals: z.number().int().nonnegative(),
    runsWithRenewal: z.number().int().nonnegative(),
    leaseLost: z.number().int().nonnegative(),
  }),
  checkpoints: z.object({
    runsWithCheckpoint: z.number().int().nonnegative(),
    belowAcceptance: z.number().int().nonnegative(),
    requestedCount: z.number().int().nonnegative(),
    availableCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    coverageRatio: z.number().min(0).max(1),
    fallbackRuns: z.number().int().nonnegative(),
    providers: z.record(z.string(), z.number().int().nonnegative()),
  }),
  observations: z.object({
    runsWithObservations: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    baselines: z.object({
      available: z.number().int().nonnegative(),
      unavailable: z.number().int().nonnegative(),
      providers: z.record(z.string(), z.number().int().nonnegative()),
    }),
    byHorizon: z.record(
      ActiveSignalObservationHorizonSchema,
      z.object({
        created: z.number().int().nonnegative(),
        completed: z.number().int().nonnegative(),
        pending: z.number().int().nonnegative(),
      }),
    ),
  }),
  insight: z.object({
    factsOnly: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
  }),
  notifications: z.object({
    failed: z.number().int().nonnegative(),
    runsWithFailure: z.number().int().nonnegative(),
  }),
  providerErrors: z.record(z.string(), z.number().int().nonnegative()),
  /** 同一 schedule 在同一交易日出现多条正式周期运行的重复计数。 */
  scheduleDayDuplicates: z.number().int().nonnegative(),
  /** WorkflowRun.phaseTimings 的真实样本分位数，供性能门禁复核。 */
  phaseDurations: z.record(
    z.string(),
    z.object({
      samples: z.number().int().nonnegative(),
      p50Ms: z.number().nonnegative(),
      p95Ms: z.number().nonnegative(),
      maxMs: z.number().nonnegative(),
    }),
  ),
  /** 真实 provider 成员请求延迟分布；跨周期聚合的是原始成员样本的等权近似。 */
  providerLatencies: z.record(
    z.string(),
    z.object({
      samples: z.number().int().nonnegative(),
      p50Ms: z.number().nonnegative(),
      p95Ms: z.number().nonnegative(),
      maxMs: z.number().nonnegative(),
    }),
  ),
  observationTarget: z.object({
    targetTradingDays: z.number().int().positive(),
    reached: z.boolean(),
    blockers: z.array(z.string()),
  }),
  gate: z.object({
    targetTradingDays: z.number().int().positive(),
    ready: z.boolean(),
    blockers: z.array(z.string()),
  }),
});

export const getStrategyReliabilitySummaryTool = defineTool({
  name: 'get_strategy_reliability_summary',
  description: '汇总 strategy-daily-cycle 的真实运行审计；样本目标独立于生产可靠性门禁',
  sideEffect: 'read',
  input: GetStrategyReliabilitySummaryInput,
  output: GetStrategyReliabilitySummaryOutput,
  handler: async (input, ctx) => {
    const runs = await ctx.repos.workflowRun.listRecent({
      workflowName: 'strategy-daily-cycle',
      ...(input.since === undefined ? {} : { since: input.since }),
      limit: input.limit,
    });
    const filtered = runs
      // 进程恢复时被收敛的 WorkflowRun 仍保留作审计，但不是一次正式 schedule 周期；
      // 不应把它计入正式运行数、阶段延迟或 schedule-day duplicate 门禁。
      .filter(
        (run) => recordValue(run.outputSummary)?.reconciliation !== 'stale_workflow_run_reconciled',
      )
      .filter((run) => {
        const dataAsOf = dateValue(recordValue(run.inputSummary)?.dataAsOf) ?? run.startedAt;
        if (input.since !== undefined && dataAsOf < input.since) return false;
        if (input.until !== undefined && dataAsOf > input.until) return false;
        return true;
      })
      .filter((run) => {
        if (input.strategyId === undefined) return true;
        return recordValue(run.inputSummary)?.strategyId === input.strategyId;
      })
      .filter((run) => {
        if (input.scheduleId === undefined) return true;
        return recordValue(run.inputSummary)?.scheduleId === input.scheduleId;
      });
    // Holiday/ineligible/duplicate claims are audited as skipped workflow attempts, not
    // production cycles.  Excluding them keeps trading-day, phase and publication gates tied to
    // actual StrategyRun-producing cycles.
    const cycleRuns = filtered.filter(
      (run) => recordValue(run.outputSummary)?.status !== 'skipped',
    );
    const historicalRuns = cycleRuns.filter((run) => {
      const inputSummary = recordValue(run.inputSummary);
      if (inputSummary?.requestedBy === 'historical') return true;
      // 兼容已落库的旧显式 asOf 周期：正常生产周期的 dataAsOf 与 startedAt
      // 只相差当天时区边界；跨过一天以上即视为历史尝试，保留审计但不污染 S3 门禁。
      const dataAsOf = dateValue(inputSummary?.dataAsOf);
      return (
        dataAsOf !== undefined && run.startedAt.getTime() - dataAsOf.getTime() > 24 * 60 * 60_000
      );
    });
    const productionRuns = cycleRuns.filter((run) => !historicalRuns.includes(run));
    const scheduleIds = new Set<string>();
    const tradingDays = new Set<string>();
    const scheduleTradingDayKeys = new Map<string, Set<string>>();
    const statuses = { running: 0, succeeded: 0, partial: 0, failed: 0 };
    const publications = { published: 0, withheld: 0, nonPublishing: 0, missing: 0 };
    const leases = { totalRenewals: 0, runsWithRenewal: 0, leaseLost: 0 };
    const checkpoints = {
      runsWithCheckpoint: 0,
      belowAcceptance: 0,
      requestedCount: 0,
      availableCount: 0,
      failedCount: 0,
      fallbackRuns: 0,
    };
    const checkpointProviders = new Map<string, number>();
    const observationBaselineProviders = new Map<string, number>();
    const observationByHorizon = Object.fromEntries(
      ACTIVE_SIGNAL_OBSERVATION_HORIZONS.map((horizon) => [
        horizon,
        { created: 0, completed: 0, pending: 0 },
      ]),
    ) as Record<
      ActiveSignalObservationHorizon,
      { created: number; completed: number; pending: number }
    >;
    const observations = {
      runsWithObservations: 0,
      completed: 0,
      pending: 0,
      baselines: { available: 0, unavailable: 0 },
    };
    const insight = { factsOnly: 0, unavailable: 0 };
    const notifications = { failed: 0, runsWithFailure: 0 };
    const providerErrors = new Map<string, number>();
    const scheduleDayRunCounts = new Map<string, number>();
    const phaseDurationSamples = new Map<string, number[]>();
    const providerLatencySamples = new Map<string, number[]>();
    const providerLatencyCounts = new Map<string, number>();
    const providerLatencySummaries = new Map<
      string,
      Array<{ p50Ms: number; p95Ms: number; maxMs: number }>
    >();

    for (const run of productionRuns) {
      statuses[run.status] += 1;
      const inputSummary = recordValue(run.inputSummary);
      const outputSummary = recordValue(run.outputSummary);
      const scheduleId = inputSummary?.scheduleId;
      if (typeof scheduleId === 'string') scheduleIds.add(scheduleId);
      const dataAsOf = dateValue(inputSummary?.dataAsOf) ?? run.startedAt;
      const tradingDayKey = dayKey(dataAsOf);
      tradingDays.add(tradingDayKey);
      if (typeof scheduleId === 'string') {
        const scheduleDays = scheduleTradingDayKeys.get(scheduleId) ?? new Set<string>();
        scheduleDays.add(tradingDayKey);
        scheduleTradingDayKeys.set(scheduleId, scheduleDays);
        const scheduleDay = `${scheduleId}:${dayKey(dataAsOf)}`;
        scheduleDayRunCounts.set(scheduleDay, (scheduleDayRunCounts.get(scheduleDay) ?? 0) + 1);
      }
      const phaseTimings = outputSummary?.phaseTimings;
      if (Array.isArray(phaseTimings)) {
        for (const timing of phaseTimings) {
          const row = recordValue(timing);
          const phase = row?.phase;
          const durationMs = numberValue(row?.durationMs);
          if (typeof phase !== 'string' || durationMs === undefined || durationMs < 0) continue;
          const samples = phaseDurationSamples.get(phase) ?? [];
          samples.push(durationMs);
          phaseDurationSamples.set(phase, samples);
        }
      }

      const publication = outputSummary?.publication;
      if (publication === 'published') publications.published += 1;
      else if (publication === 'withheld') publications.withheld += 1;
      else if (publication === 'non-publishing') publications.nonPublishing += 1;
      else publications.missing += 1;

      const renewalCount = numberValue(outputSummary?.leaseRenewals) ?? 0;
      leases.totalRenewals += Math.max(0, Math.floor(renewalCount));
      if (renewalCount > 0) leases.runsWithRenewal += 1;
      const reason = outputSummary?.reason ?? run.error;
      if (reason === 'lease_lost_before_commit') leases.leaseLost += 1;

      const checkpoint = recordValue(outputSummary?.checkpoint);
      if (checkpoint !== undefined) {
        checkpoints.runsWithCheckpoint += 1;
        const requested = numberValue(checkpoint.requestedCount) ?? 0;
        const available = numberValue(checkpoint.availableCount) ?? 0;
        const failed = numberValue(checkpoint.failedCount) ?? 0;
        checkpoints.requestedCount += Math.max(0, Math.floor(requested));
        checkpoints.availableCount += Math.max(0, Math.floor(available));
        checkpoints.failedCount += Math.max(0, Math.floor(failed));
        if ((numberValue(checkpoint.coverageRatio) ?? 0) < 0.98) {
          checkpoints.belowAcceptance += 1;
        }
        if (checkpoint.fallbackUsed === true) checkpoints.fallbackRuns += 1;
        if (Array.isArray(checkpoint.providers)) {
          for (const provider of checkpoint.providers) {
            if (typeof provider !== 'string') continue;
            checkpointProviders.set(provider, (checkpointProviders.get(provider) ?? 0) + 1);
          }
        }
      }

      const observation = recordValue(outputSummary?.observations);
      if (observation !== undefined) {
        observations.runsWithObservations += 1;
        observations.completed += Math.max(0, Math.floor(numberValue(observation.completed) ?? 0));
        observations.pending += Math.max(0, Math.floor(numberValue(observation.pending) ?? 0));
        const baselines = recordValue(observation.baselines);
        observations.baselines.available += Math.max(
          0,
          Math.floor(numberValue(baselines?.available) ?? 0),
        );
        observations.baselines.unavailable += Math.max(
          0,
          Math.floor(numberValue(baselines?.unavailable) ?? 0),
        );
        const baselineProviders = recordValue(baselines?.providers);
        if (baselineProviders !== undefined) {
          for (const [provider, count] of Object.entries(baselineProviders)) {
            const value = numberValue(count);
            if (value === undefined || value < 0) continue;
            observationBaselineProviders.set(
              provider,
              (observationBaselineProviders.get(provider) ?? 0) + Math.floor(value),
            );
          }
        }
        const byHorizon = recordValue(observation.byHorizon);
        for (const horizon of ACTIVE_SIGNAL_OBSERVATION_HORIZONS) {
          const row = recordValue(byHorizon?.[horizon]);
          observationByHorizon[horizon].created += Math.max(
            0,
            Math.floor(numberValue(row?.created) ?? 0),
          );
          observationByHorizon[horizon].completed += Math.max(
            0,
            Math.floor(numberValue(row?.completed) ?? 0),
          );
          observationByHorizon[horizon].pending += Math.max(
            0,
            Math.floor(numberValue(row?.pending) ?? 0),
          );
        }
      }
      if (outputSummary?.insightProvider === 'facts-only') insight.factsOnly += 1;
      if (
        typeof outputSummary?.insightProvider === 'string' &&
        outputSummary.insightProvider === 'unavailable'
      ) {
        insight.unavailable += 1;
      }
      const notificationFailed = numberValue(outputSummary?.notificationFailed) ?? 0;
      if (notificationFailed > 0) {
        notifications.failed += Math.floor(notificationFailed);
        notifications.runsWithFailure += 1;
      }
      for (const provider of run.providerStatuses) {
        if (provider.latencyMs !== undefined && provider.latencyMs.samples > 0) {
          const samples = providerLatencySamples.get(provider.provider) ?? [];
          // ProviderStatus persists only aggregate latency; retain its percentile points as
          // auditable observations and label the cross-run aggregate as an approximation.
          samples.push(
            provider.latencyMs.p50Ms,
            provider.latencyMs.p95Ms,
            provider.latencyMs.maxMs,
          );
          providerLatencySamples.set(provider.provider, samples);
          providerLatencyCounts.set(
            provider.provider,
            (providerLatencyCounts.get(provider.provider) ?? 0) + provider.latencyMs.samples,
          );
          const summaries = providerLatencySummaries.get(provider.provider) ?? [];
          summaries.push({
            p50Ms: provider.latencyMs.p50Ms,
            p95Ms: provider.latencyMs.p95Ms,
            maxMs: provider.latencyMs.maxMs,
          });
          providerLatencySummaries.set(provider.provider, summaries);
        }
        if (provider.ok || provider.errorKind === undefined) continue;
        providerErrors.set(provider.errorKind, (providerErrors.get(provider.errorKind) ?? 0) + 1);
      }
    }

    const requested = checkpoints.requestedCount;
    const coverageRatio = requested === 0 ? 0 : checkpoints.availableCount / requested;
    const scheduleDayDuplicates = [...scheduleDayRunCounts.values()].reduce(
      (count, runs) => count + Math.max(0, runs - 1),
      0,
    );
    const scheduleTradingDayKeysOutput = Object.fromEntries(
      [...scheduleTradingDayKeys.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([scheduleId, days]) => [scheduleId, [...days].sort()]),
    );
    const percentile = (samples: readonly number[], ratio: number): number => {
      const sorted = [...samples].sort((left, right) => left - right);
      const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
      return sorted[index] ?? 0;
    };
    const phaseDurations = Object.fromEntries(
      [...phaseDurationSamples.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([phase, samples]) => [
          phase,
          {
            samples: samples.length,
            p50Ms: percentile(samples, 0.5),
            p95Ms: percentile(samples, 0.95),
            maxMs: Math.max(...samples),
          },
        ]),
    );
    const providerLatencies = Object.fromEntries(
      [...providerLatencySamples.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([provider, samples]) => [
          provider,
          {
            samples: providerLatencyCounts.get(provider) ?? samples.length,
            ...(providerLatencySummaries.get(provider)?.length === 1
              ? providerLatencySummaries.get(provider)?.[0]
              : {
                  p50Ms: percentile(samples, 0.5),
                  p95Ms: percentile(samples, 0.95),
                  maxMs: Math.max(...samples),
                }),
          },
        ]),
    );
    const blockers: string[] = [];
    if (productionRuns.length === 0) blockers.push('no-production-cycles');
    const observationTargetBlockers: string[] = [];
    if (tradingDays.size < input.targetTradingDays) {
      observationTargetBlockers.push('trading-days-below-target');
    }
    if (
      scheduleTradingDayKeys.size > 1 &&
      [...scheduleTradingDayKeys.values()].some((days) => days.size < input.targetTradingDays)
    ) {
      observationTargetBlockers.push('schedule-days-below-target');
    }
    if (leases.leaseLost > 0) blockers.push('lease-lost');
    if (checkpoints.belowAcceptance > 0) blockers.push('checkpoint-below-acceptance');
    const completedCycles = statuses.succeeded + statuses.partial;
    if (publications.withheld > 0) blockers.push('publication-withheld');
    if (publications.missing > 0) blockers.push('publication-missing');
    if (checkpoints.runsWithCheckpoint < completedCycles) blockers.push('checkpoint-missing');
    if (observations.runsWithObservations < completedCycles) {
      blockers.push('observation-audit-missing');
    }
    if (observations.pending > 0) blockers.push('observation-pending');
    if (observations.baselines.unavailable > 0) blockers.push('observation-baseline-unavailable');
    if (notifications.failed > 0) blockers.push('notification-failed');
    if (statuses.running > 0) blockers.push('cycle-running');
    if (statuses.failed > 0) blockers.push('cycle-failed');
    if (scheduleDayDuplicates > 0) blockers.push('schedule-day-duplicate');

    return GetStrategyReliabilitySummaryOutput.parse({
      workflowName: 'strategy-daily-cycle',
      ...(input.since === undefined ? {} : { since: input.since }),
      ...(input.until === undefined ? {} : { until: input.until }),
      ...(input.strategyId === undefined ? {} : { strategyId: input.strategyId }),
      ...(input.scheduleId === undefined ? {} : { scheduleId: input.scheduleId }),
      runCount: productionRuns.length,
      historicalRunCount: historicalRuns.length,
      scheduleCount: scheduleIds.size,
      tradingDays: tradingDays.size,
      tradingDayKeys: [...tradingDays].sort(),
      scheduleTradingDayKeys: scheduleTradingDayKeysOutput,
      statuses,
      publications,
      leases,
      checkpoints: {
        ...checkpoints,
        coverageRatio: Math.min(1, Math.max(0, coverageRatio)),
        providers: Object.fromEntries(
          [...checkpointProviders].sort(([left], [right]) => left.localeCompare(right)),
        ),
      },
      observations: {
        ...observations,
        baselines: {
          ...observations.baselines,
          providers: Object.fromEntries(
            [...observationBaselineProviders].sort(([left], [right]) => left.localeCompare(right)),
          ),
        },
        byHorizon: observationByHorizon,
      },
      insight,
      notifications,
      providerErrors: Object.fromEntries(
        [...providerErrors].sort(([a], [b]) => a.localeCompare(b)),
      ),
      scheduleDayDuplicates,
      phaseDurations,
      providerLatencies,
      observationTarget: {
        targetTradingDays: input.targetTradingDays,
        reached: observationTargetBlockers.length === 0,
        blockers: observationTargetBlockers,
      },
      gate: {
        targetTradingDays: input.targetTradingDays,
        ready: blockers.length === 0,
        blockers,
      },
    });
  },
});
