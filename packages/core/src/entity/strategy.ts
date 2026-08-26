import { createHash } from 'node:crypto';

import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { assertStrategySelectionPolicy } from '../strategy-watchlist-policy.js';
import { ProviderLatencySchema, ProviderStatusSchema } from './workflow-run.js';

const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/);

export const StrategyStatusSchema = z.enum(['draft', 'active', 'paused', 'archived']);
export const StrategyOwnerSchema = z.enum(['builtin', 'user']);

export const StrategySchema = z.object({
  id: SlugSchema,
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(1000),
  owner: StrategyOwnerSchema,
  status: StrategyStatusSchema,
  currentVersionId: z.string().min(1).optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Strategy = z.infer<typeof StrategySchema>;

export const StrategyRuleSchema = z.object({
  id: SlugSchema,
  name: z.string().min(1).max(80),
  when: z.string().min(1).max(1000),
  evidence: z.array(z.string().min(1).max(300)).min(1).max(8),
});
export type StrategyRule = z.infer<typeof StrategyRuleSchema>;

export const StrategySignalRuleSchema = StrategyRuleSchema.extend({
  score: z.string().min(1).max(1000),
  direction: z.enum(['bullish', 'bearish', 'neutral']),
  /** v2 信号去重语义；旧版本缺省为 level，保持已发布定义可读且不被重写。 */
  emission: z
    .object({
      mode: z.enum(['level', 'edge']).default('level'),
      cooldownTradingDays: z.number().int().min(0).max(60).default(0),
    })
    .optional(),
});
export type StrategySignalRule = z.infer<typeof StrategySignalRuleSchema>;

export const StrategySignalEmissionSchema = z.object({
  mode: z.enum(['level', 'edge']).default('level'),
  cooldownTradingDays: z.number().int().min(0).max(60).default(0),
});
export type StrategySignalEmission = z.infer<typeof StrategySignalEmissionSchema>;

export const getStrategySignalEmission = (
  rule: Pick<StrategySignalRule, 'emission'>,
): StrategySignalEmission => StrategySignalEmissionSchema.parse(rule.emission ?? {});

export const StrategyScoringSchema = z.object({
  method: z.literal('weighted-sum'),
  components: z
    .array(
      z.object({
        ruleId: z.string().min(1),
        score: z.string().min(1).max(1000),
        weight: z.number().positive().max(1),
      }),
    )
    .min(1),
  top: z.number().int().positive().max(500).optional(),
});
export type StrategyScoring = z.infer<typeof StrategyScoringSchema>;

export const StrategyDslV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    metadata: z.object({
      style: z.string().max(64).optional(),
      horizon: z.enum(['intraday', 'short', 'medium', 'long']).optional(),
    }),
    universe: z.object({
      coverage: z.literal('CN_A_SHARES_SH_SZ'),
      includeStockIds: z.array(z.string().min(1)).optional(),
      excludeStockIds: z.array(z.string().min(1)).default([]),
    }),
    selection: z.object({
      logic: z.enum(['all', 'any']).default('all'),
      rules: z.array(StrategyRuleSchema).default([]),
    }),
    scoring: StrategyScoringSchema.optional(),
    signals: z.object({
      entry: z.array(StrategySignalRuleSchema).default([]),
      exit: z.array(StrategySignalRuleSchema).default([]),
      risk: z.array(StrategySignalRuleSchema).default([]),
    }),
  })
  .superRefine((definition, ctx) => {
    if (definition.scoring !== undefined) {
      const total = definition.scoring.components.reduce(
        (sum, component) => sum + component.weight,
        0,
      );
      if (Math.abs(total - 1) > 1e-9) {
        ctx.addIssue({
          code: 'custom',
          path: ['scoring', 'components'],
          message: 'scoring 权重之和必须等于 1',
        });
      }
      const selectionIds = new Set(definition.selection.rules.map((rule) => rule.id));
      for (const [index, component] of definition.scoring.components.entries()) {
        if (!selectionIds.has(component.ruleId)) {
          ctx.addIssue({
            code: 'custom',
            path: ['scoring', 'components', index, 'ruleId'],
            message: 'scoring component.ruleId 必须引用 selection rule',
          });
        }
      }
    }
  });
