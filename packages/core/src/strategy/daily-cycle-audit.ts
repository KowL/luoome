import { z } from 'zod';

import type { WorkflowRun, WorkflowRunStatus } from '../entity/workflow-run.js';
import { StrategyRecommendationPreflightSummarySchema } from './recommendation-preflight.js';

export const STRATEGY_DAILY_CYCLE_AUDIT_SCHEMA_VERSION = 1 as const;
export const STRATEGY_DAILY_CYCLE_WORKFLOW_NAME = 'strategy-daily-cycle' as const;

export const StrategyDailyCycleAuditPhaseSchema = z.enum([
  'claim',
  'data-prep',
  'run',
  'observations',
  'insight',
  'finish',
]);
export type StrategyDailyCycleAuditPhase = z.infer<typeof StrategyDailyCycleAuditPhaseSchema>;

export const StrategyDailyCycleAuditStatusSchema = z.enum([
  'complete',
  'partial',
  'skipped',
  'failed',
]);
export type StrategyDailyCycleAuditStatus = z.infer<typeof StrategyDailyCycleAuditStatusSchema>;

export const StrategyDailyCycleAuditInputSummarySchema = z.object({
  schemaVersion: z.literal(STRATEGY_DAILY_CYCLE_AUDIT_SCHEMA_VERSION),
  strategyId: z.string().min(1),
  scheduleId: z.string().min(1),
  dataAsOf: z.coerce.date(),
  requestedBy: z.enum(['scheduled', 'historical']),
});
export type StrategyDailyCycleAuditInputSummary = z.output<
  typeof StrategyDailyCycleAuditInputSummarySchema
>;

const StrategyDailyCyclePhaseTimingSchema = z.object({
  phase: StrategyDailyCycleAuditPhaseSchema,
  startedAt: z.coerce.date(),
  finishedAt: z.coerce.date().optional(),
  durationMs: z.number().finite().nonnegative().optional(),
});
const StrategyDailyCyclePhaseTimingProjectionSchema =
  StrategyDailyCyclePhaseTimingSchema.partial().extend({
    phase: StrategyDailyCycleAuditPhaseSchema,
  });

const StrategyDailyCycleCheckpointSchema = z.object({
  status: z.string().min(1),
  requestedCount: z.number().int().nonnegative(),
  availableCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  coverageRatio: z.number().finite().min(0).max(1),
  fallbackUsed: z.boolean(),
  providers: z.array(z.string().min(1)),
});

const StrategyDailyCycleObservationHorizonSchema = z.object({
  created: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative().optional(),
  scanned: z.number().int().nonnegative().optional(),
  completed: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
});

const StrategyDailyCycleObservationsSchema = z.object({
  created: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  scanned: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  baselines: z.object({
    available: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
    providers: z.record(z.string(), z.number().int().nonnegative()),
  }),
  byHorizon: z.record(z.string(), StrategyDailyCycleObservationHorizonSchema),
});

const StrategyDailyCycleWatchlistSyncSchema = z.object({
  status: z.enum(['complete', 'partial', 'failed', 'skipped']),
  complete: z.number().int().nonnegative().optional(),
  partial: z.number().int().nonnegative().optional(),
  failed: z.number().int().nonnegative().optional(),
  skipped: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
});

const StrategyDailyCycleUniverseSyncSchema = z.object({
  status: z.enum(['succeeded', 'skipped']),
  syncId: z.string().min(1),
  source: z.string().min(1),
  observedCount: z.number().int().nonnegative(),
  observedAt: z.coerce.date().optional(),
});

const StrategyDailyCycleBenchmarkSyncSchema = z.object({
  status: z.enum(['succeeded', 'partial', 'failed', 'skipped']),
  dataVersion: z.string().min(1),
  stockId: z.string().min(1),
  barCount: z.number().int().nonnegative().optional(),
  source: z.string().min(1).optional(),
  reason: z.string().optional(),
});

export const StrategyDailyCycleAuditOutputSummarySchema = z.object({
  schemaVersion: z.literal(STRATEGY_DAILY_CYCLE_AUDIT_SCHEMA_VERSION),
  status: StrategyDailyCycleAuditStatusSchema,
  phase: StrategyDailyCycleAuditPhaseSchema,
  runId: z.string().min(1).optional(),
  checkpointId: z.string().min(1).optional(),
  publication: z.string().min(1).optional(),
  summary: z.record(z.string(), z.unknown()).optional(),
  insightProvider: z.string().min(1).optional(),
  watchlistSync: StrategyDailyCycleWatchlistSyncSchema.optional(),
  adviceCount: z.number().int().nonnegative().optional(),
  notificationFailed: z.number().int().nonnegative().optional(),
  preflight: StrategyRecommendationPreflightSummarySchema.optional(),
  leaseRenewals: z.number().int().nonnegative(),
  checkpoint: StrategyDailyCycleCheckpointSchema.optional(),
  dataPreparationPerformance: z.record(z.string(), z.unknown()).optional(),
  universeSync: StrategyDailyCycleUniverseSyncSchema.optional(),
  observations: StrategyDailyCycleObservationsSchema.optional(),
  benchmarkSync: StrategyDailyCycleBenchmarkSyncSchema.optional(),
  phaseTimings: z.array(StrategyDailyCyclePhaseTimingSchema),
});
export type StrategyDailyCycleAuditOutputSummary = z.output<
  typeof StrategyDailyCycleAuditOutputSummarySchema
