import type {
  Strategy,
  StrategyResult,
  StrategyRun,
  StrategyRunPublicationStatus,
  StrategyRunScope,
  StrategyVersion,
  ToolContext,
} from '@luoome/core';

export interface StrategyRunTimelineEntry {
  readonly run: StrategyRun;
  readonly version: StrategyVersion | null;
  readonly results: readonly StrategyResult[];
}

export interface StrategyRunTimeline {
  readonly entries: readonly StrategyRunTimelineEntry[];
  readonly byRunId: ReadonlyMap<string, StrategyRunTimelineEntry>;
}

export interface StrategyOperationalBaseline {
  readonly latestAttempt?: StrategyRunTimelineEntry;
  readonly current?: StrategyRunTimelineEntry;
  readonly previous?: StrategyRunTimelineEntry;
}

const uniqueRuns = (runs: readonly (StrategyRun | null | undefined)[]): StrategyRun[] => {
  const byId = new Map<string, StrategyRun>();
  for (const run of runs) {
    if (run !== null && run !== undefined) byId.set(run.id, run);
  }
  return [...byId.values()];
};

export const hydrateStrategyRunTimeline = async (
  ctx: ToolContext,
  runs: readonly StrategyRun[],
): Promise<StrategyRunTimeline> => {
  if (runs.length === 0) return { entries: [], byRunId: new Map() };
  const versions = await Promise.all(
    [...new Set(runs.map((run) => run.strategyVersionId))].map(
      async (versionId) =>
        [versionId, await ctx.repos.strategy.findVersionById(versionId)] as const,
    ),
  );
  const versionById = new Map(versions);
  const results = await ctx.repos.strategyRun.listResultsByRuns(runs.map((run) => run.id));
  const resultsByRun = new Map<string, StrategyResult[]>();
  for (const result of results) {
    const existing = resultsByRun.get(result.runId);
    if (existing === undefined) resultsByRun.set(result.runId, [result]);
    else existing.push(result);
  }
  const entries = runs.map((run) => ({
    run,
    version: versionById.get(run.strategyVersionId) ?? null,
    results: resultsByRun.get(run.id) ?? [],
  }));
  return {
    entries,
    byRunId: new Map(entries.map((entry) => [entry.run.id, entry] as const)),
  };
};

export const readStrategyRunTimeline = async (
  ctx: ToolContext,
  input: {
    readonly strategyId: string;
    readonly status?: StrategyRun['status'];
    readonly scope?: StrategyRunScope;
    readonly publication?: StrategyRunPublicationStatus;
    readonly since?: Date;
    readonly limit: number;
  },
): Promise<StrategyRunTimeline> => {
  const runs = await ctx.repos.strategyRun.listRuns({
    strategyId: input.strategyId,
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    ...(input.publication === undefined ? {} : { publication: input.publication }),
    ...(input.since === undefined ? {} : { since: input.since }),
    limit: input.limit,
  });
  return hydrateStrategyRunTimeline(ctx, runs);
};

export const readStrategyOperationalBaseline = async (
  ctx: ToolContext,
  strategy: Strategy,
): Promise<StrategyOperationalBaseline> => {
  const [latestAttempts, current] = await Promise.all([
    ctx.repos.strategyRun.listRuns({
      strategyId: strategy.id,
      scope: 'operational',
      limit: 1,
    }),
    ctx.repos.strategyRun.findLatestPublishedRun(strategy.id),
  ]);
  const previous =
    current === null
      ? null
      : await ctx.repos.strategyRun.findPreviousPublishedRun({
          strategyId: strategy.id,
          beforeStartedAt: current.startedAt,
          beforeRunId: current.id,
        });
  const timeline = await hydrateStrategyRunTimeline(
    ctx,
    uniqueRuns([latestAttempts[0], current, previous]),
  );
  const latestAttempt = latestAttempts[0];
  const latestAttemptEntry =
    latestAttempt === undefined ? undefined : timeline.byRunId.get(latestAttempt.id);
  const currentEntry = current === null ? undefined : timeline.byRunId.get(current.id);
  const previousEntry = previous === null ? undefined : timeline.byRunId.get(previous.id);

  return {
    ...(latestAttemptEntry === undefined ? {} : { latestAttempt: latestAttemptEntry }),
    ...(currentEntry === undefined ? {} : { current: currentEntry }),
    ...(previousEntry === undefined ? {} : { previous: previousEntry }),
  };
};
