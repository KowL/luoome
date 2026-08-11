import { isPublishableOperationalRun, type StrategySignal, type ToolContext } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';
import {
  observationsForStrategySignal,
  type StrategySignalBaseline,
  saveObservationCandidates,
} from '../internal/signal-observation.js';

export const CreateStrategyObservationCandidatesInput = z.object({
  runId: z.string().min(1),
});

export const CreateStrategyObservationCandidatesOutput = z.object({
  runId: z.string().min(1),
  created: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

const baselineFromSignal = (signal: StrategySignal): StrategySignalBaseline | undefined => {
  const raw = signal.evaluationSnapshot.baseline;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const at =
    value.at instanceof Date
      ? value.at
      : typeof value.at === 'string' || typeof value.at === 'number'
        ? new Date(value.at)
        : undefined;
  if (
    typeof value.price !== 'number' ||
    !Number.isFinite(value.price) ||
    value.price <= 0 ||
    at === undefined ||
    !Number.isFinite(at.getTime()) ||
    typeof value.provider !== 'string'
  ) {
    return undefined;
  }
  return { price: value.price, at, provider: value.provider };
};

export const createStrategyObservationCandidatesTool = defineTool({
  name: 'create_strategy_observation_candidates',
  description: '仅为已发布 operational StrategyRun 创建事实表现观察候选；不创建建议或交易',
  sideEffect: 'write',
  input: CreateStrategyObservationCandidatesInput,
  output: CreateStrategyObservationCandidatesOutput,
  handler: async (input, ctx: ToolContext) => {
    const run = await ctx.repos.strategyRun.findRunById(input.runId);
    if (run === null) return errNotFound('StrategyRun', input.runId);
    if (!isPublishableOperationalRun(run)) {
      return errInvalidInput('只有 published operational StrategyRun 才能创建观察候选');
    }
    const signals = await ctx.repos.strategyRun.signalsByRun(input.runId);
    const existing = new Set(
      (
        await ctx.repos.signalObservation.list({
          sourceKind: 'strategy-signal',
          sourceIds: signals.map((signal) => signal.id),
        })
      ).map((observation) => observation.id),
    );
    const candidates = signals.flatMap((signal) =>
      observationsForStrategySignal(
        signal,
        baselineFromSignal(signal),
        run.finishedAt ?? run.dataAsOf,
      ),
    );
    await saveObservationCandidates(candidates, ctx.repos.signalObservation);
    return {
      runId: input.runId,
      created: candidates.filter((candidate) => !existing.has(candidate.id)).length,
      skipped: candidates.filter((candidate) => existing.has(candidate.id)).length,
    };
  },
});