>;

const StrategyDailyCycleCheckpointProjectionSchema = StrategyDailyCycleCheckpointSchema.partial();
const StrategyDailyCycleObservationsProjectionSchema =
  StrategyDailyCycleObservationsSchema.partial();

export type StrategyDailyCycleAuditPreflight =
  | {
      readonly state: 'available';
      readonly snapshot: z.output<typeof StrategyRecommendationPreflightSummarySchema>;
    }
  | { readonly state: 'missing' }
  | { readonly state: 'corrupt' };

export interface StrategyDailyCycleAudit {
  readonly run: WorkflowRun;
  readonly format: 'v1' | 'legacy' | 'unsupported';
  readonly schemaVersion?: number;
  readonly strategyId?: string;
  readonly scheduleId?: string;
  readonly dataAsOf: Date;
  readonly dataAsOfSource: 'summary' | 'startedAt';
  readonly requestedBy?: 'scheduled' | 'historical';
  readonly cycleStatus?: StrategyDailyCycleAuditStatus;
  readonly phase?: StrategyDailyCycleAuditPhase;
  readonly publication?: string;
  readonly insightProvider?: string;
  readonly leaseRenewals?: number;
  readonly notificationFailed?: number;
  readonly reconciliation?: 'stale_workflow_run_reconciled';
  readonly reason?: string;
  readonly checkpoint?: z.output<typeof StrategyDailyCycleCheckpointProjectionSchema>;
  readonly observations?: z.output<typeof StrategyDailyCycleObservationsProjectionSchema>;
  readonly phaseTimings: readonly z.output<typeof StrategyDailyCyclePhaseTimingProjectionSchema>[];
  readonly preflight: StrategyDailyCycleAuditPreflight;
}

export interface StrategyDailyCycleAuditQuery {
  readonly strategyId?: string;
  readonly scheduleId?: string;
  /** dataAsOf 范围；旧记录缺失 dataAsOf 时回退 startedAt。 */
  readonly since?: Date;
  readonly until?: Date;
  readonly statuses?: readonly WorkflowRunStatus[];
  readonly limit?: number;
  readonly offset?: number;
}

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const optionalValue = <T>(schema: z.ZodType<T>, value: unknown): T | undefined => {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const optionalDate = (value: unknown): Date | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  return optionalValue(z.coerce.date(), value);
};

const auditFormat = (
  inputSummary: Record<string, unknown> | undefined,
  outputSummary: Record<string, unknown> | undefined,
): Pick<StrategyDailyCycleAudit, 'format' | 'schemaVersion'> => {
  const versions = [inputSummary?.schemaVersion, outputSummary?.schemaVersion].filter(
    (value): value is number => typeof value === 'number' && Number.isInteger(value),
  );
  if (versions.length === 0) return { format: 'legacy' };
  if (versions.every((version) => version === STRATEGY_DAILY_CYCLE_AUDIT_SCHEMA_VERSION)) {
    return { format: 'v1', schemaVersion: STRATEGY_DAILY_CYCLE_AUDIT_SCHEMA_VERSION };
  }
  return {
    format: 'unsupported',
    schemaVersion:
      versions.find((version) => version !== STRATEGY_DAILY_CYCLE_AUDIT_SCHEMA_VERSION) ??
      (versions[0] as number),
  };
};

export const createStrategyDailyCycleAuditInputSummary = (
  input: Omit<StrategyDailyCycleAuditInputSummary, 'schemaVersion'>,
): StrategyDailyCycleAuditInputSummary =>
  StrategyDailyCycleAuditInputSummarySchema.parse({
    schemaVersion: STRATEGY_DAILY_CYCLE_AUDIT_SCHEMA_VERSION,
    ...input,
  });

export const createStrategyDailyCycleAuditOutputSummary = (
  output: Omit<StrategyDailyCycleAuditOutputSummary, 'schemaVersion'>,
): StrategyDailyCycleAuditOutputSummary =>
  StrategyDailyCycleAuditOutputSummarySchema.parse({
    schemaVersion: STRATEGY_DAILY_CYCLE_AUDIT_SCHEMA_VERSION,
    ...output,
  });

