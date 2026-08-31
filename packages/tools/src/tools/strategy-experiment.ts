import {
  ACTIVE_SIGNAL_OBSERVATION_HORIZONS,
  type ActiveSignalObservationHorizon,
  ActiveSignalObservationHorizonSchema,
  AdaptivePersonalityAssessmentSchema,
  AdaptivePersonalityPolicySchema,
  aggregateSignalObservationStats,
  assessAdaptivePersonality,
  assessStrategyPromotion,
  deduplicateSignalObservations,
  diffStrategyDefinitions,
  EARLY_BREAKOUT_V2_DRAFT,
  isActiveSignalObservationHorizon,
  isPublishableOperationalRun,
  type SignalObservation,
  STRATEGY_FIELD_REGISTRY,
  StrategyDefinitionDiffSchema,
  StrategyDslV1Schema,
  StrategyEvaluationDaySchema,
  StrategyEvaluationSessionSchema,
  type StrategyFieldType,
  StrategyPromotionAssessmentSchema,
  type StrategyRun,
  StrategySchema,
  type StrategySignal,
  type StrategyVersion,
  StrategyVersionSchema,
  StrictBacktestRunSchema,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

const STRATEGY_DSL_OPERATORS: Readonly<Record<StrategyFieldType, readonly string[]>> = {
  number: ['==', '!=', '===', '!==', '<', '<=', '>', '>=', '+', '-', '*', '/', '%'],
  boolean: ['==', '!=', '===', '!==', '&&', '||', '!'],
  string: ['==', '!=', '===', '!=='],
};

export const GetStrategyDslCatalogInput = z.object({
  schemaVersion: z.literal(1).default(1),
});

const StrategyDslCatalogFieldSchema = z.object({
  path: z.string().min(1),
  type: z.enum(['number', 'boolean', 'string']),
  unit: z.string().optional(),
  requiredLookback: z.number().int().nonnegative().optional(),
  dataSource: z.enum(['quote', 'daily-bars', 'meta', 'limit-up-ladder']),
  coverage: z.array(z.literal('CN_A_SHARES_SH_SZ')),
  operators: z.array(z.string().min(1)),
});

export const GetStrategyDslCatalogOutput = z.object({
  schemaVersion: z.literal(1),
  fields: z.array(StrategyDslCatalogFieldSchema),
  limits: z.object({
    selectionRules: z.number().int().positive().nullable(),
    scoringComponents: z.number().int().positive().nullable(),
    signalRulesPerScope: z.number().int().positive().nullable(),
  }),
});
export type StrategyDslCatalog = z.infer<typeof GetStrategyDslCatalogOutput>;

export const getStrategyDslCatalogTool = defineTool({
  name: 'get_strategy_dsl_catalog',
  description:
    '读取 Strategy DSL 字段注册表与现有安全表达式运算符；只描述白名单，不执行表达式或修改策略',
  sideEffect: 'read',
  input: GetStrategyDslCatalogInput,
  output: GetStrategyDslCatalogOutput,
  handler: async () => ({
    schemaVersion: 1 as const,
    fields: STRATEGY_FIELD_REGISTRY.map((field) => ({
      path: field.path,
      type: field.type,
      ...(field.unit === undefined ? {} : { unit: field.unit }),
      ...(field.requiredLookback === undefined ? {} : { requiredLookback: field.requiredLookback }),
      dataSource: field.dataSource,
      coverage: [...field.availableForCoverage],
      operators: [...STRATEGY_DSL_OPERATORS[field.type]],
    })),
    limits: {
      selectionRules: null,
      scoringComponents: null,
      signalRulesPerScope: null,
    },
  }),
});

const SignalObservationStatsSchema = z.object({
  group: z.string().min(1),
  horizon: ActiveSignalObservationHorizonSchema,
  total: z.number().int().nonnegative(),
  complete: z.number().int().nonnegative(),
  uniqueStocks: z.number().int().nonnegative(),
  missingRate: z.number().min(0).max(1),
  observationIds: z.array(z.string().min(1)),
  averageReturnPct: z.number().finite().optional(),
  medianReturnPct: z.number().finite().optional(),
  p25ReturnPct: z.number().finite().optional(),
  p75ReturnPct: z.number().finite().optional(),
  averageBenchmarkReturnPct: z.number().finite().optional(),
  averageExcessReturnPct: z.number().finite().optional(),
  averageMaxFavorableExcursionPct: z.number().finite().optional(),
  averageMaxAdverseExcursionPct: z.number().finite().optional(),
  observedAsOf: z.coerce.date().optional(),
});

const StrategyExperimentObservationLinkSchema = z.object({
  observationId: z.string().min(1),
  signalId: z.string().min(1),
  runId: z.string().min(1),
  stockId: z.string().min(1),
  strategyId: z.string().min(1),
  strategyVersionId: z.string().min(1),
  horizon: ActiveSignalObservationHorizonSchema,
});

const StrategyExperimentObservationHorizonSchema = z.object({
  horizon: ActiveSignalObservationHorizonSchema,
  total: z.number().int().nonnegative(),
  complete: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  unavailable: z.number().int().nonnegative(),
  untracked: z.number().int().nonnegative(),
  uniqueStocks: z.number().int().nonnegative(),
  missingRate: z.number().min(0).max(1),
  benchmarkComplete: z.number().int().nonnegative(),
  benchmarkTotal: z.number().int().nonnegative(),
  benchmarkCoverageRatio: z.number().min(0).max(1),
  observationIds: z.array(z.string().min(1)),
  observationLinks: z.array(StrategyExperimentObservationLinkSchema),
  averageReturnPct: z.number().finite().optional(),
  medianReturnPct: z.number().finite().optional(),
  p25ReturnPct: z.number().finite().optional(),
  p75ReturnPct: z.number().finite().optional(),
  averageBenchmarkReturnPct: z.number().finite().optional(),
  averageExcessReturnPct: z.number().finite().optional(),
  averageMaxFavorableExcursionPct: z.number().finite().optional(),
  averageMaxAdverseExcursionPct: z.number().finite().optional(),
  observedAsOf: z.coerce.date().optional(),
});

const StrategyExperimentObservationSetSchema = z.object({
  status: z.enum(['not-started', 'complete', 'partial', 'unavailable']),
  versionId: z.string().min(1).optional(),
  runIds: z.array(z.string().min(1)),
  horizons: z.array(StrategyExperimentObservationHorizonSchema),
  observationIds: z.array(z.string().min(1)),
  observationLinks: z.array(StrategyExperimentObservationLinkSchema),
  limitations: z.array(z.string().min(1)),
});

const StrategyExperimentEvaluatorIdentitySchema = z.object({
  version: z.string().min(1),
  codeHash: z.string().min(1).optional(),
  runIds: z.array(z.string().min(1)),
});

const StrategyExperimentEvidenceLayerSchema = z.object({
  id: z.enum(['trial', 'historical-evaluation', 'strict-backtest', 'signal-observation']),
  title: z.string().min(1),
  status: z.enum(['not-started', 'memory-only', 'running', 'complete', 'partial', 'unavailable']),
  persisted: z.boolean(),
  description: z.string().min(1),
});

const StrategyExperimentStarterTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  revision: z.number().int().positive(),
  definition: StrategyDslV1Schema,
  definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const GetStrategyExperimentContextInput = z.object({
  strategyId: z.string().min(1),
  baseVersionId: z.string().min(1).optional(),
  candidateVersionId: z.string().min(1).optional(),
  trainingSessionId: z.string().min(1).optional(),
  validationSessionId: z.string().min(1).optional(),
  observationHorizon: ActiveSignalObservationHorizonSchema.default('t5'),
});

const StrategyExperimentValidationSchema = z.object({
  session: StrategyEvaluationSessionSchema,
  days: z.array(StrategyEvaluationDaySchema),
  runIds: z.array(z.string().min(1)),
  vintageCoverageRatio: z.number().min(0).max(1),
  evaluatorIdentityStatus: z.enum(['consistent', 'mixed', 'unavailable']),
  evaluatorIdentities: z.array(StrategyExperimentEvaluatorIdentitySchema),
});

export const GetStrategyExperimentContextOutput = z.object({
  strategy: StrategySchema,
  baseVersion: StrategyVersionSchema.optional(),
  candidateVersion: StrategyVersionSchema.optional(),
  definitionDiff: StrategyDefinitionDiffSchema.optional(),
  versionState: z.object({
    candidatePersisted: z.boolean(),
    candidateValid: z.boolean(),
    candidatePublished: z.boolean(),
    parentMatchesBase: z.boolean(),
  }),
  validation: StrategyExperimentValidationSchema.optional(),
  observations: z.object({
    horizon: ActiveSignalObservationHorizonSchema,
    stats: z.array(SignalObservationStatsSchema),
    benchmarkCoverageRatio: z.number().min(0).max(1),
    observationIds: z.array(z.string().min(1)),
    horizons: z.array(StrategyExperimentObservationHorizonSchema),
    observationLinks: z.array(StrategyExperimentObservationLinkSchema),
  }),
  realObservations: StrategyExperimentObservationSetSchema,
  strictBacktests: z.array(StrictBacktestRunSchema),
  adaptivePersonality: AdaptivePersonalityAssessmentSchema.optional(),
  evidenceLayers: z.array(StrategyExperimentEvidenceLayerSchema),
  starterTemplate: StrategyExperimentStarterTemplateSchema,
  promotion: StrategyPromotionAssessmentSchema,
  limitations: z.array(z.string().min(1)),
});
export type StrategyExperimentContext = z.infer<typeof GetStrategyExperimentContextOutput>;

const MAX_EVALUATION_RUNS = 5000;
const MAX_OPERATIONAL_RUNS = 5000;
const MAX_STRICT_BACKTESTS = 100;
const OBSERVATION_QUERY_CHUNK = 400;
const MAX_OBSERVATIONS_PER_QUERY = 5000;
const EXPERIMENT_OBSERVATION_HORIZONS = ACTIVE_SIGNAL_OBSERVATION_HORIZONS;

const snapshotEvaluationSessionId = (snapshot: unknown): string | undefined => {
  if (typeof snapshot !== 'object' || snapshot === null) return undefined;
  const value = (snapshot as { readonly evaluationSessionId?: unknown }).evaluationSessionId;
  return typeof value === 'string' ? value : undefined;
};

const uniqueInOrder = (values: readonly string[]): string[] => [...new Set(values)];

const completeValidationDays = (days: readonly z.infer<typeof StrategyEvaluationDaySchema>[]) =>
  days.filter((day) => day.status === 'complete');

const vintageCoverageRatio = (
  days: readonly z.infer<typeof StrategyEvaluationDaySchema>[],
): number => {
  const completeDays = completeValidationDays(days);
  if (completeDays.length === 0) return 0;
  return (
    completeDays.filter((day) => day.vintageStatus === 'available').length / completeDays.length
  );
};

const runMatchesValidation = (
  run: StrategyRun,
  input: {
    readonly strategyId: string;
    readonly candidateVersionId: string;
    readonly validationSessionId: string;
    readonly runIds: ReadonlySet<string>;
  },
): boolean =>
  input.runIds.has(run.id) &&
  run.strategyId === input.strategyId &&
  run.strategyVersionId === input.candidateVersionId &&
  run.scope === 'evaluation' &&
  (run.status === 'complete' || run.status === 'partial') &&
  (() => {
    const snapshotSessionId = snapshotEvaluationSessionId(run.inputSnapshot);
    return snapshotSessionId === undefined || snapshotSessionId === input.validationSessionId;
  })();

const collectObservationsForRuns = async (input: {
  readonly runs: readonly StrategyRun[];
  readonly candidateVersionId: string;
  readonly strategyId: string;
  readonly horizons: readonly ActiveSignalObservationHorizon[];
  readonly sourceLabel: string;
  readonly ctx: ToolContext;
  readonly limitations: string[];
}): Promise<{
  readonly observations: readonly SignalObservation[];
  readonly signals: readonly StrategySignal[];
}> => {
  const runIdSet = new Set(input.runs.map((run) => run.id));
  const signals = (
    await Promise.all(input.runs.map((run) => input.ctx.repos.strategyRun.signalsByRun(run.id)))
  )
    .flat()
    .filter(
      (signal) =>
        signal.strategyId === input.strategyId &&
        signal.strategyVersionId === input.candidateVersionId &&
        runIdSet.has(signal.runId),
    );
  const signalStockById = new Map(signals.map((signal) => [signal.id, signal.stockId] as const));
  const sourceIds = [...new Set(signals.map((signal) => signal.id))].sort();
  const observationsById = new Map<string, SignalObservation>();
  for (let index = 0; index < sourceIds.length; index += OBSERVATION_QUERY_CHUNK) {
    const sourceIdChunk = sourceIds.slice(index, index + OBSERVATION_QUERY_CHUNK);
    const sourceIdSet = new Set(sourceIdChunk);
    const rows = await input.ctx.repos.signalObservation.list({
      sourceKind: 'strategy-signal',
      sourceIds: sourceIdChunk,
      horizons: input.horizons,
      limit: MAX_OBSERVATIONS_PER_QUERY,
    });
    if (rows.length >= MAX_OBSERVATIONS_PER_QUERY) {
      input.limitations.push(
        `SignalObservation 查询达到单批上限 ${MAX_OBSERVATIONS_PER_QUERY}，统计可能不完整。`,
      );
    }
    for (const row of rows) {
      if (
        row.sourceKind !== 'strategy-signal' ||
        !isActiveSignalObservationHorizon(row.horizon) ||
        !input.horizons.includes(row.horizon) ||
        !sourceIdSet.has(row.sourceId)
      ) {
        continue;
      }
      const signalStockId = signalStockById.get(row.sourceId);
      if (signalStockId === undefined) continue;
      if (row.stockId !== signalStockId) {
        input.limitations.push(
          `SignalObservation ${row.id} 的 stockId=${row.stockId} 与 StrategySignal ${row.sourceId} 的 stockId=${signalStockId} 不一致，已跳过。`,
        );
        continue;
      }
      observationsById.set(row.id, row);
    }
  }
  if (sourceIds.length > 0 && observationsById.size === 0) {
    input.limitations.push(
      `${input.sourceLabel} runs 有 StrategySignal，但当前 T+1/T+3/T+5 没有 observation 事实；这不是 0 收益。`,
    );
  }
  return { observations: [...observationsById.values()], signals };
};

const observationLink = (
  observation: SignalObservation,
  signalsById: ReadonlyMap<string, StrategySignal>,
): z.infer<typeof StrategyExperimentObservationLinkSchema> | undefined => {
  if (!isActiveSignalObservationHorizon(observation.horizon)) return undefined;
  const signal = signalsById.get(observation.sourceId);
  if (signal === undefined) return undefined;
  return {
    observationId: observation.id,
    signalId: signal.id,
    runId: signal.runId,
    stockId: signal.stockId,
    strategyId: signal.strategyId,
    strategyVersionId: signal.strategyVersionId,
    horizon: observation.horizon,
  };
};

const horizonSummary = (
  horizon: ActiveSignalObservationHorizon,
  observations: readonly SignalObservation[],
  signals: readonly StrategySignal[],
) => {
  const signalsById = new Map(signals.map((signal) => [signal.id, signal] as const));
  const sampled = deduplicateSignalObservations(
    observations.filter((observation) => observation.horizon === horizon),
  );
  const stats = aggregateSignalObservationStats(sampled).find((item) => item.horizon === horizon);
  const complete = sampled.filter((observation) => observation.status === 'complete');
  const pending = sampled.filter((observation) => observation.status === 'pending').length;
  const unavailable = sampled.filter((observation) => observation.status === 'unavailable').length;
  const benchmarkComplete = complete.filter(
    (observation) => observation.benchmarkStatus === 'complete',
  ).length;
  const expectedSampleKeys = new Set(
    signals.map(
      (signal) => `${signal.stockId}\0${signal.ts.toISOString().slice(0, 10)}\0${horizon}`,
    ),
  );
  const total = Math.max(expectedSampleKeys.size, sampled.length);
  const missing = total - complete.length;
  const untracked = Math.max(0, missing - pending - unavailable);
  const observationIds = sampled.map((observation) => observation.id).sort();
  const observationLinks = sampled
    .map((observation) => observationLink(observation, signalsById))
    .filter(
      (link): link is z.infer<typeof StrategyExperimentObservationLinkSchema> => link !== undefined,
    )
    .sort((left, right) => left.observationId.localeCompare(right.observationId));
  return {
    horizon,
    total,
    complete: complete.length,
    missing,
    pending,
    unavailable,
    untracked,
    uniqueStocks: new Set([
      ...sampled.map((observation) => observation.stockId),
      ...signals.map((signal) => signal.stockId),
    ]).size,
    missingRate: total === 0 ? 0 : missing / total,
    benchmarkComplete,
    benchmarkTotal: complete.length,
    benchmarkCoverageRatio: complete.length === 0 ? 0 : benchmarkComplete / complete.length,
    observationIds,
    observationLinks,
    ...(stats?.averageReturnPct === undefined ? {} : { averageReturnPct: stats.averageReturnPct }),
    ...(stats?.medianReturnPct === undefined ? {} : { medianReturnPct: stats.medianReturnPct }),
    ...(stats?.p25ReturnPct === undefined ? {} : { p25ReturnPct: stats.p25ReturnPct }),
    ...(stats?.p75ReturnPct === undefined ? {} : { p75ReturnPct: stats.p75ReturnPct }),
    ...(stats?.averageBenchmarkReturnPct === undefined
      ? {}
      : { averageBenchmarkReturnPct: stats.averageBenchmarkReturnPct }),
    ...(stats?.averageExcessReturnPct === undefined
      ? {}
      : { averageExcessReturnPct: stats.averageExcessReturnPct }),
    ...(stats?.averageMaxFavorableExcursionPct === undefined
      ? {}
      : { averageMaxFavorableExcursionPct: stats.averageMaxFavorableExcursionPct }),
    ...(stats?.averageMaxAdverseExcursionPct === undefined
      ? {}
      : { averageMaxAdverseExcursionPct: stats.averageMaxAdverseExcursionPct }),
    ...(stats?.observedAsOf === undefined ? {} : { observedAsOf: stats.observedAsOf }),
  };
};

const observationSummary = (
  observations: readonly SignalObservation[],
  signals: readonly StrategySignal[],
) => {
  const signalsById = new Map(signals.map((signal) => [signal.id, signal] as const));
  const horizons = EXPERIMENT_OBSERVATION_HORIZONS.map((horizon) =>
    horizonSummary(horizon, observations, signals),
  );
  const sampled = deduplicateSignalObservations(observations);
  const stats = aggregateSignalObservationStats(sampled).map((item) => ({
    ...item,
    horizon: ActiveSignalObservationHorizonSchema.parse(item.horizon),
  }));
  const complete = sampled.filter((observation) => observation.status === 'complete');
  const benchmarkAvailable = complete.filter(
    (observation) => observation.benchmarkStatus === 'complete',
  ).length;
  const observationIds = sampled.map((observation) => observation.id).sort();
  const observationLinks = sampled
    .map((observation) => observationLink(observation, signalsById))
    .filter(
      (link): link is z.infer<typeof StrategyExperimentObservationLinkSchema> => link !== undefined,
    )
    .sort((left, right) => left.observationId.localeCompare(right.observationId));
  return {
    sampled,
    stats,
    completeObservationCount: complete.length,
    benchmarkCoverageRatio: complete.length === 0 ? 0 : benchmarkAvailable / complete.length,
    observationIds,
    horizons,
    observationLinks,
  };
};

const buildFactReferences = (input: {
  readonly strategyId: string;
  readonly baseVersion?: StrategyVersion;
  readonly candidateVersion?: StrategyVersion;
  readonly validationSessionId?: string;
  readonly runIds: readonly string[];
  readonly observationIds: readonly string[];
  readonly strictBacktestIds?: readonly string[];
}): string[] => [
  `strategy:${input.strategyId}`,
  ...(input.baseVersion === undefined
    ? []
    : [
        `strategy-version:${input.baseVersion.id}`,
        `definition-hash:${input.baseVersion.definitionHash}`,
      ]),
  ...(input.candidateVersion === undefined
    ? []
    : [
        `strategy-version:${input.candidateVersion.id}`,
        `definition-hash:${input.candidateVersion.definitionHash}`,
      ]),
  ...(input.validationSessionId === undefined
    ? []
    : [`strategy-evaluation:${input.validationSessionId}`]),
  ...input.runIds.map((runId) => `strategy-run:${runId}`),
  ...input.observationIds.map((observationId) => `signal-observation:${observationId}`),
  ...(input.strictBacktestIds ?? []).map((runId) => `strict-backtest:${runId}`),
];

const snapshotField = (snapshot: unknown, key: string): unknown => {
  if (typeof snapshot !== 'object' || snapshot === null) return undefined;
  return (snapshot as Record<string, unknown>)[key];
};

const evaluatorIdentities = (runs: readonly StrategyRun[]) => {
  const identities = new Map<
    string,
    { readonly version: string; readonly codeHash?: string; readonly runIds: string[] }
  >();
  const missingEvaluatorVersionRunIds: string[] = [];
  for (const run of runs) {
    const version = snapshotField(run.inputSnapshot, 'evaluatorVersion');
    if (typeof version !== 'string' || version.length === 0) {
      missingEvaluatorVersionRunIds.push(run.id);
      continue;
    }
    const codeHash = snapshotField(run.inputSnapshot, 'evaluatorCodeIdentity');
    const normalizedCodeHash =
      typeof codeHash === 'string' && codeHash.length > 0 ? codeHash : undefined;
    const key = `${version}\0${normalizedCodeHash ?? ''}`;
    const previous = identities.get(key);
    if (previous === undefined) {
      identities.set(key, {
        version,
        ...(normalizedCodeHash === undefined ? {} : { codeHash: normalizedCodeHash }),
        runIds: [run.id],
      });
      continue;
    }
    previous.runIds.push(run.id);
  }
  const values = [...identities.values()].sort((left, right) =>
    `${left.version}\0${left.codeHash ?? ''}`.localeCompare(
      `${right.version}\0${right.codeHash ?? ''}`,
    ),
  );
  return {
    status:
      missingEvaluatorVersionRunIds.length > 0
        ? ('unavailable' as const)
        : values.length === 0
          ? ('unavailable' as const)
          : values.length === 1
            ? ('consistent' as const)
            : ('mixed' as const),
    identities: values,
    missingEvaluatorVersionRunIds,
  };
};

const observationSetStatus = (
  runs: readonly StrategyRun[],
  horizons: readonly z.infer<typeof StrategyExperimentObservationHorizonSchema>[],
): 'not-started' | 'complete' | 'partial' | 'unavailable' => {
  if (runs.length === 0) return 'unavailable';
  if (!horizons.some((horizon) => horizon.total > 0)) return 'unavailable';
  if (!horizons.some((horizon) => horizon.observationIds.length > 0)) return 'unavailable';
  return horizons.every((horizon) => horizon.complete === horizon.total) ? 'complete' : 'partial';
};

export const getStrategyExperimentContextTool = defineTool({
  name: 'get_strategy_experiment_context',
  description:
    '聚合 Strategy 基线/候选定义、历史 validation session、候选信号观察与确定性人工评审门禁；只读且不会执行 trial、发布或 Advice',
  sideEffect: 'read',
  input: GetStrategyExperimentContextInput,
  output: GetStrategyExperimentContextOutput,
  handler: async (input, ctx) => {
    const strategy = await ctx.repos.strategy.findById(input.strategyId);
    if (strategy === null) return errNotFound('Strategy', input.strategyId);

    const [versions, validationSession, requestedTrainingSession] = await Promise.all([
      ctx.repos.strategy.listVersions(strategy.id),
      input.validationSessionId === undefined
        ? Promise.resolve(null)
        : ctx.repos.strategyEvaluation.findSessionById(input.validationSessionId),
      input.trainingSessionId === undefined
        ? Promise.resolve(null)
        : ctx.repos.strategyEvaluation.findSessionById(input.trainingSessionId),
    ]);
    if (input.validationSessionId !== undefined && validationSession === null) {
      return errNotFound('StrategyEvaluationSession', input.validationSessionId);
    }
    if (validationSession !== null && validationSession.strategyId !== strategy.id) {
      return errInvalidInput('validation session 不属于请求中的 Strategy');
    }
    if (input.trainingSessionId !== undefined && requestedTrainingSession === null) {
      return errNotFound('StrategyEvaluationSession', input.trainingSessionId);
    }
    if (requestedTrainingSession !== null && requestedTrainingSession.strategyId !== strategy.id) {
      return errInvalidInput('training session 不属于请求中的 Strategy');
    }

    const resolveVersion = async (
      versionId: string | undefined,
      role: '基线' | '候选',
      explicit: boolean,
    ): Promise<
      StrategyVersion | null | ReturnType<typeof errInvalidInput> | ReturnType<typeof errNotFound>
    > => {
      if (versionId === undefined) return null;
      const version = await ctx.repos.strategy.findVersionById(versionId);
      if (version === null) {
        return explicit ? errNotFound('StrategyVersion', versionId) : null;
      }
      if (version.strategyId !== strategy.id) {
        return errInvalidInput(`${role}版本不属于该 Strategy`);
      }
      return version;
    };

    const baseResolution = await resolveVersion(
      input.baseVersionId ?? strategy.currentVersionId,
      '基线',
      input.baseVersionId !== undefined,
    );
    if (baseResolution !== null && 'ok' in baseResolution) return baseResolution;
    const baseVersion = baseResolution === null ? undefined : baseResolution;

    let defaultCandidate: StrategyVersion | undefined;
    if (input.candidateVersionId === undefined) {
      for (let index = versions.length - 1; index >= 0; index -= 1) {
        const version = versions[index];
        if (version !== undefined && version.publishedAt === undefined) {
          defaultCandidate = version;
          break;
        }
      }
    }
    const candidateResolution = await resolveVersion(
      input.candidateVersionId ?? defaultCandidate?.id,
      '候选',
      input.candidateVersionId !== undefined,
    );
    if (candidateResolution !== null && 'ok' in candidateResolution) return candidateResolution;
    const candidateVersion = candidateResolution === null ? undefined : candidateResolution;

    const limitations: string[] = [];
    if (baseVersion === undefined)
      limitations.push('当前 Strategy 没有可用的 current published 基线版本。');
    if (candidateVersion === undefined) {
      limitations.push(
        '当前 Strategy 没有可用的未发布候选版本；未查询 candidate evaluation signals。',
      );
    }

    let definitionDiff: z.infer<typeof StrategyDefinitionDiffSchema> | undefined;
    if (baseVersion !== undefined && candidateVersion !== undefined) {
      definitionDiff = {
        ...diffStrategyDefinitions(
          baseVersion.definition,
          candidateVersion.definition,
          baseVersion.definitionHash,
          candidateVersion.definitionHash,
        ),
      };
    }

    let validationDays: z.infer<typeof StrategyEvaluationDaySchema>[] = [];
    let validationRunIds: string[] = [];
    const candidateRuns: StrategyRun[] = [];
    let evaluationObservations: readonly SignalObservation[] = [];
    let evaluationSignals: readonly StrategySignal[] = [];
    if (validationSession !== null) {
      validationDays = [...(await ctx.repos.strategyEvaluation.listDays(validationSession.id))];
      if (candidateVersion !== undefined) {
        const dayRunIds = uniqueInOrder(
          validationDays
            .filter((day) => day.status === 'complete' && day.runId !== undefined)
            .map((day) => day.runId as string),
        );
        const runs = await ctx.repos.strategyRun.listRuns({
          strategyId: strategy.id,
          scope: 'evaluation',
          limit: MAX_EVALUATION_RUNS,
        });
        if (runs.length >= MAX_EVALUATION_RUNS) {
          limitations.push(
            `evaluation run 查询达到上限 ${MAX_EVALUATION_RUNS}，未能证明更早 run 已全部覆盖。`,
          );
        }
        const runById = new Map(runs.map((run) => [run.id, run] as const));
        const dayRunIdSet = new Set(dayRunIds);
        const unresolvedRunIds: string[] = [];
        for (const runId of dayRunIds) {
          const run = runById.get(runId);
          if (
            run === undefined ||
            !runMatchesValidation(run, {
              strategyId: strategy.id,
              candidateVersionId: candidateVersion.id,
              validationSessionId: validationSession.id,
              runIds: dayRunIdSet,
            })
          ) {
            unresolvedRunIds.push(runId);
            continue;
          }
          candidateRuns.push(run);
        }
        if (unresolvedRunIds.length > 0) {
          limitations.push(
            `validation session 有 ${unresolvedRunIds.length} 个 runId 未解析为候选 evaluation run，观察统计可能不完整。`,
          );
        }
        validationRunIds = uniqueInOrder(candidateRuns.map((run) => run.id));
        const collected = await collectObservationsForRuns({
          runs: candidateRuns,
          candidateVersionId: candidateVersion.id,
          strategyId: strategy.id,
          horizons: EXPERIMENT_OBSERVATION_HORIZONS,
          sourceLabel: 'candidate evaluation',
          ctx,
          limitations,
        });
        evaluationObservations = collected.observations;
        evaluationSignals = collected.signals;
      } else {
        limitations.push('validation session 已指定，但没有候选版本可用于筛选 evaluation run。');
      }
    } else {
      limitations.push('未指定 validation session；无法读取独立验证交易日、run 或观察事实。');
    }

    const summary = observationSummary(evaluationObservations, evaluationSignals);
    const selectedEvaluationObservations = evaluationObservations.filter(
      (observation) => observation.horizon === input.observationHorizon,
    );
    const selectedSummary = observationSummary(selectedEvaluationObservations, evaluationSignals);
    if (
      validationSession !== null &&
      candidateVersion !== undefined &&
      candidateRuns.length === 0
    ) {
      limitations.push('候选版本没有可采用的 validation run；complete observation 数量按 0 计。');
    }
    const validationVintageCoverageRatio = vintageCoverageRatio(validationDays);

    const evaluatorSummary = evaluatorIdentities(candidateRuns);
    if (candidateRuns.length > 0 && evaluatorSummary.missingEvaluatorVersionRunIds.length > 0) {
      limitations.push(
        `候选 evaluation run 中有 ${evaluatorSummary.missingEvaluatorVersionRunIds.length} 个 run 缺少 evaluatorVersion，无法确认所有 validation run 使用一致的求值器身份。`,
      );
    } else if (candidateRuns.length > 0 && evaluatorSummary.status === 'unavailable') {
      limitations.push(
        '候选 evaluation run 未携带 evaluator identity，无法在评审快照中确认求值器身份。',
      );
    } else if (evaluatorSummary.status === 'mixed') {
      limitations.push(
        '候选 evaluation run 使用了多个 evaluator identity；发布前需要人工确认是否可比。',
      );
    }

    const latestPublishedVersion = [...versions]
      .filter((version) => version.publishedAt !== undefined)
      .sort((left, right) => right.version - left.version)[0];
    const feedbackVersion =
      candidateVersion?.publishedAt !== undefined
        ? candidateVersion
        : baseVersion?.publishedAt !== undefined
          ? baseVersion
          : latestPublishedVersion;
    const realLimitations: string[] = [];
    let realRuns: StrategyRun[] = [];
    let realObservations: readonly SignalObservation[] = [];
    let realSignals: readonly StrategySignal[] = [];
    if (feedbackVersion === undefined) {
      realLimitations.push('没有已发布版本可用于读取生产日循环的 SignalObservation。');
    } else {
      const operationalRuns = await ctx.repos.strategyRun.listRuns({
        strategyId: strategy.id,
        scope: 'operational',
        limit: MAX_OPERATIONAL_RUNS,
      });
      if (operationalRuns.length >= MAX_OPERATIONAL_RUNS) {
        realLimitations.push(
          `operational run 查询达到上限 ${MAX_OPERATIONAL_RUNS}，生产反馈可能不完整。`,
        );
      }
      realRuns = operationalRuns.filter(
        (run) => run.strategyVersionId === feedbackVersion.id && isPublishableOperationalRun(run),
      );
      if (realRuns.length > 0) {
        const collected = await collectObservationsForRuns({
          runs: realRuns,
          candidateVersionId: feedbackVersion.id,
          strategyId: strategy.id,
          horizons: EXPERIMENT_OBSERVATION_HORIZONS,
          sourceLabel: 'published operational',
          ctx,
          limitations: realLimitations,
        });
        realObservations = collected.observations;
        realSignals = collected.signals;
      } else {
        realLimitations.push(
          `已发布版本 ${feedbackVersion.id} 尚无可读取的 production StrategyRun/SignalObservation；这不是 0 收益。`,
        );
      }
    }
    const realSummary = observationSummary(realObservations, realSignals);

    let strictBacktests: z.infer<typeof StrictBacktestRunSchema>[] = [];
    if (candidateVersion !== undefined) {
      const storedStrictBacktests = await ctx.repos.strategyBacktest.listRuns({
        strategyId: strategy.id,
        limit: MAX_STRICT_BACKTESTS,
      });
      strictBacktests = storedStrictBacktests
        .filter(
          (run) =>
            run.spec.strategyVersionId === candidateVersion.id &&
            (validationSession === null || run.spec.evaluationSessionId === validationSession.id),
        )
        .map((run) => StrictBacktestRunSchema.parse(run));
    }

    let trainingSession = requestedTrainingSession ?? undefined;
    if (trainingSession === undefined && candidateVersion !== undefined) {
      const inferredTrainingSessionId = (candidateVersion.factReferences ?? [])
        .map((reference) =>
          reference.startsWith('strategy-evaluation:')
            ? reference.slice('strategy-evaluation:'.length)
            : undefined,
        )
        .find((sessionId) => sessionId !== undefined && sessionId !== validationSession?.id);
      if (inferredTrainingSessionId !== undefined) {
        trainingSession =
          (await ctx.repos.strategyEvaluation.findSessionById(inferredTrainingSessionId)) ??
          undefined;
        if (trainingSession === undefined) {
          limitations.push(
            `候选版本引用的 training session ${inferredTrainingSessionId} 不存在，无法计算 adaptive personality add-on。`,
          );
        } else if (trainingSession.strategyId !== strategy.id) {
          limitations.push(
            '候选版本引用的 training session 不属于当前 Strategy，已不用于 adaptive personality。',
          );
          trainingSession = undefined;
        }
      }
    }

    let adaptivePersonality: z.infer<typeof AdaptivePersonalityAssessmentSchema> | undefined;
    if (
      candidateVersion !== undefined &&
      validationSession !== null &&
      trainingSession !== undefined
    ) {
      const [trainingDays] = await Promise.all([
        ctx.repos.strategyEvaluation.listDays(trainingSession.id),
      ]);
      const completeTrainingDays = completeValidationDays(trainingDays);
      const completeValidationDaysForAdaptive = completeValidationDays(validationDays);
      adaptivePersonality = assessAdaptivePersonality({
        parameterVersion: {
          strategyId: candidateVersion.strategyId,
          strategyVersionId: candidateVersion.id,
          definitionHash: candidateVersion.definitionHash,
          factReferences: candidateVersion.factReferences ?? [],
        },
        training: {
          sessionId: trainingSession.id,
          strategyId: trainingSession.strategyId,
          status: trainingSession.status,
          from: trainingSession.from,
          to: trainingSession.to,
          tradingDays: completeTrainingDays.length,
          vintageAvailableDays: completeTrainingDays.filter(
            (day) => day.vintageStatus === 'available',
          ).length,
        },
        validation: {
          sessionId: validationSession.id,
          strategyId: validationSession.strategyId,
          strategyVersionId: validationSession.strategyVersionId,
          status: validationSession.status,
          from: validationSession.from,
          to: validationSession.to,
          tradingDays: completeValidationDaysForAdaptive.length,
          vintageAvailableDays: completeValidationDaysForAdaptive.filter(
            (day) => day.vintageStatus === 'available',
          ).length,
          observationCount: selectedSummary.completeObservationCount,
          benchmarkAvailableCount: selectedSummary.sampled.filter(
            (observation) =>
              observation.status === 'complete' && observation.benchmarkStatus === 'complete',
          ).length,
        },
        policy: AdaptivePersonalityPolicySchema.parse({
          policyVersion: 'adaptive-personality-gate-v1',
        }),
      });
    } else if (candidateVersion !== undefined && validationSession !== null) {
      limitations.push(
        '未配置 training session；adaptive personality 只显示为未配置，不替代通用晋级门禁。',
      );
    }

    const factReferences = buildFactReferences({
      strategyId: strategy.id,
      ...(baseVersion === undefined ? {} : { baseVersion }),
      ...(candidateVersion === undefined ? {} : { candidateVersion }),
      ...(validationSession === null ? {} : { validationSessionId: validationSession.id }),
      runIds: validationRunIds,
      observationIds: summary.observationIds,
      strictBacktestIds: strictBacktests.map((run) => run.id),
    });
    const promotion = assessStrategyPromotion({
      ...(baseVersion === undefined ? {} : { baseVersion }),
      ...(candidateVersion === undefined ? {} : { candidateVersion }),
      ...(definitionDiff === undefined ? {} : { definitionDiff }),
      ...(validationSession === null
        ? {}
        : {
            validation: {
              sessionId: validationSession.id,
              strategyVersionId: validationSession.strategyVersionId,
              status: validationSession.status,
              tradingDays: completeValidationDays(validationDays).length,
              vintageCoverageRatio: validationVintageCoverageRatio,
            },
          }),
      observations: {
        completeObservationCount: selectedSummary.completeObservationCount,
        benchmarkCoverageRatio: selectedSummary.benchmarkCoverageRatio,
      },
      factReferences,
      limitations,
    });

    return {
      strategy,
      ...(baseVersion === undefined ? {} : { baseVersion }),
      ...(candidateVersion === undefined ? {} : { candidateVersion }),
      ...(definitionDiff === undefined ? {} : { definitionDiff }),
      versionState: {
        candidatePersisted: candidateVersion !== undefined,
        candidateValid: candidateVersion?.validationStatus === 'valid',
        candidatePublished: candidateVersion?.publishedAt !== undefined,
        parentMatchesBase:
          baseVersion !== undefined &&
          candidateVersion !== undefined &&
          candidateVersion.parentVersionId === baseVersion.id,
      },
      ...(validationSession === null
        ? {}
        : {
            validation: {
              session: validationSession,
              days: validationDays,
              runIds: validationRunIds,
              vintageCoverageRatio: validationVintageCoverageRatio,
              evaluatorIdentityStatus: evaluatorSummary.status,
              evaluatorIdentities: evaluatorSummary.identities,
            },
          }),
      observations: {
        horizon: input.observationHorizon,
        stats: selectedSummary.stats.map((item) => ({
          ...item,
          observationIds: [...item.observationIds],
        })),
        benchmarkCoverageRatio: selectedSummary.benchmarkCoverageRatio,
        observationIds: selectedSummary.observationIds,
        horizons: summary.horizons,
        observationLinks: summary.observationLinks,
      },
      realObservations: {
        status: observationSetStatus(realRuns, realSummary.horizons),
        ...(feedbackVersion === undefined ? {} : { versionId: feedbackVersion.id }),
        runIds: realRuns.map((run) => run.id),
        horizons: realSummary.horizons,
        observationIds: realSummary.observationIds,
        observationLinks: realSummary.observationLinks,
        limitations: realLimitations,
      },
      strictBacktests,
      ...(adaptivePersonality === undefined ? {} : { adaptivePersonality }),
      evidenceLayers: [
        {
          id: 'trial' as const,
          title: '样本 Trial',
          status: 'not-started' as const,
          persisted: false,
          description: '当前页面内存中的同样本对照；不会成为正式运行或晋级事实。',
        },
        {
          id: 'historical-evaluation' as const,
          title: '历史评估',
          status:
            validationSession === null
              ? ('not-started' as const)
              : validationSession.status === 'running'
                ? ('running' as const)
                : validationSession.status === 'complete'
                  ? ('complete' as const)
                  : validationSession.status === 'partial'
                    ? ('partial' as const)
                    : ('unavailable' as const),
          persisted: true,
          description: '逐交易日、版本化定义与 PIT 数据覆盖；不输出未来收益。',
        },
        {
          id: 'strict-backtest' as const,
          title: '严格回测',
          status:
            strictBacktests.length === 0
              ? ('not-started' as const)
              : strictBacktests.some((run) => run.status === 'queued' || run.status === 'running')
                ? ('running' as const)
                : strictBacktests.some((run) => run.resultAvailability === 'complete')
                  ? ('complete' as const)
                  : strictBacktests.some((run) => run.resultAvailability === 'partial')
                    ? ('partial' as const)
                    : ('unavailable' as const),
          persisted: true,
          description: '独立的 PIT、修订、费用、滑点、可交易性、公司行动、基准与求值器门禁。',
        },
        {
          id: 'signal-observation' as const,
          title: '真实 SignalObservation',
          status: observationSetStatus(candidateRuns, summary.horizons),
          persisted: true,
          description:
            '来自 StrategySignal 的 T+1/T+3/T+5 后续事实；pending/unavailable 不当作 0。',
        },
      ],
      starterTemplate: {
        id: EARLY_BREAKOUT_V2_DRAFT.id,
        name: EARLY_BREAKOUT_V2_DRAFT.name,
        description: EARLY_BREAKOUT_V2_DRAFT.description,
        revision: EARLY_BREAKOUT_V2_DRAFT.revision,
        definition: EARLY_BREAKOUT_V2_DRAFT.definition,
        definitionHash: EARLY_BREAKOUT_V2_DRAFT.definitionHash,
      },
      promotion,
      limitations: promotion.limitations,
    };
  },
});
