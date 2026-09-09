import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { MoneySchema } from '../types/branded.js';

export const TradingPlanActionSchema = z.enum([
  'observe',
  'enter',
  'add',
  'hold',
  'reduce',
  'exit',
  'avoid',
]);
export type TradingPlanAction = z.infer<typeof TradingPlanActionSchema>;

export const TradingPlanStatusSchema = z.enum([
  'draft',
  'active',
  'superseded',
  'revoked',
  'expired',
]);
export type TradingPlanStatus = z.infer<typeof TradingPlanStatusSchema>;

export const TradingPlanConditionKindSchema = z.enum([
  'price-range',
  'price-threshold',
  'change-pct-threshold',
  'market-fact',
  'manual-confirmation',
]);
export type TradingPlanConditionKind = z.infer<typeof TradingPlanConditionKindSchema>;

export const TradingPlanConditionPhaseSchema = z.enum(['entry', 'hold', 'exit', 'risk', 'market']);
export type TradingPlanConditionPhase = z.infer<typeof TradingPlanConditionPhaseSchema>;

export const TradingPlanComparatorSchema = z.enum(['gte', 'gt', 'lte', 'lt', 'eq', 'between']);
export type TradingPlanComparator = z.infer<typeof TradingPlanComparatorSchema>;

/** 盘中可由确定性代码检查的条件；LLM 不能把自由文本当作已验证事实。 */
export const TradingPlanConditionSchema = z
  .object({
    id: z.string().min(1),
    kind: TradingPlanConditionKindSchema,
    phase: TradingPlanConditionPhaseSchema,
    metric: z.enum(['price', 'changePct', 'marketIndexChangePct', 'marketBreadthPct']).optional(),
    comparator: TradingPlanComparatorSchema.optional(),
    value: z.number().finite().optional(),
    valueTo: z.number().finite().optional(),
    factId: z.string().min(1).optional(),
    description: z.string().trim().min(1).max(500),
  })
  .superRefine((condition, ctx) => {
    if (condition.kind === 'manual-confirmation') return;
    if (condition.kind === 'market-fact' && condition.factId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['factId'],
        message: 'market-fact condition requires factId',
      });
    }
    if (condition.kind !== 'market-fact') {
      if (
        condition.metric === undefined ||
        condition.comparator === undefined ||
        condition.value === undefined
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['metric'],
          message: 'numeric condition requires metric, comparator and value',
        });
      }
      if (condition.comparator === 'between' && condition.valueTo === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['valueTo'],
          message: 'between condition requires valueTo',
        });
      }
      if (
        condition.comparator === 'between' &&
        condition.value !== undefined &&
        condition.valueTo !== undefined &&
        condition.value > condition.valueTo
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['valueTo'],
          message: 'between condition value must not exceed valueTo',
        });
      }
    }
  });
export type TradingPlanCondition = z.infer<typeof TradingPlanConditionSchema>;

export const TradingPlanMarketFactSchema = z.object({
  id: z.string().min(1),
  stockId: z.string().min(1).optional(),
  metric: z.string().min(1),
  value: z.number().finite(),
  unit: z.string().min(1),
  source: z.string().min(1),
  observedAt: z.coerce.date(),
  fetchedAt: z.coerce.date(),
  timestampSource: z.enum(['upstream', 'retrieval', 'unknown']),
  frequency: z.string().min(1),
  status: z.enum(['available', 'stale', 'unknown', 'unavailable']),
  note: z.string().max(500).optional(),
});
export type TradingPlanMarketFact = z.infer<typeof TradingPlanMarketFactSchema>;

export const TradingPlanEvidenceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['market', 'strategy', 'account', 'computed']),
  source: z.string().min(1),
  observedAt: z.coerce.date().optional(),
  factIds: z.array(z.string().min(1)).default([]),
  summary: z.string().trim().min(1).max(500),
});
export type TradingPlanEvidence = z.infer<typeof TradingPlanEvidenceSchema>;

export const TradingPlanPositionSchema = z.object({
  currentPct: z.number().finite().min(0).max(100).nullable(),
  targetPct: z.number().finite().min(0).max(100).nullable(),
  deltaPct: z.number().finite().min(-100).max(100).nullable(),
  constraintStatus: z.enum(['passed', 'blocked', 'unavailable']),
  constraintReasons: z.array(z.string().min(1)),
  prerequisiteActions: z.array(z.string().min(1)),
});
export type TradingPlanPosition = z.infer<typeof TradingPlanPositionSchema>;