export type StrategyDslV1 = z.infer<typeof StrategyDslV1Schema>;

export const StrategyVersionSchema = z.object({
  id: z.string().min(1),
  strategyId: z.string().min(1),
  version: z.number().int().positive(),
  definition: StrategyDslV1Schema,
  definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
  parentVersionId: z.string().min(1).optional(),
  changeSummary: z.string().max(500).optional(),
  /** AI 草案审计：只保存事实标识，不保存完整研究正文。 */
  factReferences: z.array(z.string().min(1).max(200)).max(50).optional(),
  /** AI / agent 工具轨迹；输入输出保留为不透明 JSON，受数量上限约束。 */
  agentTrace: z
    .array(
      z.object({
        toolName: z.string().min(1),
        input: z.unknown(),
        output: z.unknown(),
        ok: z.boolean(),
        durationMs: z.number().nonnegative(),
      }),
    )
    .max(100)
    .optional(),
  validationStatus: z.enum(['pending', 'valid', 'invalid']),
  validationErrors: z.array(z.string()).default([]),
  publishedAt: z.coerce.date().optional(),
  createdAt: z.coerce.date(),
});
export type StrategyVersion = z.infer<typeof StrategyVersionSchema>;

export const StrategyRunInputSnapshotV2Schema = z.object({
  schemaVersion: z.literal(2),
  strategyVersionId: z.string().min(1),
  definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
  evaluatorVersion: z.string().min(1),
  coverage: z.literal('CN_A_SHARES_SH_SZ'),
  stockIds: z.array(z.string().min(1)),
  stockIdChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  requestedBy: z.enum(['manual', 'scheduled', 'replay']),
  universeCheckpoint: z
    .object({
      provider: z.string().min(1),
      syncedAt: z.coerce.date(),
    })
    .optional(),
});
export type StrategyRunInputSnapshotV2 = z.infer<typeof StrategyRunInputSnapshotV2Schema>;

export const StrategyRunSummaryV2Schema = z.object({
  schemaVersion: z.literal(2),
  universeCount: z.number().int().nonnegative(),
  evaluatedCount: z.number().int().nonnegative(),
  selectedCount: z.number().int().nonnegative(),
  signalCount: z.number().int().nonnegative(),
  partialCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  failureSamples: z
    .array(z.object({ stockId: z.string().min(1), error: z.string().min(1) }))
    .max(20)
    .default([]),
});
export type StrategyRunSummaryV2 = z.infer<typeof StrategyRunSummaryV2Schema>;

export const StrategyRunDataHealthSchema = z.enum(['complete', 'partial', 'unavailable']);
export type StrategyRunDataHealth = z.infer<typeof StrategyRunDataHealthSchema>;

export const StrategyRunScopeSchema = z.enum(['operational', 'evaluation']);
export type StrategyRunScope = z.infer<typeof StrategyRunScopeSchema>;

export const StrategyRunUniverseKindSchema = z.enum(['full', 'explicit']);
export type StrategyRunUniverseKind = z.infer<typeof StrategyRunUniverseKindSchema>;

export const StrategyRunPrefilterSchema = z.object({
  mode: z.literal('quote-selection-safe'),
  originalStockCount: z.number().int().nonnegative(),
  originalStockIdChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  appliedRuleIds: z.array(z.string().min(1)),
  skippedRuleIds: z.array(z.string().min(1)),
  rejectedCount: z.number().int().nonnegative(),
  unavailableCount: z.number().int().nonnegative(),
});
export type StrategyRunPrefilter = z.infer<typeof StrategyRunPrefilterSchema>;

export const StrategyRunAcceptancePolicySchema = z.object({
  policyVersion: z.literal('strategy-run-acceptance-v1'),
  minEvaluatedRatio: z.number().min(0).max(1),
  maxFailedRatio: z.number().min(0).max(1),
  maxIncompleteRatio: z.number().min(0).max(1),
});
export type StrategyRunAcceptancePolicy = z.infer<typeof StrategyRunAcceptancePolicySchema>;

