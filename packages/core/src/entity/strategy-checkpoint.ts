import { z } from 'zod';

import { StrategyProviderCoverageSchema } from './strategy.js';

export const StrategyDataCheckpointStatusSchema = z.enum([
  'running',
  'complete',
  'partial',
  'failed',
]);
export type StrategyDataCheckpointStatus = z.infer<typeof StrategyDataCheckpointStatusSchema>;
export const StrategyDataVintageStatusSchema = z.enum([
  'not-applicable',
  'available',
  'unavailable',
]);

export const StrategyDataCheckpointSchema = z
  .object({
    id: z.string().min(1),
    coverage: z.literal('CN_A_SHARES_SH_SZ'),
    dataAsOf: z.coerce.date(),
    status: StrategyDataCheckpointStatusSchema,
    vintageStatus: StrategyDataVintageStatusSchema.default('not-applicable'),
    universeSyncId: z.string().min(1),
    requestedCount: z.number().int().nonnegative(),
    availableCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    memberChecksum: z.string().min(1),
    dataChecksum: z.string().min(1),
    providerStatuses: z.array(StrategyProviderCoverageSchema),
    startedAt: z.coerce.date(),
    finishedAt: z.coerce.date().optional(),
  })
  .superRefine((checkpoint, ctx) => {
    if (checkpoint.availableCount + checkpoint.failedCount > checkpoint.requestedCount) {
      ctx.addIssue({
        code: 'custom',
        path: ['availableCount'],
        message: 'availableCount + failedCount 不能大于 requestedCount',
      });
    }
    if (
      checkpoint.status === 'complete' &&
      checkpoint.availableCount !== checkpoint.requestedCount
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'complete checkpoint 必须覆盖全部 requested stock',
      });
    }
  });
export type StrategyDataCheckpoint = z.infer<typeof StrategyDataCheckpointSchema>;

export const StrategyDataCheckpointMemberSchema = z.object({
  checkpointId: z.string().min(1),
  stockId: z.string().min(1),
  status: z.enum(['available', 'missing', 'failed']),
  latestBarDate: z.coerce.date().optional(),
  barCount: z.number().int().nonnegative(),
  provider: z.string().min(1).optional(),
  errorKind: z.string().min(1).optional(),
});
export type StrategyDataCheckpointMember = z.infer<typeof StrategyDataCheckpointMemberSchema>;

export const StrategyEvaluationSessionStatusSchema = z.enum([
  'running',
  'complete',
  'partial',
  'failed',
]);
export type StrategyEvaluationSessionStatus = z.infer<typeof StrategyEvaluationSessionStatusSchema>;

export const StrategyEvaluationSessionSchema = z
  .object({
    id: z.string().min(1),
    strategyId: z.string().min(1),
    strategyVersionId: z.string().min(1),
    from: z.coerce.date(),
    to: z.coerce.date(),
    status: StrategyEvaluationSessionStatusSchema,
    definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.coerce.date(),
    stockIds: z.array(z.string().min(1)).min(1).max(500).optional(),
    stockIdChecksum: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    finishedAt: z.coerce.date().optional(),
    error: z.string().min(1).optional(),
  })
  .superRefine((session, ctx) => {
    if ((session.stockIds === undefined) !== (session.stockIdChecksum === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['stockIds'],
        message: 'evaluation session 的 stockIds 与 stockIdChecksum 必须成对存在',
      });
    }
  });
export type StrategyEvaluationSession = z.infer<typeof StrategyEvaluationSessionSchema>;

export const StrategyEvaluationDaySchema = z.object({
  sessionId: z.string().min(1),
  dataAsOf: z.coerce.date(),
  runId: z.string().min(1).optional(),
  universeSyncId: z.string().min(1).optional(),
  dataCheckpointId: z.string().min(1).optional(),
  revisionCutoff: z.coerce.date().optional(),
  vintageStatus: StrategyDataVintageStatusSchema.optional(),
  status: z.enum(['running', 'complete', 'failed']),
  evaluatedCount: z.number().int().nonnegative().optional(),
  selectedCount: z.number().int().nonnegative().optional(),
  signalCount: z.number().int().nonnegative().optional(),
  failedCount: z.number().int().nonnegative().optional(),
  error: z.string().min(1).optional(),
});
export type StrategyEvaluationDay = z.infer<typeof StrategyEvaluationDaySchema>;

