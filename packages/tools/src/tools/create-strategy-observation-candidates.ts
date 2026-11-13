import {
  ACTIVE_SIGNAL_OBSERVATION_HORIZONS,
  type ActiveSignalObservationHorizon,
  ActiveSignalObservationHorizonSchema,
  isPublishableOperationalRun,
  type StrategySignal,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';
import {
  observationsForStrategySignal,
  type StrategySignalBaseline,
} from '../internal/signal-observation.js';

export const CreateStrategyObservationCandidatesInput = z.object({
  runId: z.string().min(1),
});

const HorizonCountsSchema = z.object({
  created: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

const SOURCE_ID_CHUNK_SIZE = 500;

export const CreateStrategyObservationCandidatesOutput = z.object({
  runId: z.string().min(1),
  status: z.enum(['complete', 'skipped']),
  created: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  baselines: z.object({
    available: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
    providers: z.record(z.string(), z.number().int().nonnegative()),
  }),
  horizons: z.record(ActiveSignalObservationHorizonSchema, HorizonCountsSchema),
  reason: z.string().min(1).optional(),
});

export type CreateStrategyObservationCandidatesOutputT = z.infer<
  typeof CreateStrategyObservationCandidatesOutput
>;

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

const skipped = (runId: string, reason: string): CreateStrategyObservationCandidatesOutputT => ({
  runId,
  status: 'skipped',
  created: 0,
  skipped: 0,
  baselines: { available: 0, unavailable: 0, providers: {} },
  horizons: Object.fromEntries(
    ACTIVE_SIGNAL_OBSERVATION_HORIZONS.map((horizon) => [horizon, { created: 0, skipped: 0 }]),
  ) as Record<ActiveSignalObservationHorizon, { created: number; skipped: number }>,
  reason,
});

/**
 * 只把已发布正式运行投影成观察候选，避免 withheld / evaluation signal 进入生产观察。
 * 内部编排使用；不作为 Agent tool 暴露。
 */
export const createStrategyObservationCandidatesTool = defineTool({
  name: 'create_strategy_observation_candidates',
  description: '为 published operational StrategyRun 幂等创建 T+1/T+3/T+5 观察候选',
  sideEffect: 'write',
  input: CreateStrategyObservationCandidatesInput,
  output: CreateStrategyObservationCandidatesOutput,
  handler: async (input, ctx: ToolContext) => {
    const run = await ctx.repos.strategyRun.findRunById(input.runId);
    if (run === null) return errNotFound('StrategyRun', input.runId);
    if (!isPublishableOperationalRun(run)) {
      return skipped(
        run.id,
        `StrategyRun 不是 published operational run（scope=${run.scope ?? 'legacy'}, publication=${
          run.publication?.status ?? 'missing'
        }）`,
      );
    }

    const signals = await ctx.repos.strategyRun.signalsByRun(run.id);
    if (signals.length === 0) return skipped(run.id, 'StrategyRun 没有 emitted signals');

    const baselineBySignal = new Map(
      signals.map((signal) => [signal.id, baselineFromSignal(signal)] as const),
    );
    const candidates = signals.flatMap((signal) =>
      observationsForStrategySignal(
        signal,
        baselineBySignal.get(signal.id),
        run.finishedAt ?? run.dataAsOf,
      ),
    );
    const existingIds = new Set<string>();
    const sourceIds = signals.map((signal) => signal.id);
    for (let offset = 0; offset < sourceIds.length; offset += SOURCE_ID_CHUNK_SIZE) {
      const rows = await ctx.repos.signalObservation.listBySources({
        sourceKind: 'strategy-signal',
        sourceIds: sourceIds.slice(offset, offset + SOURCE_ID_CHUNK_SIZE),
      });
      for (const row of rows) existingIds.add(row.id);
    }
    const missing = candidates.filter((candidate) => !existingIds.has(candidate.id));
    for (const candidate of missing) await ctx.repos.signalObservation.save(candidate);

    const providers = new Map<string, number>();
    let available = 0;
    for (const baseline of baselineBySignal.values()) {
      if (baseline === undefined) continue;
      available += 1;
      providers.set(baseline.provider, (providers.get(baseline.provider) ?? 0) + 1);
    }

    return {
      runId: run.id,
      status: 'complete' as const,
      created: missing.length,
      skipped: candidates.length - missing.length,
      baselines: {
        available,
        unavailable: signals.length - available,
        providers: Object.fromEntries(
          [...providers.entries()].sort(([left], [right]) => left.localeCompare(right)),
        ),
      },
      horizons: Object.fromEntries(
        ACTIVE_SIGNAL_OBSERVATION_HORIZONS.map((horizon) => {
          const rows = candidates.filter((candidate) => candidate.horizon === horizon);
          const created = missing.filter((candidate) => candidate.horizon === horizon).length;
          return [horizon, { created, skipped: rows.length - created }];
        }),
      ) as Record<ActiveSignalObservationHorizon, { created: number; skipped: number }>,
    };
  },
});
