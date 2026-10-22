import {
  ActiveSignalObservationHorizonSchema,
  STRATEGY_OBSERVATION_BENCHMARK_DATASET_VERSION,
  STRATEGY_OBSERVATION_BENCHMARK_STOCK_ID,
  StrategyRecommendationPreflightSummarySchema,
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
    ActiveSignalObservationHorizonSchema,
    z.object({
      scanned: z.number().int().nonnegative(),
      completed: z.number().int().nonnegative(),
      pending: z.number().int().nonnegative(),
    }),
  ),
  recommendationAdvices: z.number().int().nonnegative(),
  recommendationFailed: z.number().int().nonnegative(),
  recommendationPreflight: StrategyRecommendationPreflightSummarySchema.optional(),
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
  // 内置 AI 已下线：观察补齐后不再本地生成建议（无队列期），推荐计数恒为 0。
  return CompleteStrategyObservationsWorkflowOutput.parse({
    requestedStocks: listed.data.stockIds.length,
    syncedStocks,
    failedStocks,
    scanned: result.data.scanned,
    completed: result.data.completed,
    pending: result.data.pending,
    byHorizon: result.data.byHorizon,
    recommendationAdvices: 0,
    recommendationFailed: 0,
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
