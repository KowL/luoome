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

/**
 * evaluation session 的 provenance：创建它的那条轨。
 *
 * - `backfill`：回溯轨（backfill-strategy-observations）逐日 replay，观察口径恒为 restated；
 * - `prospective`：前瞻轨（autonomy 验证 session）推进，观察口径恒为 pit。
 *
 * 为什么需要它：`StrategyRun.scope` 对两条轨都是 `evaluation`，区分不出 pit / restated；
 * 而平静日（有评分横截面、零信号）根本没有观察可判 vintage——于是「贴不上标签」被当成
 * 「算不出来」，把本来能算的 IC 样本丢掉了。存量 session 无该字段 = provenance 未知，
 * 消费方必须退回观察判定，**不得**默认成任一口径（H8：restated 不得冒充 pit）。
 */
export const StrategyEvaluationSessionOriginSchema = z.enum(['backfill', 'prospective']);
export type StrategyEvaluationSessionOrigin = z.infer<typeof StrategyEvaluationSessionOriginSchema>;

/**
 * session provenance → 该 session 逐日 replay 产出的**评分横截面**口径。
 *
 * 映射放在 core 而不是各消费方：provenance 是事实（谁创建了 session），vintage 是口径
 * 判断，两者分开后，新增来源轨时必须显式在这里给出口径，而不是被某个 surface 静默默认。
 * 未知 provenance 返回 undefined，由调用方退回观察判定。
 */
export const strategyEvaluationSessionVintage = (
  origin: StrategyEvaluationSessionOrigin | undefined,
): 'pit' | 'restated' | undefined =>
  origin === undefined ? undefined : origin === 'backfill' ? 'restated' : 'pit';

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
    /**
     * 创建期 provenance：只有创建方给值；resume/finish/cancel 都以原值回写，不重新推断。
     * 缺省 = 未知（存量 session 或不属于两条轨的入口），消费方必须退回观察判定。
     */
    origin: StrategyEvaluationSessionOriginSchema.optional(),
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
        /**
         * 来源复盘 id（REQ-M4-03）。**可选**。
         *
         * ## 为什么可选（裁定 B）
         *
         * 研究面板直存的研究**不来自复盘**（用户直接问「提高门槛后样本是否变化？」）。
         * 强制必填会逼前端编一个 id —— 得到「看起来有来源、实际是编的」数据，
         * **比没有来源更危险**：追溯链看起来完整，实际是假的。
         *
         * PRD 说的是「**可读**」= 有就一定读得出来，不是「必须每条都有」。
         * 强制只加在真正的入口上：`propose_review_revision` 那边是必填。
         */
        sourceReviewId: z.string().min(1).optional(),
        /**
         * 该结论引用的事实 id（复用 M4-02 的 `factIds` 结构，**不是自由文本**）。
         */
        factIds: z.array(z.string().min(1)).min(1),
      }),
    )
    .max(100),
  comparisons: z.array(StrategyResearchComparisonRecordSchema).max(100).optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type StrategyResearchState = z.infer<typeof StrategyResearchStateSchema>;