export const DailyBarRevisionSchema = z.object({
  stockId: z.string().min(1),
  date: z.coerce.date(),
  contentHash: z.string().min(1),
  open: z.number().finite(),
  high: z.number().finite(),
  low: z.number().finite(),
  close: z.number().finite(),
  volume: z.number().nonnegative(),
  source: z.string().min(1),
  recordedAt: z.coerce.date(),
});
export type DailyBarRevision = z.infer<typeof DailyBarRevisionSchema>;

export const StrategyResearchConclusionSchema = z.object({
  summary: z.string().trim().min(1).max(4000),
  outcome: z.enum(['supported', 'inconclusive', 'rejected']),
  limitations: z.array(z.string().trim().min(1).max(1000)).min(1).max(30),
  evidenceReferences: z.array(z.string().min(1).max(200)).max(100),
});
export type StrategyResearchConclusion = z.infer<typeof StrategyResearchConclusionSchema>;

export const StrategyResearchComparisonRecordSchema = z.object({
  origin: z.literal('user-recorded'),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  stockIdChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  dataAsOf: z.coerce.date(),
  mode: z.enum(['scan', 'replay']),
  baseVersionId: z.string().min(1),
  candidates: z
    .array(
      z.object({
        candidateVersionId: z.string().min(1),
        definitionHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        status: z.enum(['complete', 'failed']),
        dataHealth: z.enum(['complete', 'partial', 'unavailable']).optional(),
        selectedCount: z.number().int().nonnegative().optional(),
        missingCount: z.number().int().nonnegative().optional(),
        error: z.string().max(2000).optional(),
      }),
    )
    .min(1)
    .max(8),
  limitations: z.array(z.string().min(1).max(2000)).min(1).max(30),
});
export type StrategyResearchComparisonRecord = z.infer<
  typeof StrategyResearchComparisonRecordSchema
>;

export const StrategyResearchSettingsSchema = z
  .object({
    question: z.string().trim().min(1).max(2000),
    baseVersionId: z.string().min(1),
    candidateVersionId: z.string().min(1).optional(),
    stockIds: z.array(z.string().min(1)).min(1).max(500).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    benchmarkStockId: z.string().min(1).optional(),
    trainingSessionId: z.string().min(1).optional(),
    validationSessionId: z.string().min(1).optional(),
    nextStep: z.string().trim().min(1).max(2000).optional(),
    conclusion: StrategyResearchConclusionSchema.optional(),
    comparison: StrategyResearchComparisonRecordSchema.optional(),
  })
  .superRefine((state, ctx) => {
    if (
      (state.from === undefined) !== (state.to === undefined) ||
      (state.from !== undefined && state.to !== undefined && state.from > state.to)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['from'],
        message: '研究区间必须成对提供且 from 不晚于 to',
      });
    }
    if (state.comparison !== undefined && state.comparison.baseVersionId !== state.baseVersionId) {
      ctx.addIssue({
        code: 'custom',
        path: ['comparison', 'baseVersionId'],
        message: '比较记录必须绑定研究的固定基线',
      });
    }
  });
export type StrategyResearchSettings = z.infer<typeof StrategyResearchSettingsSchema>;

export const StrategyResearchStateSchema = z.object({
  strategyId: z.string().min(1),
  accountId: z.string().min(1),
  revision: z.number().int().positive(),
  requestId: z.string().min(1).max(100),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  state: StrategyResearchSettingsSchema,
  conclusions: z
    .array(
      z.object({
        revision: z.number().int().positive(),
        baseVersionId: z.string().min(1),
        candidateVersionId: z.string().min(1).optional(),
        recordedAt: z.coerce.date(),
        conclusion: StrategyResearchConclusionSchema,
      }),
    )
    .max(100),
  comparisons: z.array(StrategyResearchComparisonRecordSchema).max(100).optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type StrategyResearchState = z.infer<typeof StrategyResearchStateSchema>;