export const DEFAULT_STRATEGY_RUN_ACCEPTANCE_POLICY: StrategyRunAcceptancePolicy = {
  policyVersion: 'strategy-run-acceptance-v1',
  minEvaluatedRatio: 0.9,
  maxFailedRatio: 0.1,
  maxIncompleteRatio: 0.1,
};

export const StrategyRunAcceptanceReasonSchema = z.enum([
  'run-not-complete',
  'empty-universe',
  'evaluated-ratio-below-min',
  'failed-ratio-above-max',
  'incomplete-ratio-above-max',
]);
export type StrategyRunAcceptanceReason = z.infer<typeof StrategyRunAcceptanceReasonSchema>;

export const StrategyRunAcceptanceSchema = z.object({
  decision: z.enum(['accepted', 'rejected']),
  policy: StrategyRunAcceptancePolicySchema,
  metrics: z.object({
    evaluatedRatio: z.number().min(0).max(1),
    failedRatio: z.number().min(0).max(1),
    incompleteRatio: z.number().min(0).max(1),
  }),
  reasons: z.array(StrategyRunAcceptanceReasonSchema),
  assessedAt: z.coerce.date(),
});
export type StrategyRunAcceptance = z.infer<typeof StrategyRunAcceptanceSchema>;

export const StrategyRunPublicationStatusSchema = z.enum([
  'published',
  'withheld',
  'non-publishing',
]);
export type StrategyRunPublicationStatus = z.infer<typeof StrategyRunPublicationStatusSchema>;

export const StrategyRunPublicationReasonSchema = z.enum([
  'evaluation-scope',
  'explicit-subset',
  'acceptance-rejected',
  'run-not-complete',
  'universe-checkpoint-missing',
  'legacy-publication',
]);
export type StrategyRunPublicationReason = z.infer<typeof StrategyRunPublicationReasonSchema>;

export const StrategyRunPublicationSchema = z.object({
  status: StrategyRunPublicationStatusSchema,
  reasons: z.array(StrategyRunPublicationReasonSchema),
  decidedAt: z.coerce.date(),
});
export type StrategyRunPublication = z.infer<typeof StrategyRunPublicationSchema>;

export const StrategyProviderCoverageSchema = z.object({
  capability: z.enum(['quote', 'daily-bars', 'universe', 'limit-up-ladder']),
  provider: z.string().min(1),
  requested: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  fallbackUsed: z.boolean(),
  freshness: z.enum(['fresh', 'stale', 'unavailable']),
  dataAsOf: z.coerce.date().optional(),
  errorKinds: z.array(z.string()).max(20),
  latencyMs: ProviderLatencySchema.optional(),
});
export type StrategyProviderCoverage = z.infer<typeof StrategyProviderCoverageSchema>;

const strategyRunSummaryCounts = (
  summary: {
    readonly universeCount: number;
    readonly evaluatedCount: number;
    readonly selectedCount: number;
    readonly incompleteCount: number;
    readonly failedCount: number;
  },
  ctx: z.RefinementCtx,
): void => {
  if (summary.evaluatedCount + summary.failedCount !== summary.universeCount) {
    ctx.addIssue({
      code: 'custom',
      path: ['evaluatedCount'],
      message: 'evaluatedCount + failedCount 必须等于 universeCount',
    });
  }
  if (summary.selectedCount > summary.evaluatedCount) {
    ctx.addIssue({
      code: 'custom',
      path: ['selectedCount'],
      message: 'selectedCount 不能大于 evaluatedCount',
    });
  }
  if (summary.incompleteCount > summary.evaluatedCount) {
    ctx.addIssue({
      code: 'custom',
      path: ['incompleteCount'],
      message: 'incompleteCount 不能大于 evaluatedCount',
    });
  }
};