export const TradingPlanHoldingSchema = z.object({
  minTradingDays: z.number().int().nonnegative(),
  maxTradingDays: z.number().int().nonnegative(),
  nextReviewAt: z.coerce.date(),
  earlyExitConditions: z.array(z.string().min(1)),
  extensionBasis: z.array(z.string().min(1)),
});
export type TradingPlanHolding = z.infer<typeof TradingPlanHoldingSchema>;

export const TradingPlanExitSchema = z.object({
  stopLoss: MoneySchema.optional(),
  takeProfit: MoneySchema.optional(),
  conditions: z.array(z.string().min(1)),
  triggerConditions: z.array(TradingPlanConditionSchema).default([]),
  canSellNow: z.boolean(),
  unavailableReason: z.string().max(500).optional(),
});
export type TradingPlanExit = z.infer<typeof TradingPlanExitSchema>;

export const TradingPlanSourceSchema = z.object({
  strategyIds: z.array(z.string().min(1)),
  strategyVersionIds: z.array(z.string().min(1)),
  runIds: z.array(z.string().min(1)),
  signalIds: z.array(z.string().min(1)),
  adviceIds: z.array(z.string().min(1)),
});
export type TradingPlanSource = z.infer<typeof TradingPlanSourceSchema>;

export const TradingPlanExplanationSchema = z.object({
  supportingEvidenceIds: z.array(z.string().min(1)),
  counterEvidence: z.array(z.string().min(1)),
  risks: z.array(z.string().min(1)),
  unknowns: z.array(z.string().min(1)),
  changeSummary: z.string().max(1000).optional(),
});
export type TradingPlanExplanation = z.infer<typeof TradingPlanExplanationSchema>;

export const TradingPlanSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  accountId: z.string().min(1),
  stockId: z.string().min(1),
  stockName: z.string().min(1).optional(),
  industry: z.string().min(1).optional(),
  status: TradingPlanStatusSchema,
  action: TradingPlanActionSchema,
  entryPriceLow: MoneySchema.optional(),
  entryPriceHigh: MoneySchema.optional(),
  entryConditions: z.array(TradingPlanConditionSchema),
  invalidEntryConditions: z.array(z.string().min(1)),
  position: TradingPlanPositionSchema,
  holding: TradingPlanHoldingSchema,
  exit: TradingPlanExitSchema,
  validFrom: z.coerce.date(),
  validUntil: z.coerce.date(),
  invalidationConditions: z.array(z.string().min(1)),
  supersedesVersionId: z.string().min(1).optional(),
  accountSnapshotId: z.string().min(1),
  accountSnapshotVersion: z.number().int().positive(),
  marketFacts: z.array(TradingPlanMarketFactSchema),
  evidence: z.array(TradingPlanEvidenceSchema),
  source: TradingPlanSourceSchema,
  explanation: TradingPlanExplanationSchema,
  confidence: z.number().finite().min(0).max(100),
  createdAt: z.coerce.date(),
});
export type TradingPlan = z.infer<typeof TradingPlanSchema>;

export const TradingPlanQuerySchema = z.object({
  accountId: z.string().min(1).optional(),
  stockId: z.string().min(1).optional(),
  status: TradingPlanStatusSchema.optional(),
  activeOnly: z.boolean().optional(),
  /** activeOnly 时可指定评估时点；缺省表示不做有效期过滤。 */
  asOf: z.coerce.date().optional(),
  limit: z.number().int().positive().max(500).optional(),
});
export type TradingPlanQuery = z.infer<typeof TradingPlanQuerySchema>;

