import { z } from 'zod';
import { InvariantError } from '../error/index.js';
import { addTradingDays } from '../trading-calendar.js';
import { MoneySchema } from '../types/branded.js';
import type { AccountFacts } from './account-facts.js';

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
  /** 计划所依据的账户事实时间（现金 + 持仓口径）。 */
  accountFactsAsOf: z.coerce.date(),
  /** 计划所依据的账户事实指纹；与当前 facts 不一致即视为失效。 */
  accountFactsDigest: z.string().min(8),
  marketFacts: z.array(TradingPlanMarketFactSchema),
  evidence: z.array(TradingPlanEvidenceSchema),
  source: TradingPlanSourceSchema,
  explanation: TradingPlanExplanationSchema,
  confidence: z.number().finite().min(0).max(100),
  createdAt: z.coerce.date(),
});
export type TradingPlan = z.infer<typeof TradingPlanSchema>;

const LegacyTradingPlanSchema = TradingPlanSchema.omit({
  accountFactsAsOf: true,
  accountFactsDigest: true,
}).extend({
  accountSnapshotId: z.string().min(1),
  accountSnapshotVersion: z.number().int().positive(),
});

/** 只迁移有旧快照身份且缺少账户事实的历史版本，禁止伪造当前账户指纹。 */
export const migrateLegacyTradingPlan = (value: unknown): TradingPlan | null => {
  if (
    typeof value !== 'object' ||
    value === null ||
    'accountFactsDigest' in value ||
    'accountFactsAsOf' in value
  )
    return null;
  const legacy = LegacyTradingPlanSchema.safeParse(value);
  if (!legacy.success) return null;
  const { accountSnapshotId, accountSnapshotVersion, ...plan } = legacy.data;
  return TradingPlanSchema.parse({
    ...plan,
    status: plan.status === 'active' || plan.status === 'draft' ? 'expired' : plan.status,
    accountFactsAsOf: plan.createdAt,
    accountFactsDigest: `legacy-snapshot:${accountSnapshotId}:v${accountSnapshotVersion}`,
    explanation: {
      ...plan.explanation,
      unknowns: [
        ...plan.explanation.unknowns,
        '旧计划依据的账户事实已失效，需要基于当前账户事实重新生成',
      ],
    },
  });
};