export const StrategyRunSummaryV4Schema = z
  .object({
    schemaVersion: z.literal(4),
    dataHealth: StrategyRunDataHealthSchema,
    universeCount: z.number().int().nonnegative(),
    evaluatedCount: z.number().int().nonnegative(),
    selectedCount: z.number().int().nonnegative(),
    signalCount: z.number().int().nonnegative(),
    incompleteCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    failureSamples: z
      .array(z.object({ stockId: z.string().min(1), error: z.string().min(1) }))
      .max(20)
      .default([]),
    acceptance: StrategyRunAcceptanceSchema,
  })
  .superRefine((summary, ctx) => {
    strategyRunSummaryCounts(summary, ctx);
    const expectedHealth =
      summary.failedCount === summary.universeCount && summary.universeCount > 0
        ? 'unavailable'
        : summary.failedCount > 0 || summary.incompleteCount > 0
          ? 'partial'
          : 'complete';
    if (summary.dataHealth !== expectedHealth) {
      ctx.addIssue({
        code: 'custom',
        path: ['dataHealth'],
        message: `dataHealth 应为 ${expectedHealth}`,
      });
    }
  });
export type StrategyRunSummaryV4 = z.infer<typeof StrategyRunSummaryV4Schema>;

export const StrategyRunSummaryV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    dataHealth: StrategyRunDataHealthSchema,
    universeCount: z.number().int().nonnegative(),
    evaluatedCount: z.number().int().nonnegative(),
    selectedCount: z.number().int().nonnegative(),
    signalCount: z.number().int().nonnegative(),
    incompleteCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    failureSamples: z
      .array(z.object({ stockId: z.string().min(1), error: z.string().min(1) }))
      .max(20)
      .default([]),
  })
  .superRefine((summary, ctx) => {
    strategyRunSummaryCounts(summary, ctx);
    const expectedHealth =
      summary.failedCount === summary.universeCount && summary.universeCount > 0
        ? 'unavailable'
        : summary.failedCount > 0 || summary.incompleteCount > 0
          ? 'partial'
          : 'complete';
    if (summary.dataHealth !== expectedHealth) {
      ctx.addIssue({
        code: 'custom',
        path: ['dataHealth'],
        message: `dataHealth 应为 ${expectedHealth}`,
      });
    }
  });
export type StrategyRunSummaryV3 = z.infer<typeof StrategyRunSummaryV3Schema>;