/**
 * 把 WorkflowRun 的开放 JSON 边界解码成稳定的 Strategy daily-cycle 读模型。
 * 每个可选组件独立校验，避免一个损坏的旧字段遮蔽同一记录内仍可审计的事实。
 */
export const decodeStrategyDailyCycleAudit = (
  run: WorkflowRun,
): StrategyDailyCycleAudit | undefined => {
  if (run.workflowName !== STRATEGY_DAILY_CYCLE_WORKFLOW_NAME) return undefined;
  const inputSummary = recordValue(run.inputSummary);
  const outputSummary = recordValue(run.outputSummary);
  const explicitDataAsOf = optionalDate(inputSummary?.dataAsOf);
  const requestedBy = optionalValue(z.enum(['scheduled', 'historical']), inputSummary?.requestedBy);
  const strategyId = optionalValue(z.string().min(1), inputSummary?.strategyId);
  const scheduleId = optionalValue(z.string().min(1), inputSummary?.scheduleId);
  const cycleStatus = optionalValue(StrategyDailyCycleAuditStatusSchema, outputSummary?.status);
  const phase = optionalValue(StrategyDailyCycleAuditPhaseSchema, outputSummary?.phase);
  const publication = optionalValue(z.string().min(1), outputSummary?.publication);
  const insightProvider = optionalValue(z.string().min(1), outputSummary?.insightProvider);
  const leaseRenewals = optionalValue(z.number().int().nonnegative(), outputSummary?.leaseRenewals);
  const notificationFailed = optionalValue(
    z.number().int().nonnegative(),
    outputSummary?.notificationFailed,
  );
  const reason = optionalValue(z.string().min(1), outputSummary?.reason) ?? run.error;
  const checkpoint = optionalValue(
    StrategyDailyCycleCheckpointProjectionSchema,
    outputSummary?.checkpoint,
  );
  const observations = optionalValue(
    StrategyDailyCycleObservationsProjectionSchema,
    outputSummary?.observations,
  );
  const rawPreflight = outputSummary?.preflight;
  const parsedPreflight = StrategyRecommendationPreflightSummarySchema.safeParse(rawPreflight);
  const preflight: StrategyDailyCycleAuditPreflight =
    rawPreflight === undefined
      ? { state: 'missing' }
      : parsedPreflight.success
        ? { state: 'available', snapshot: parsedPreflight.data }
        : { state: 'corrupt' };
  return {
    run,
    ...auditFormat(inputSummary, outputSummary),
    ...(strategyId === undefined ? {} : { strategyId }),
    ...(scheduleId === undefined ? {} : { scheduleId }),
    dataAsOf: explicitDataAsOf ?? run.startedAt,
    dataAsOfSource: explicitDataAsOf === undefined ? 'startedAt' : 'summary',
    ...(requestedBy === undefined ? {} : { requestedBy }),
    ...(cycleStatus === undefined ? {} : { cycleStatus }),
    ...(phase === undefined ? {} : { phase }),
    ...(publication === undefined ? {} : { publication }),
    ...(insightProvider === undefined ? {} : { insightProvider }),
    ...(leaseRenewals === undefined ? {} : { leaseRenewals }),
    ...(notificationFailed === undefined ? {} : { notificationFailed }),
    ...(outputSummary?.reconciliation === 'stale_workflow_run_reconciled'
      ? { reconciliation: 'stale_workflow_run_reconciled' as const }
      : {}),
    ...(reason === undefined ? {} : { reason }),
    ...(checkpoint === undefined ? {} : { checkpoint }),
    ...(observations === undefined ? {} : { observations }),
    phaseTimings:
      optionalValue(
        z.array(StrategyDailyCyclePhaseTimingProjectionSchema),
        outputSummary?.phaseTimings,
      ) ?? [],
    preflight,
  };
};

export const isHistoricalStrategyDailyCycleAudit = (audit: StrategyDailyCycleAudit): boolean => {
  if (audit.requestedBy === 'historical') return true;
  return (
    audit.dataAsOfSource === 'summary' &&
    audit.run.startedAt.getTime() - audit.dataAsOf.getTime() > 24 * 60 * 60_000
  );
};

export const isProductionStrategyDailyCycleAudit = (audit: StrategyDailyCycleAudit): boolean =>
  audit.reconciliation !== 'stale_workflow_run_reconciled' &&
  audit.cycleStatus !== 'skipped' &&
  !isHistoricalStrategyDailyCycleAudit(audit);

export const StrategyDailyCycleAuditModule = Object.freeze({
  createInputSummary: createStrategyDailyCycleAuditInputSummary,
  createOutputSummary: createStrategyDailyCycleAuditOutputSummary,
  decode: decodeStrategyDailyCycleAudit,
  isHistorical: isHistoricalStrategyDailyCycleAudit,
  isProduction: isProductionStrategyDailyCycleAudit,
});
