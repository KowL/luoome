import {
  STRATEGY_OBSERVATION_BENCHMARK_DATASET_VERSION,
  STRATEGY_OBSERVATION_BENCHMARK_STOCK_ID,
} from '@luoome/core';
import { z } from 'zod';

import { defineWorkflow, type WorkflowStep } from './define-workflow.js';

export const CompleteStrategyObservationsWorkflowInput = z.object({
  limit: z.number().int().min(1).max(5000).default(1000),
  syncBars: z.boolean().default(true),
});
export type CompleteStrategyObservationsWorkflowInputT = z.infer<
  typeof CompleteStrategyObservationsWorkflowInput
>;

export const CompleteStrategyObservationsWorkflowOutput = z.object({
  requestedStocks: z.number().int().nonnegative(),
  syncedStocks: z.number().int().nonnegative(),
  failedStocks: z.number().int().nonnegative(),
  scanned: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  byHorizon: z.record(
    z.enum(['t1', 't3', 't5', 't20']),
    z.object({
      scanned: z.number().int().nonnegative(),
      completed: z.number().int().nonnegative(),
      pending: z.number().int().nonnegative(),
    }),
  ),
  recommendationAdvices: z.number().int().nonnegative(),
  recommendationFailed: z.number().int().nonnegative(),
  benchmarkDataVersion: z.literal(STRATEGY_OBSERVATION_BENCHMARK_DATASET_VERSION),
  benchmarkSyncStatus: z.enum(['succeeded', 'partial', 'failed', 'skipped']),
  benchmarkSynced: z.number().int().nonnegative(),
  benchmarkFailed: z.number().int().nonnegative(),
  benchmarkSources: z.array(z.string()),
});
export type CompleteStrategyObservationsWorkflowOutputT = z.infer<
  typeof CompleteStrategyObservationsWorkflowOutput
>;

const complete: WorkflowStep = async (previous, ctx) => {
  const input = previous as CompleteStrategyObservationsWorkflowInputT;
  const listed = await ctx.tools.list_pending_strategy_observations.execute({
    limit: input.limit,
  });
  if (!listed.ok) return listed;
  let syncedStocks = 0;
  let failedStocks = 0;
  let benchmarkSyncStatus: CompleteStrategyObservationsWorkflowOutputT['benchmarkSyncStatus'] =
    'skipped';
  let benchmarkSynced = 0;
  let benchmarkFailed = 0;
  let benchmarkSources: string[] = [];
  if (input.syncBars && listed.data.stockIds.length > 0) {
    const synced = await ctx.tools.sync_daily_bars.execute({
      scope: 'explicit',
      stockIds: [...new Set([...listed.data.stockIds, STRATEGY_OBSERVATION_BENCHMARK_STOCK_ID])],
      correctionWindowDays: 60,
    });
    if (!synced.ok) return synced;
    const benchmarkItem = synced.data.items.find(
      (item) => item.stockId === STRATEGY_OBSERVATION_BENCHMARK_STOCK_ID,
    );
    if (benchmarkItem?.status === 'synced') {
      benchmarkSyncStatus = 'succeeded';
      benchmarkSynced = 1;
      benchmarkSources = benchmarkItem.sources;
    } else if (benchmarkItem?.status === 'failed') {
      benchmarkSyncStatus = 'failed';
      benchmarkFailed = 1;
    } else {
      benchmarkSyncStatus = synced.data.status;
    }
    const stockItems = synced.data.items.filter(
      (item) => item.stockId !== STRATEGY_OBSERVATION_BENCHMARK_STOCK_ID,
    );
    syncedStocks = stockItems.filter((item) => item.status === 'synced').length;
    failedStocks = stockItems.filter((item) => item.status === 'failed').length;
  }
  const result = await ctx.tools.complete_strategy_observations.execute({ limit: input.limit });
  if (!result.ok) return result;
  const completedIds = new Set(result.data.completedIds);
  const groups = new Map<
    string,
    { strategyId: string; runId: string; horizon: 't1' | 't3' | 't5' | 't20'; stockIds: string[] }
  >();
  for (const observation of listed.data.observations) {
    if (!completedIds.has(observation.id)) continue;
    const signals = await ctx.tools.strategy_signals_by_stock.execute({
      stockId: observation.stockId,
      limit: 500,
    });
    if (!signals.ok) continue;
    const signal = signals.data.signals.find((item) => item.id === observation.sourceId);
    if (signal === undefined) continue;
    const key = `${signal.strategyId}\0${signal.runId}\0${observation.horizon}`;
    const group = groups.get(key) ?? {
      strategyId: signal.strategyId,
      runId: signal.runId,
      horizon: observation.horizon,
      stockIds: [],
    };
    if (!group.stockIds.includes(observation.stockId)) group.stockIds.push(observation.stockId);
    groups.set(key, group);
  }
  let recommendationAdvices = 0;
  let recommendationFailed = 0;
  for (const group of groups.values()) {
    const schedule = await ctx.tools.get_strategy_schedule.execute({
      strategyId: group.strategyId,
    });
    if (!schedule.ok || schedule.data.schedule?.recommendationPolicy?.enabled !== true) continue;
    const policy = schedule.data.schedule.recommendationPolicy;
    if (!policy.observationHorizons.includes(group.horizon)) continue;
    const recommended = await ctx.tools.generate_strategy_recommendations.execute({
      strategyId: group.strategyId,
      runId: group.runId,
      policy,
      trigger: group.horizon,
      stockIds: group.stockIds,
    });
    if (recommended.ok) recommendationAdvices += recommended.data.advices.length;
    else recommendationFailed += 1;
  }
  return CompleteStrategyObservationsWorkflowOutput.parse({
    requestedStocks: listed.data.stockIds.length,
    syncedStocks,
    failedStocks,
    scanned: result.data.scanned,
    completed: result.data.completed,
    pending: result.data.pending,
    byHorizon: result.data.byHorizon,
    recommendationAdvices,
    recommendationFailed,
    benchmarkDataVersion: STRATEGY_OBSERVATION_BENCHMARK_DATASET_VERSION,
    benchmarkSyncStatus,
    benchmarkSynced,
    benchmarkFailed,
    benchmarkSources,
  });
};

export const completeStrategyObservationsWorkflow = defineWorkflow<
  CompleteStrategyObservationsWorkflowInputT,
  CompleteStrategyObservationsWorkflowOutputT
>({
  name: 'complete-strategy-observations',
  description: '同步规范日线并补齐 StrategySignal 的真实观察',
  input: CompleteStrategyObservationsWorkflowInput,
  steps: [complete],
});