export const StrategyRunInputSnapshotV3Schema = z.object({
  schemaVersion: z.literal(3),
  strategyVersionId: z.string().min(1),
  definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
  evaluatorVersion: z.string().min(1),
  evaluatorCodeIdentity: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  scope: StrategyRunScopeSchema,
  universeKind: StrategyRunUniverseKindSchema,
  coverage: z.literal('CN_A_SHARES_SH_SZ'),
  stockIds: z.array(z.string().min(1)),
  stockIdChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  requestedBy: z.enum(['manual', 'scheduled', 'replay']),
  universeCheckpoint: z.object({
    syncId: z.string().min(1),
    provider: z.string().min(1),
    observedAt: z.coerce.date(),
    memberChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  dataCheckpoint: z
    .object({
      id: z.string().min(1),
      dataAsOf: z.coerce.date(),
      checksum: z.string().min(1),
    })
    .optional(),
  acceptancePolicyVersion: z.string().min(1),
  evaluationSessionId: z.string().min(1).optional(),
  prefilter: StrategyRunPrefilterSchema.optional(),
});
export type StrategyRunInputSnapshotV3 = z.infer<typeof StrategyRunInputSnapshotV3Schema>;

const LegacyStrategyRunRecordSchema = z.record(z.string(), z.unknown());
export const StrategyRunInputSnapshotSchema = z.union([
  StrategyRunInputSnapshotV3Schema,
  StrategyRunInputSnapshotV2Schema,
  LegacyStrategyRunRecordSchema,
]);
export const StrategyRunSummarySchema = z.union([
  StrategyRunSummaryV4Schema,
  StrategyRunSummaryV3Schema,
  StrategyRunSummaryV2Schema,
  LegacyStrategyRunRecordSchema,
]);

export const StrategyRunSchema = z.object({
  id: z.string().min(1),
  strategyId: z.string().min(1),
  strategyVersionId: z.string().min(1),
  mode: z.enum(['scan', 'scheduled', 'replay', 'backtest']),
  coverage: z.literal('CN_A_SHARES_SH_SZ'),
  dataAsOf: z.coerce.date(),
  startedAt: z.coerce.date(),
  finishedAt: z.coerce.date().optional(),
  status: z.enum(['running', 'complete', 'partial', 'failed']),
  /** 新运行必填；optional 仅为存量 legacy row 的读取兼容。 */
  scope: StrategyRunScopeSchema.optional(),
  inputSnapshot: StrategyRunInputSnapshotSchema,
  providerStatuses: z.array(ProviderStatusSchema),
  providerCoverage: z.array(StrategyProviderCoverageSchema).optional(),
  summary: StrategyRunSummarySchema.optional(),
  /** 新运行必填；存量记录由 current reader 以兼容规则解释。 */
  publication: StrategyRunPublicationSchema.optional(),
  error: z.string().min(1).optional(),
});
export type StrategyRun = z.infer<typeof StrategyRunSchema>;

const isStrategyRunSummaryV2 = (summary: StrategyRun['summary']): summary is StrategyRunSummaryV2 =>
  summary !== undefined && summary.schemaVersion === 2;

const isStrategyRunSummaryV3 = (summary: StrategyRun['summary']): summary is StrategyRunSummaryV3 =>
  summary !== undefined && summary.schemaVersion === 3;

const isStrategyRunSummaryV4 = (summary: StrategyRun['summary']): summary is StrategyRunSummaryV4 =>
  summary !== undefined && summary.schemaVersion === 4;

/** 运行是否结束由 status 表达；数据覆盖质量单独从 summary 读取。 */
export const getStrategyRunDataHealth = (run: StrategyRun): StrategyRunDataHealth | undefined => {
  if (run.status === 'running') return undefined;
  if (run.status === 'failed') return 'unavailable';
  if (isStrategyRunSummaryV4(run.summary)) return run.summary.dataHealth;
  if (isStrategyRunSummaryV3(run.summary)) return run.summary.dataHealth;
  if (run.status === 'partial') return 'partial';
  if (
    isStrategyRunSummaryV2(run.summary) &&
    (run.summary.partialCount > 0 || run.summary.failedCount > 0)
  ) {
    return 'partial';
  }
  return 'complete';
};

/** 新 complete 运行和旧 partial 运行都可派生股票池；running/failed 不可用。 */
export const isUsableStrategyRun = (run: StrategyRun): boolean =>
  run.status === 'complete' || run.status === 'partial';

/** 新生产消费者的唯一入口；legacy 行由 migration/current reader 单独适配。 */
export const isPublishableOperationalRun = (run: StrategyRun): boolean =>
  run.scope === 'operational' &&
  (run.status === 'complete' ||
    (run.status === 'partial' &&
      run.publication?.reasons.includes('legacy-publication') === true)) &&
  run.publication?.status === 'published';

export const isEvaluationStrategyRun = (run: StrategyRun): boolean =>
  run.scope === 'evaluation' || run.publication?.status === 'non-publishing';

export const LegacyRuleEvaluationSchema = z.object({
  ruleId: z.string().min(1),
  status: z.enum(['matched', 'not-matched', 'unknown', 'error']),
  value: z.unknown().optional(),
  evidence: z.array(z.string()),
  error: z.string().optional(),
});

export const RuleInputFactSchema = z.object({
  path: z.string().min(1),
  status: z.enum(['available', 'missing']),
  /** crossing / event fields distinguish no event from insufficient history. */
  qualifier: z.enum(['observed', 'not-observed']).optional(),
  value: z.unknown().optional(),
});
export type RuleInputFact = z.infer<typeof RuleInputFactSchema>;

export const RuleExplanationSchema = z.object({
  code: z.enum(['matched', 'not-matched', 'missing-input', 'evaluation-error']),
  message: z.string().min(1),
});
export type RuleExplanation = z.infer<typeof RuleExplanationSchema>;

export const RuleEvaluationV2Schema = LegacyRuleEvaluationSchema.extend({
  schemaVersion: z.literal(2),
  scope: z.enum(['selection', 'entry', 'exit', 'risk']),
  expression: z.string().min(1),
  inputs: z.array(RuleInputFactSchema),
  explanation: RuleExplanationSchema,
});
export type RuleEvaluationV2 = z.infer<typeof RuleEvaluationV2Schema>;

/** 旧运行仍需可读；新 evaluator 只写 RuleEvaluationV2。 */
export const RuleEvaluationSchema = z.union([RuleEvaluationV2Schema, LegacyRuleEvaluationSchema]);
export type RuleEvaluation = z.infer<typeof RuleEvaluationSchema>;

export const StrategyResultSchema = z.object({
  runId: z.string().min(1),
  stockId: z.string().min(1),
  selected: z.boolean(),
  score: z.number().min(0).max(100).optional(),
  rank: z.number().int().positive().optional(),
  ruleEvaluations: z.array(RuleEvaluationSchema),
  evidence: z.array(z.string()),
  dataAsOf: z.coerce.date(),
});
export type StrategyResult = z.infer<typeof StrategyResultSchema>;

export const StrategySignalSchema = z.object({
  id: z.string().min(1),
  strategyId: z.string().min(1),
  strategyVersionId: z.string().min(1),
  runId: z.string().min(1),
  ruleId: z.string().min(1),
  stockId: z.string().min(1),
  ts: z.coerce.date(),
  score: z.number().min(0).max(100),
  direction: z.enum(['bullish', 'bearish', 'neutral']),
  evidence: z.array(z.string()).min(1),
  evaluationSnapshot: z.record(z.string(), z.unknown()),
});
export type StrategySignal = z.infer<typeof StrategySignalSchema>;

export interface StrategyRunBundle {
  readonly run: StrategyRun;
  readonly results: readonly StrategyResult[];
  readonly signals: readonly StrategySignal[];
}

export const assertStrategyRunBundleInvariants = (bundle: StrategyRunBundle): void => {
  assertStrategyRunInvariants(bundle.run);
  if (bundle.run.status === 'running') {
    throw new InvariantError('StrategyRun bundle 只接受终态 run');
  }
  const resultStockIds = new Set<string>();
  for (const result of bundle.results) {
    StrategyResultSchema.parse(result);
    if (result.runId !== bundle.run.id) throw new InvariantError('StrategyResult.runId 不匹配');
    if (resultStockIds.has(result.stockId)) {
      throw new InvariantError('StrategyRun bundle 内 StrategyResult.stockId 必须唯一');
    }
    resultStockIds.add(result.stockId);
  }
  const signalIds = new Set<string>();
  const signalIdentities = new Set<string>();
  for (const signal of bundle.signals) {
    StrategySignalSchema.parse(signal);
    if (
      signal.runId !== bundle.run.id ||
      signal.strategyId !== bundle.run.strategyId ||
      signal.strategyVersionId !== bundle.run.strategyVersionId
    ) {
      throw new InvariantError('StrategySignal 引用与 run 不匹配');
    }
    const identity = `${signal.runId}\0${signal.ruleId}\0${signal.stockId}\0${signal.ts.toISOString()}`;
    if (signalIds.has(signal.id) || signalIdentities.has(identity)) {
      throw new InvariantError('StrategyRun bundle 内 StrategySignal identity 必须唯一');
    }
    signalIds.add(signal.id);
    signalIdentities.add(identity);
  }
  if (bundle.run.status === 'failed' && (bundle.results.length > 0 || bundle.signals.length > 0)) {
    throw new InvariantError('failed StrategyRun 不得提交 results/signals');
  }
  if (isStrategyRunSummaryV3(bundle.run.summary)) {
    const summary = bundle.run.summary;
    if (
      summary.evaluatedCount !== bundle.results.length ||
      summary.selectedCount !== bundle.results.filter((result) => result.selected).length ||
      summary.signalCount !== bundle.signals.length
    ) {
      throw new InvariantError('StrategyRun Summary V3 计数必须与 bundle facts 一致');
    }
  }
  if (isStrategyRunSummaryV4(bundle.run.summary)) {
    const summary = bundle.run.summary;
    if (
      summary.evaluatedCount !== bundle.results.length ||
      summary.selectedCount !== bundle.results.filter((result) => result.selected).length ||
      summary.signalCount !== bundle.signals.length
    ) {
      throw new InvariantError('StrategyRun Summary V4 计数必须与 bundle facts 一致');
    }
  }
};

const canonicalizeValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        // definitionHash 是落库 identity：必须 code-unit 排序，不依赖 locale
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalizeValue(item)]),
    );
  }
  return value;
};