export const TradingPlanQuerySchema = z.object({
  accountId: z.string().min(1).optional(),
  stockId: z.string().min(1).optional(),
  status: TradingPlanStatusSchema.optional(),
  activeOnly: z.boolean().optional(),
  /** 当前列表按计划聚合后应用 limit，同时保留最新修订草案。 */
  currentOnly: z.boolean().optional(),
  /** activeOnly 时可指定评估时点；缺省表示不做有效期过滤。 */
  asOf: z.coerce.date().optional(),
  /** 按版本创建时间过滤（闭区间）；先过滤再应用 limit。 */
  createdSince: z.coerce.date().optional(),
  createdUntil: z.coerce.date().optional(),
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

export const TRADING_PLAN_DRAFT_TRADING_DAYS = 2;

export const tradingPlanExpiresAt = (plan: TradingPlan): Date =>
  plan.status === 'draft'
    ? new Date(
        Math.min(
          plan.validUntil.getTime(),
          addTradingDays(plan.createdAt, TRADING_PLAN_DRAFT_TRADING_DAYS).getTime(),
        ),
      )
    : plan.validUntil;

export const resolveTradingPlanVersions = (versions: readonly TradingPlan[]) => {
  const sorted = [...versions].sort(
    (a, b) => b.version - a.version || b.createdAt.getTime() - a.createdAt.getTime(),
  );
  let active: TradingPlan | undefined;
  let draft: TradingPlan | undefined;
  for (const plan of sorted) {
    if (plan.status === 'active') {
      active = plan;
      break;
    }
    if (plan.status !== 'draft') break;
    draft ??= plan;
  }
  return { latest: sorted[0], active, draft };
};

export const TradingPlanViewSchema = z.object({
  planId: z.string(),
  versionId: z.string(),
  kind: z.enum(['current', 'draft', 'history']),
  draftVersionId: z.string().optional(),
});
export type TradingPlanView = z.infer<typeof TradingPlanViewSchema>;

export const TradingPlanReviewSchema = z.object({
  stockId: z.string(),
  versionId: z.string(),
  outcome: z.enum(['created', 'maintained', 'unchanged-draft']),
  reviewedAt: z.coerce.date(),
  adviceIds: z.array(z.string()),
  reasons: z.array(z.string()),
});
export type TradingPlanReview = z.infer<typeof TradingPlanReviewSchema>;

export const tradingPlanView = (
  versions: readonly TradingPlan[],
  now: Date,
  facts: Pick<AccountFacts, 'digest'> | null,
): TradingPlanView | null => {
  const { latest, active, draft } = resolveTradingPlanVersions(versions);
  if (latest === undefined) return null;
  const live = (plan: TradingPlan | undefined): plan is TradingPlan =>
    plan !== undefined &&
    tradingPlanExpiresAt(plan) > now &&
    (facts === null || plan.accountFactsDigest === facts.digest);
  const plan = live(active) ? active : live(draft) ? draft : latest;
  return {
    planId: plan.id,
    versionId: tradingPlanVersionId(plan),
    kind: plan.status === 'active' ? 'current' : plan.status === 'draft' ? 'draft' : 'history',
    ...(plan === active && live(draft) ? { draftVersionId: tradingPlanVersionId(draft) } : {}),
  };
};

export const selectTradingPlans = (
  plans: readonly TradingPlan[],
  query: TradingPlanQuery,
): TradingPlan[] => {
  const sorted = [...plans].sort(
    (a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime() ||
      b.version - a.version ||
      tradingPlanVersionId(a).localeCompare(tradingPlanVersionId(b)),
  );
  const matches = (plan: TradingPlan): boolean =>
    (query.status === undefined || plan.status === query.status) &&
    (query.createdSince === undefined || plan.createdAt >= query.createdSince) &&
    (query.createdUntil === undefined || plan.createdAt <= query.createdUntil);
  if (query.activeOnly !== true && query.currentOnly !== true)
    return sorted.filter(matches).slice(0, query.limit ?? 100);
  const groups = new Map<string, TradingPlan[]>();
  for (const plan of sorted) {
    if (
      query.currentOnly === true &&
      query.createdUntil !== undefined &&
      plan.createdAt > query.createdUntil
    )
      continue;
    const group = groups.get(plan.id) ?? [];
    group.push(plan);
    groups.set(plan.id, group);
  }
  const selected: TradingPlan[] = [];
  let count = 0;
  const orderedGroups = [...groups.values()];
  if (query.currentOnly === true && query.asOf !== undefined) {
    const asOf = query.asOf;
    const liveRank = (versions: readonly TradingPlan[]) => {
      const { active, draft } = resolveTradingPlanVersions(versions);
      return [active, draft].some((plan) => plan !== undefined && tradingPlanExpiresAt(plan) > asOf)
        ? 0
        : 1;
    };
    orderedGroups.sort((a, b) => liveRank(a) - liveRank(b));
  }
  for (const versions of orderedGroups) {
    const { latest, active } = resolveTradingPlanVersions(versions);
    if (query.activeOnly === true) {
      if (
        active === undefined ||
        !matches(active) ||
        (query.asOf !== undefined &&
          (active.validFrom > query.asOf || active.validUntil <= query.asOf))
      )
        continue;
      selected.push(active);
    } else {
      const current = [latest, ...(active === latest ? [] : [active])].filter(
        (plan): plan is TradingPlan => plan !== undefined && matches(plan),
      );
      if (current.length === 0) continue;
      selected.push(...current);
    }
    if (++count >= (query.limit ?? 100)) break;
  }
  return selected;
};

export const isRiskAction = (action: TradingPlanAction): boolean =>
  action === 'reduce' || action === 'exit' || action === 'avoid';

export const isMaterialTradingPlanChange = (previous: TradingPlan, next: TradingPlan): boolean => {
  const strings = (items: readonly string[]) => [...new Set(items)].sort();
  const conditions = (plan: TradingPlan, items: readonly TradingPlanCondition[]) =>
    items
      .map(({ id: _id, description, factId, ...condition }) => {
        const fact = plan.marketFacts.find((item) => item.id === factId);
        return {
          ...condition,
          ...(condition.kind === 'manual-confirmation' ? { description } : {}),
          ...(fact === undefined
            ? {}
            : {
                fact: {
                  stockId: fact.stockId,
                  metric: fact.metric,
                  value: fact.value,
                  unit: fact.unit,
                  status: fact.status,
                },
              }),
        };
      })
      .map((condition) => JSON.stringify(condition))
      .sort();
  const terms = (plan: TradingPlan) => ({
    status: plan.status,
    action: plan.action,
    accountFactsDigest: plan.accountFactsDigest,
    entryPriceLow: plan.entryPriceLow,
    entryPriceHigh: plan.entryPriceHigh,
    entryConditions: conditions(plan, plan.entryConditions),
    invalidEntryConditions: strings(plan.invalidEntryConditions),
    targetPct:
      (plan.action === 'hold' ||
        (plan.action === 'observe' && (plan.position.currentPct ?? 0) > 0)) &&
      plan.position.targetPct === plan.position.currentPct
        ? 'maintain'
        : plan.position.targetPct,
    constraintStatus: plan.position.constraintStatus,
    constraintReasons: strings(plan.position.constraintReasons),
    prerequisiteActions: strings(plan.position.prerequisiteActions),
    minTradingDays: plan.holding.minTradingDays,
    maxTradingDays: plan.holding.maxTradingDays,
    earlyExitConditions: strings(plan.holding.earlyExitConditions),
    extensionBasis: strings(plan.holding.extensionBasis),
    stopLoss: plan.exit.stopLoss,
    takeProfit: plan.exit.takeProfit,
    exitConditions: conditions(plan, plan.exit.triggerConditions),
    exitReasons: strings(plan.exit.conditions),
    canSellNow: plan.exit.canSellNow,
    invalidationConditions: strings(plan.invalidationConditions),
    strategyIds: strings(plan.source.strategyIds),
    strategyVersionIds: strings(plan.source.strategyVersionIds),
    counterEvidence: strings(plan.explanation.counterEvidence),
    risks: strings(plan.explanation.risks),
    unknowns: strings(plan.explanation.unknowns),
  });
  return JSON.stringify(terms(previous)) !== JSON.stringify(terms(next));
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
    return facts.has(condition.factId) ? true : null;
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

export const TradingPlanMonitoringSchema = z.object({
  versionId: z.string(),
  expiresAt: z.coerce.date(),
  nextReviewAt: z.coerce.date(),
  lastReviewedAt: z.coerce.date().optional(),
  status: z.enum([
    'ready',
    'draft',
    'inactive',
    'expired',
    'scheduled',
    'account-changed',
    'unavailable',
    'no-conditions',
  ]),
  reason: z.string(),
  nextStep: z.string(),
});
export type TradingPlanMonitoring = z.infer<typeof TradingPlanMonitoringSchema>;

export const tradingPlanMonitoring = (
  plan: TradingPlan,
  facts: Pick<AccountFacts, 'digest' | 'status'> | null,
  now: Date,
  review?: TradingPlanReview,
  versions?: readonly TradingPlan[],
): TradingPlanMonitoring => {
  const expiresAt = tradingPlanExpiresAt(plan);
  const reviewedAt =
    review !== undefined && review.reviewedAt <= now ? review.reviewedAt : undefined;
  const result = (
    status: TradingPlanMonitoring['status'],
    reason: string,
    nextStep: string,
  ): TradingPlanMonitoring => ({
    versionId: tradingPlanVersionId(plan),
    expiresAt,
    nextReviewAt: new Date(
      Math.min(
        (reviewedAt === undefined
          ? plan.holding.nextReviewAt
          : addTradingDays(reviewedAt, Math.max(1, plan.holding.minTradingDays))
        ).getTime(),
        expiresAt.getTime(),
      ),
    ),
    ...(reviewedAt === undefined ? {} : { lastReviewedAt: reviewedAt }),
    status,
    reason,
    nextStep,
  });
  if (plan.status === 'expired') return result('expired', '计划已过期', '基于新证据重新复核计划');
  if (plan.status !== 'active' && plan.status !== 'draft')
    return result('inactive', '历史版本不参与监控', '查看当前计划版本');
  if (versions !== undefined) {
    const { active, draft } = resolveTradingPlanVersions(
      versions.filter((version) => version.id === plan.id),
    );
    const current = plan.status === 'active' ? active : draft;
    if (current === undefined || tradingPlanVersionId(current) !== tradingPlanVersionId(plan))
      return result('inactive', '计划已被后续版本替代', '查看当前计划版本');
  }
  if (tradingPlanExpiresAt(plan) <= now)
    return result('expired', '计划已超过有效期', '基于新证据重新复核计划');
  if (facts !== null && facts.digest !== plan.accountFactsDigest)
    return result('account-changed', '持仓或现金变化，计划前提已失效', '基于当前账户重新生成计划');
  if (facts !== null && facts.status !== 'complete')
    return result('unavailable', '账户事实不可用', '刷新持仓行情并检查账户对账');
  if (plan.status === 'draft')
    return result(
      'draft',
      '草案未通过生效门槛',
      plan.position.constraintReasons.join('；') ||
        plan.explanation.unknowns.join('；') ||
        '补齐证据后重新生成计划',
    );
  if (plan.validFrom > now) return result('scheduled', '尚未到计划生效时间', '等待生效时间');
  if (facts === null || facts.status !== 'complete')
    return result('unavailable', '账户事实不可用', '刷新持仓行情并检查账户对账');
  if (plan.position.constraintStatus !== 'passed')
    return result(
      'unavailable',
      '计划约束未通过',
      plan.position.constraintReasons.join('；') || '重新生成计划',
    );
  if (plan.entryConditions.length + plan.exit.triggerConditions.length === 0)
    return result('no-conditions', '没有可检查的盘中条件', '复核并补充结构化条件');
  return result('ready', '计划具备监控资格', '等待新鲜行情；实际运行与送达请查看预警记录');
};

export const evaluateTradingPlanEntryConditions = (
  plan: TradingPlan,
  facts: ReadonlyMap<string, TradingPlanConditionFact>,
): boolean | null => {
  if (plan.entryConditions.length === 0) return false;
  const exits = plan.exit.triggerConditions.map((condition) =>
    evaluateTradingPlanCondition(condition, facts),
  );
  if (exits.includes(true)) return false;
  const entries = plan.entryConditions.map((condition) =>
    evaluateTradingPlanCondition(condition, facts),
  );
  if (entries.includes(false)) return false;
  if (entries.includes(null) || exits.includes(null)) return null;
  return true;
};