export const assertTradingPlanInvariants = (plan: TradingPlan): void => {
  if (plan.validUntil.getTime() <= plan.validFrom.getTime()) {
    throw new InvariantError('trading plan validUntil must be after validFrom');
  }
  if (plan.holding.maxTradingDays < plan.holding.minTradingDays) {
    throw new InvariantError(
      'trading plan holding maxTradingDays must not be below minTradingDays',
    );
  }
  if (
    plan.entryPriceLow !== undefined &&
    plan.entryPriceHigh !== undefined &&
    plan.entryPriceLow > plan.entryPriceHigh
  ) {
    throw new InvariantError('trading plan entry price range is inverted');
  }
  if (plan.status === 'active' && (plan.action === 'enter' || plan.action === 'add')) {
    if (
      plan.position.targetPct === null ||
      plan.entryPriceLow === undefined ||
      plan.entryPriceHigh === undefined
    ) {
      throw new InvariantError('enter/add plan requires target position and entry price range');
    }
  }
  if (
    plan.position.currentPct !== null &&
    plan.position.targetPct !== null &&
    plan.position.deltaPct !== null
  ) {
    const expected = Math.round((plan.position.targetPct - plan.position.currentPct) * 100) / 100;
    const actual = Math.round(plan.position.deltaPct * 100) / 100;
    if (expected !== actual)
      throw new InvariantError('trading plan deltaPct must equal targetPct - currentPct');
  }
  const factIds = new Set(plan.marketFacts.map((fact) => fact.id));
  const evidenceIds = new Set(plan.evidence.map((item) => item.id));
  for (const condition of [...plan.entryConditions, ...plan.exit.triggerConditions]) {
    if (
      condition.kind === 'market-fact' &&
      condition.factId !== undefined &&
      !factIds.has(condition.factId)
    ) {
      throw new InvariantError(`trading plan condition fact not found: ${condition.factId}`);
    }
  }
  for (const id of plan.explanation.supportingEvidenceIds) {
    if (!evidenceIds.has(id)) throw new InvariantError(`trading plan evidence not found: ${id}`);
  }
  if (plan.status === 'active' && plan.marketFacts.some((fact) => fact.status === 'unavailable')) {
    throw new InvariantError('active trading plan cannot contain unavailable market fact');
  }
};

export const tradingPlanVersionId = (plan: Pick<TradingPlan, 'id' | 'version'>): string =>
  `${plan.id}:v${plan.version}`;

export const isRiskAction = (action: TradingPlanAction): boolean =>
  action === 'reduce' || action === 'exit' || action === 'avoid';

export const isMaterialTradingPlanChange = (
  previous: TradingPlan,
  next: TradingPlan,
  baselineTargetPct: number | null,
): boolean => {
  if (previous.action !== next.action) return true;
  if (
    previous.entryPriceLow !== next.entryPriceLow ||
    previous.entryPriceHigh !== next.entryPriceHigh
  )
    return true;
  if (
    previous.exit.stopLoss !== next.exit.stopLoss ||
    previous.exit.takeProfit !== next.exit.takeProfit
  )
    return true;
  if (previous.entryConditions.length !== next.entryConditions.length) return true;
  if (JSON.stringify(previous.entryConditions) !== JSON.stringify(next.entryConditions))
    return true;
  if (
    JSON.stringify(previous.exit.triggerConditions) !== JSON.stringify(next.exit.triggerConditions)
  )
    return true;
  if (previous.invalidationConditions.join('|') !== next.invalidationConditions.join('|'))
    return true;
  if (previous.position.constraintStatus !== next.position.constraintStatus) return true;
  if (isRiskAction(next.action)) return true;
  const target = next.position.targetPct;
  if (target !== null && baselineTargetPct !== null && Math.abs(target - baselineTargetPct) >= 2)
    return true;
  return false;
};

export interface TradingPlanConditionFact {
  readonly metric: 'price' | 'changePct' | 'marketIndexChangePct' | 'marketBreadthPct';
  readonly value: number;
}

export const evaluateTradingPlanCondition = (
  condition: TradingPlanCondition,
  facts: ReadonlyMap<string, TradingPlanConditionFact>,
): boolean | null => {
  if (condition.kind === 'manual-confirmation') return null;
  if (condition.kind === 'market-fact') {
    if (condition.factId === undefined) return null;
    return facts.has(condition.factId);
  }
  if (
    condition.metric === undefined ||
    condition.comparator === undefined ||
    condition.value === undefined
  )
    return null;
  const fact = facts.get(condition.id);
  if (fact === undefined || fact.metric !== condition.metric) return null;
  switch (condition.comparator) {
    case 'gte':
      return fact.value >= condition.value;
    case 'gt':
      return fact.value > condition.value;
    case 'lte':
      return fact.value <= condition.value;
    case 'lt':
      return fact.value < condition.value;
    case 'eq':
      return fact.value === condition.value;
    case 'between':
      return condition.valueTo === undefined
        ? null
        : fact.value >= condition.value && fact.value <= condition.valueTo;
  }
};
