import { createHash } from 'node:crypto';

import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { assertStrategySelectionPolicy } from '../strategy-watchlist-policy.js';
import { ProviderStatusSchema } from './workflow-run.js';

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
});
export type StrategySignalRule = z.infer<typeof StrategySignalRuleSchema>;

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
  validationStatus: z.enum(['pending', 'valid', 'invalid']),
  validationErrors: z.array(z.string()).default([]),
  publishedAt: z.coerce.date().optional(),
  createdAt: z.coerce.date(),
});
export type StrategyVersion = z.infer<typeof StrategyVersionSchema>;

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
  inputSnapshot: z.record(z.string(), z.unknown()),
  providerStatuses: z.array(ProviderStatusSchema),
  summary: z.record(z.string(), z.unknown()).optional(),
  error: z.string().min(1).optional(),
});
export type StrategyRun = z.infer<typeof StrategyRunSchema>;

export const RuleEvaluationSchema = z.object({
  ruleId: z.string().min(1),
  status: z.enum(['matched', 'not-matched', 'unknown', 'error']),
  value: z.unknown().optional(),
  evidence: z.array(z.string()),
  error: z.string().optional(),
});
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

const canonicalizeValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
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
};