export const canonicalStrategyDefinitionJson = (definition: StrategyDslV1): string =>
  JSON.stringify(canonicalizeValue(StrategyDslV1Schema.parse(definition)));

export const strategyDefinitionHash = (definition: StrategyDslV1): string =>
  createHash('sha256').update(canonicalStrategyDefinitionJson(definition)).digest('hex');

export const assertStrategyInvariants = (strategy: Strategy): void => {
  StrategySchema.parse(strategy);
  if (strategy.updatedAt < strategy.createdAt) {
    throw new InvariantError('Strategy.updatedAt 不能早于 createdAt');
  }
  if (strategy.status === 'active' && strategy.currentVersionId === undefined) {
    throw new InvariantError('active Strategy 必须有 currentVersionId');
  }
};

export const assertStrategyVersionInvariants = (
  strategyVersion: StrategyVersion,
  origin: 'builtin' | 'migration' | 'user',
): void => {
  StrategyVersionSchema.parse(strategyVersion);
  assertStrategySelectionPolicy({
    origin,
    selectionRuleCount: strategyVersion.definition.selection.rules.length,
  });
  if (strategyVersion.definitionHash !== strategyDefinitionHash(strategyVersion.definition)) {
    throw new InvariantError('StrategyVersion.definitionHash 与 canonical definition 不一致');
  }
  if (strategyVersion.publishedAt !== undefined && strategyVersion.validationStatus !== 'valid') {
    throw new InvariantError('published StrategyVersion 必须 validationStatus=valid');
  }
};

export const assertStrategyRunInvariants = (run: StrategyRun): void => {
  StrategyRunSchema.parse(run);
  if (run.status === 'running' && run.finishedAt !== undefined) {
    throw new InvariantError('running StrategyRun 不得有 finishedAt');
  }
  if (run.status !== 'running' && run.finishedAt === undefined) {
    throw new InvariantError('终态 StrategyRun 必须有 finishedAt');
  }
  if (run.finishedAt !== undefined && run.finishedAt < run.startedAt) {
    throw new InvariantError('StrategyRun.finishedAt 不能早于 startedAt');
  }
  if (run.finishedAt !== undefined && run.dataAsOf > run.finishedAt) {
    throw new InvariantError('StrategyRun.dataAsOf 不能晚于 finishedAt');
  }
  if (run.status === 'failed' && run.error === undefined) {
    throw new InvariantError('failed StrategyRun 必须有 error');
  }
  if (run.status === 'complete' && run.error !== undefined) {
    throw new InvariantError('complete StrategyRun 不得有 error');
  }
  if (isStrategyRunSummaryV3(run.summary)) {
    if (run.status === 'partial') {
      throw new InvariantError(
        'Summary V3 使用 dataHealth 表达部分数据，run.status 不得为 partial',
      );
    }
    if (run.status === 'failed' && run.summary.dataHealth !== 'unavailable') {
      throw new InvariantError('failed StrategyRun 的 dataHealth 必须为 unavailable');
    }
    if (run.status === 'complete' && run.summary.dataHealth === 'unavailable') {
      throw new InvariantError('complete StrategyRun 的 dataHealth 不得为 unavailable');
    }
  }
  if (isStrategyRunSummaryV4(run.summary)) {
    if (run.status === 'partial') {
      throw new InvariantError(
        'Summary V4 使用 dataHealth 表达部分数据，run.status 不得为 partial',
      );
    }
    if (run.status === 'failed' && run.summary.dataHealth !== 'unavailable') {
      throw new InvariantError('failed StrategyRun 的 dataHealth 必须为 unavailable');
    }
    if (run.status === 'complete' && run.summary.dataHealth === 'unavailable') {
      throw new InvariantError('complete StrategyRun 的 dataHealth 不得为 unavailable');
    }
  }
};
