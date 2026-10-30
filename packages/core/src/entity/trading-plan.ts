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

/** 目标仓位区间：单位百分点 0–100，与 currentPct / singleStockPct 同量纲。 */
export const TradingPlanTargetRangeSchema = z
  .object({
    min: z.number().finite().min(0).max(100),
    max: z.number().finite().min(0).max(100),
  })
  .strict();
export type TradingPlanTargetRange = z.infer<typeof TradingPlanTargetRangeSchema>;

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * H4：实际允许宽度 = min(分层上限, 0.30 × max)，取更严。
 * 分层上限按百分点：max≤10 → 4；max≤20 → 6；其余 → 8。
 */
export const tradingPlanRangeWidthCap = (max: number): number => {
  const tier = max <= 10 ? 4 : max <= 20 ? 6 : 8;
  return Math.min(tier, round2(max * 0.3));
};

/** 区间内选点规则；volatility-scaled 带可复算参数，复盘能回答"为什么是这个仓位"。 */
export const TradingPlanRangePickSchema = z.discriminatedUnion('ruleId', [
  z.object({ ruleId: z.literal('lower-bound') }).strict(),
  z.object({ ruleId: z.literal('mid') }).strict(),
  z
    .object({
      ruleId: z.literal('volatility-scaled'),
      volatilityMetric: z.string().trim().min(1).max(64),
      volatilityPct: z.number().finite().nonnegative(),
      tiers: z
        .array(
          z
            .object({
              volatilityUpToPct: z.number().finite().positive(),
              bandFractionPct: z.number().finite().min(0).max(100),
            })
            .strict(),
        )
        .min(1)
        .max(8),
    })
    .strict(),
]);
export type TradingPlanRangePick = z.infer<typeof TradingPlanRangePickSchema>;

/** 按选点规则计算落点；无匹配 tier 时降级到下限（fallbackPct）。 */
export const tradingPlanPickedPct = (
  range: TradingPlanTargetRange,
  pick: TradingPlanRangePick,
): number => {
  const width = range.max - range.min;
  switch (pick.ruleId) {
    case 'lower-bound':
      return range.min;
    case 'mid':
      return round2(range.min + width / 2);
    case 'volatility-scaled': {
      const tier = pick.tiers.find((item) => pick.volatilityPct <= item.volatilityUpToPct);
      if (tier === undefined) return range.min;
      return Math.min(
        range.max,
        Math.max(range.min, round2(range.min + (width * tier.bandFractionPct) / 100)),
      );
    }
  }
};

const positionRangeChecks = (
  position: {
    readonly targetPctRange: TradingPlanTargetRange | null;
    readonly appliedPct: number | null;
    readonly fallbackPct: number | null;
    readonly rangePick: TradingPlanRangePick | null;
  },
  ctx: z.RefinementCtx,
): void => {
  if (position.targetPctRange === null) {
    if (
      position.appliedPct !== null ||
      position.fallbackPct !== null ||
      position.rangePick !== null
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['targetPctRange'],
        message: '区间为空时 appliedPct / fallbackPct / rangePick 必须为空',
      });
    }
    return;
  }
  const { min, max } = position.targetPctRange;
  if (min > max) {
    ctx.addIssue({ code: 'custom', path: ['targetPctRange'], message: '区间 min 不能大于 max' });
    return;
  }
  const width = max - min;
  const cap = tradingPlanRangeWidthCap(max);
  if (width > cap + 1e-9) {
    ctx.addIssue({
      code: 'custom',
      path: ['targetPctRange'],
      message: `区间宽度 ${width} 超过允许上限 ${cap}（分层上限与 0.30×max 取更严）`,
    });
  }
  if (
    position.appliedPct === null ||
    position.fallbackPct === null ||
    position.rangePick === null
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['appliedPct'],
      message: '区间非空时 appliedPct / fallbackPct / rangePick 必填',
    });
    return;
  }
  if (position.fallbackPct !== min) {
    ctx.addIssue({
      code: 'custom',
      path: ['fallbackPct'],
      message: 'fallbackPct 必须等于区间下限 min',
    });
  }
  if (position.appliedPct < min - 1e-9 || position.appliedPct > max + 1e-9) {
    ctx.addIssue({
      code: 'custom',
      path: ['appliedPct'],
      message: 'appliedPct 必须落在区间内',
    });
  }
  const expected = tradingPlanPickedPct(position.targetPctRange, position.rangePick);
  if (Math.abs(round2(position.appliedPct) - expected) > 1e-9) {
    ctx.addIssue({
      code: 'custom',
      path: ['appliedPct'],
      message: `appliedPct 必须等于选点结果 ${expected}`,
    });
  }
};

export const TradingPlanPositionSchema = z
  .object({
    currentPct: z.number().finite().min(0).max(100).nullable(),
    targetPctRange: TradingPlanTargetRangeSchema.nullable(),
    appliedPct: z.number().finite().min(0).max(100).nullable(),
    fallbackPct: z.number().finite().min(0).max(100).nullable(),
    rangePick: TradingPlanRangePickSchema.nullable(),
    constraintStatus: z.enum(['passed', 'blocked', 'unavailable']),
    constraintReasons: z.array(z.string().min(1)),
    prerequisiteActions: z.array(z.string().min(1)),
  })
  .superRefine(positionRangeChecks);
export type TradingPlanPosition = z.infer<typeof TradingPlanPositionSchema>;

/** 旧持久化形状（只读兼容）：单值 targetPct + 派生 deltaPct。 */
export const LegacyTradingPlanPositionSchema = z.object({
  currentPct: z.number().finite().min(0).max(100).nullable(),
  targetPct: z.number().finite().min(0).max(100).nullable(),
  deltaPct: z.number().finite().min(-100).max(100).nullable(),
  constraintStatus: z.enum(['passed', 'blocked', 'unavailable']),
  constraintReasons: z.array(z.string().min(1)),
  prerequisiteActions: z.array(z.string().min(1)),
});
export type LegacyTradingPlanPosition = z.infer<typeof LegacyTradingPlanPositionSchema>;

/** 旧单值目标 → 退化区间（min=max=旧值），deltaPct 丢弃、读侧派生。 */
export const normalizeTradingPlanPositionV1 = (
  position: LegacyTradingPlanPosition,
): TradingPlanPosition => {
  const targetPct = position.targetPct;
  const range = targetPct === null ? null : { min: targetPct, max: targetPct };
  return {
    currentPct: position.currentPct,
    targetPctRange: range,
    appliedPct: targetPct,
    fallbackPct: targetPct,
    rangePick: range === null ? null : { ruleId: 'lower-bound' },
    constraintStatus: position.constraintStatus,
    constraintReasons: position.constraintReasons,
    prerequisiteActions: position.prerequisiteActions,
  };
};

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

interface TradingPlanSchemaOptions {
  /** 写路径（save / tool 输入）要求 active 必须有结构化失效条件；读路径豁免历史行。 */
  readonly requireActiveInvalidationRules: boolean;
}

const tradingPlanChecks = (
  plan: {
    readonly status: TradingPlanStatus;
    readonly action: TradingPlanAction;
    readonly entryPriceLow?: number | undefined;
    readonly entryPriceHigh?: number | undefined;
    readonly position: TradingPlanPosition;
    readonly holding: TradingPlanHolding;
    readonly exit: TradingPlanExit;
    readonly entryConditions: readonly TradingPlanCondition[];
    readonly invalidationRules: readonly TradingPlanCondition[];
    readonly marketFacts: readonly TradingPlanMarketFact[];
    readonly evidence: readonly TradingPlanEvidence[];
    readonly explanation: TradingPlanExplanation;
    readonly validFrom: Date;
    readonly validUntil: Date;
  },
  ctx: z.RefinementCtx,
  options: TradingPlanSchemaOptions,
): void => {
  if (plan.validUntil.getTime() <= plan.validFrom.getTime()) {
    ctx.addIssue({
      code: 'custom',
      path: ['validUntil'],
      message: 'validUntil 必须晚于 validFrom',
    });
  }
  if (plan.holding.maxTradingDays < plan.holding.minTradingDays) {
    ctx.addIssue({
      code: 'custom',
      path: ['holding', 'maxTradingDays'],
      message: 'maxTradingDays 不能小于 minTradingDays',
    });
  }
  if (
    plan.entryPriceLow !== undefined &&
    plan.entryPriceHigh !== undefined &&
    plan.entryPriceLow > plan.entryPriceHigh
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['entryPriceLow'],
      message: '入场价格区间颠倒',
    });
  }
  const range = plan.position.targetPctRange;
  if (range !== null) {
    const { min, max } = range;
    if (max === 0) {
      if (min !== 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['position', 'targetPctRange'],
          message: 'max=0 时 min 必须为 0',
        });
      }
      if (plan.action !== 'exit' && plan.action !== 'avoid' && plan.action !== 'observe') {
        ctx.addIssue({
          code: 'custom',
          path: ['position', 'targetPctRange'],
          message: '只有 exit / avoid / observe 允许目标仓位为 0',
        });
      }
    } else if (max < 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['position', 'targetPctRange'],
        message: '非零目标仓位必须 >= 1 个百分点（拒绝 0–1 比例单位）',
      });
    }
    if ((plan.action === 'add' || plan.action === 'hold') && min <= 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['position', 'targetPctRange'],
        message: 'add / hold 计划要求目标仓位下限 min > 0',
      });
    }
    if ((plan.action === 'exit' || plan.action === 'avoid') && !(min === 0 && max === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['position', 'targetPctRange'],
        message: 'exit / avoid 计划的目标仓位必须是 {0,0}',
      });
    }
  }
  if (plan.status === 'active' && (plan.action === 'enter' || plan.action === 'add')) {
    if (range === null || plan.entryPriceLow === undefined || plan.entryPriceHigh === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['position'],
        message: 'enter/add 生效计划要求目标仓位区间与入场价格区间',
      });
    }
  }
  const factIds = new Set(plan.marketFacts.map((fact) => fact.id));
  const ruleIds = new Set<string>();
  for (const [index, rule] of plan.invalidationRules.entries()) {
    if (rule.phase !== 'exit' && rule.phase !== 'risk' && rule.kind !== 'market-fact') {
      ctx.addIssue({
        code: 'custom',
        path: ['invalidationRules', index, 'phase'],
        message: '失效条件必须 phase ∈ {exit,risk} 或 kind=market-fact',
      });
    }
    if (rule.kind === 'market-fact' && rule.factId !== undefined && !factIds.has(rule.factId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['invalidationRules', index, 'factId'],
        message: `失效条件引用的事实不存在: ${rule.factId}`,
      });
    }
    if (ruleIds.has(rule.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['invalidationRules', index, 'id'],
        message: `失效条件 id 重复: ${rule.id}`,
      });
    }
    ruleIds.add(rule.id);
  }
  if (
    options.requireActiveInvalidationRules &&
    plan.status === 'active' &&
    plan.invalidationRules.length === 0
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['invalidationRules'],
      message: 'active 计划必须至少一条结构化失效条件',
    });
  }
  for (const condition of [...plan.entryConditions, ...plan.exit.triggerConditions]) {
    if (
      condition.kind === 'market-fact' &&
      condition.factId !== undefined &&
      !factIds.has(condition.factId)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['entryConditions'],
        message: `条件引用的事实不存在: ${condition.factId}`,
      });
    }
  }
  const evidenceIds = new Set(plan.evidence.map((item) => item.id));
  for (const id of plan.explanation.supportingEvidenceIds) {
    if (!evidenceIds.has(id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['explanation', 'supportingEvidenceIds'],
        message: `证据引用不存在: ${id}`,
      });
    }
  }
  if (plan.status === 'active' && plan.marketFacts.some((fact) => fact.status === 'unavailable')) {
    ctx.addIssue({
      code: 'custom',
      path: ['marketFacts'],
      message: 'active 计划不能包含 unavailable 的市场事实',
    });
  }
};

const buildTradingPlanSchema = (options: TradingPlanSchemaOptions) =>
  z
    .object({
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
      /** 结构化失效条件（可被确定性检查）；active 必须至少一条。 */
      invalidationRules: z.array(TradingPlanConditionSchema).default([]),
      /** 展示层文本；不得作为唯一失效表达。 */
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
    })
    .superRefine((plan, ctx) => tradingPlanChecks(plan, ctx, options));

/** 写路径：严格 v2。缺区间/选点/active 失效条件都会被拒。 */
export const TradingPlanV2Schema = buildTradingPlanSchema({
  requireActiveInvalidationRules: true,
});
/** 读路径：v2 结构但豁免"active 必须有失效条件"（历史行没有该字段）。 */
export const TradingPlanV2ReadableSchema = buildTradingPlanSchema({
  requireActiveInvalidationRules: false,
});

/** 旧持久化形状（冻结只读）：单值 targetPct + deltaPct，无区间/选点/结构化失效条件。 */
export const TradingPlanV1Schema = z.object({
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
  position: LegacyTradingPlanPositionSchema,
  holding: TradingPlanHoldingSchema,
  exit: TradingPlanExitSchema,
  validFrom: z.coerce.date(),
  validUntil: z.coerce.date(),
  invalidationConditions: z.array(z.string().min(1)),
  supersedesVersionId: z.string().min(1).optional(),
  accountFactsAsOf: z.coerce.date(),
  accountFactsDigest: z.string().min(8),
  marketFacts: z.array(TradingPlanMarketFactSchema),
  evidence: z.array(TradingPlanEvidenceSchema),
  source: TradingPlanSourceSchema,
  explanation: TradingPlanExplanationSchema,
  confidence: z.number().finite().min(0).max(100),
  createdAt: z.coerce.date(),
});
export type TradingPlanV1 = z.infer<typeof TradingPlanV1Schema>;

/** 旧单值计划 → v2（min=max=旧值；deltaPct 丢弃，读侧派生 deltaPctMin/Max）。 */
export const normalizeTradingPlanV1 = (plan: TradingPlanV1): TradingPlan => ({
  ...plan,
  position: normalizeTradingPlanPositionV1(plan.position),
  invalidationRules: [],
});

/**
 * 读路径 schema：v2 或 v1 都接受，统一归一化为 v2。
 * 写路径必须用 `TradingPlanV2Schema`，否则 v1 形状会被静默接受。
 */
export const TradingPlanSchema = z
  .union([TradingPlanV2ReadableSchema, TradingPlanV1Schema])
  .transform(
    (value): TradingPlan =>
      'targetPctRange' in value.position
        ? (value as unknown as TradingPlan)
        : normalizeTradingPlanV1(value as TradingPlanV1),
  );
export type TradingPlan = z.infer<typeof TradingPlanV2Schema>;

export const tradingPlanDeltaPcts = (
  plan: Pick<TradingPlan, 'position'>,
): { readonly min: number; readonly max: number } | null => {
  const { currentPct, targetPctRange } = plan.position;
  if (currentPct === null || targetPctRange === null) return null;
  return {
    min: round2(targetPctRange.min - currentPct),
    max: round2(targetPctRange.max - currentPct),
  };
};

export const TradingPlanReadSchema = z
  .object({
    ...TradingPlanV2ReadableSchema.shape,
    position: z
      .object({
        ...TradingPlanPositionSchema.shape,
        deltaPctMin: z.number().finite().min(-100).max(100).nullable(),
        deltaPctMax: z.number().finite().min(-100).max(100).nullable(),
      })
      .strict()
      .superRefine(positionRangeChecks),
  })
  .superRefine((plan, ctx) =>
    tradingPlanChecks(plan, ctx, { requireActiveInvalidationRules: false }),
  );
export type TradingPlanRead = z.infer<typeof TradingPlanReadSchema>;

export const toTradingPlanRead = (plan: TradingPlan): TradingPlanRead => {
  const delta = tradingPlanDeltaPcts(plan);
  return TradingPlanReadSchema.parse({
    ...plan,
    position: {
      ...plan.position,
      deltaPctMin: delta?.min ?? null,
      deltaPctMax: delta?.max ?? null,
    },
  });
};

const LegacySnapshotBase = {
  accountSnapshotId: z.string().min(1),
  accountSnapshotVersion: z.number().int().positive(),
} as const;
const withoutAccountFacts = { accountFactsAsOf: true, accountFactsDigest: true } as const;

const LegacyTradingPlanSnapshotSchema = z.union([
  z
    .object({ ...TradingPlanV2ReadableSchema.shape, ...LegacySnapshotBase })
    .omit(withoutAccountFacts),
  z.object({ ...TradingPlanV1Schema.shape, ...LegacySnapshotBase }).omit(withoutAccountFacts),
]);

/** 只迁移有旧快照身份且缺少账户事实的历史版本，禁止伪造当前账户指纹。 */
export const migrateLegacyTradingPlan = (value: unknown): TradingPlan | null => {
  if (
    typeof value !== 'object' ||
    value === null ||
    'accountFactsDigest' in value ||
    'accountFactsAsOf' in value
  )
    return null;
  const legacy = LegacyTradingPlanSnapshotSchema.safeParse(value);
  if (!legacy.success) return null;
  const { accountSnapshotId, accountSnapshotVersion, ...plan } = legacy.data;
  const normalized: TradingPlan =
    'targetPctRange' in plan.position
      ? (plan as TradingPlan)
      : normalizeTradingPlanV1(plan as unknown as TradingPlanV1);
  return TradingPlanV2Schema.parse({
    ...normalized,
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

/** 写时不变量：v2 严格校验（含 active 必须有结构化失效条件）。 */
export const assertTradingPlanInvariants = (plan: TradingPlan): void => {
  const parsed = TradingPlanV2Schema.safeParse(plan);
  if (!parsed.success) {
    throw new InvariantError(`trading plan invariant failed: ${parsed.error.message}`);
  }
};

/** 读时不变量：接受历史行（无结构化失效条件），其余结构校验同 v2。 */
export const assertTradingPlanReadable = (plan: unknown): TradingPlan => {
  const parsed = TradingPlanSchema.safeParse(plan);
  if (!parsed.success) {
    throw new InvariantError(`trading plan read invariant failed: ${parsed.error.message}`);
  }
  return parsed.data;
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
  const maintainMarker = (plan: TradingPlan): boolean => {
    const range = plan.position.targetPctRange;
    return (
      (plan.action === 'hold' ||
        (plan.action === 'observe' && (plan.position.currentPct ?? 0) > 0)) &&
      range !== null &&
      range.min === range.max &&
      plan.position.currentPct !== null &&
      range.min === plan.position.currentPct
    );
  };
  const terms = (plan: TradingPlan) => ({
    status: plan.status,
    action: plan.action,
    accountFactsDigest: plan.accountFactsDigest,
    entryPriceLow: plan.entryPriceLow,
    entryPriceHigh: plan.entryPriceHigh,
    entryConditions: conditions(plan, plan.entryConditions),
    invalidEntryConditions: strings(plan.invalidEntryConditions),
    targetPctRange: maintainMarker(plan) ? 'maintain' : plan.position.targetPctRange,
    appliedPct: maintainMarker(plan) ? 'maintain' : plan.position.appliedPct,
    fallbackPct: maintainMarker(plan) ? 'maintain' : plan.position.fallbackPct,
    rangePick: plan.position.rangePick,
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
    invalidationRules: conditions(plan, plan.invalidationRules),
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

export type TradingPlanInvalidation =
  | { readonly status: 'inactive'; readonly reasons: readonly string[] }
  | { readonly status: 'triggered'; readonly ruleIds: readonly string[] }
  | { readonly status: 'not-triggered' }
  | { readonly status: 'unavailable'; readonly ruleIds: readonly string[] };

/**
 * 确定性失效检查：账户事实指纹不一致时，区间与失效条件**同时**失效，不再评估任何规则。
 * 这与 `tradingPlanMonitoring` 的 `account-changed` 是同一判断，供盘中/复盘直接复用。
 */
export const tradingPlanInvalidation = (input: {
  readonly plan: TradingPlan;
  readonly facts: Pick<AccountFacts, 'digest' | 'status'> | null;
  readonly now: Date;
  readonly factsByConditionId?: ReadonlyMap<string, TradingPlanConditionFact>;
}): TradingPlanInvalidation => {
  const { plan, facts, now } = input;
  if (plan.status !== 'active' && plan.status !== 'draft') {
    return { status: 'inactive', reasons: [`status:${plan.status}`] };
  }
  if (tradingPlanExpiresAt(plan) <= now) {
    return { status: 'inactive', reasons: ['expired'] };
  }
  if (facts !== null && facts.digest !== plan.accountFactsDigest) {
    return { status: 'inactive', reasons: ['account-facts-changed'] };
  }
  if (plan.invalidationRules.length === 0) {
    return { status: 'unavailable', ruleIds: [] };
  }
  const factStatus = new Map(plan.marketFacts.map((fact) => [fact.id, fact.status]));
  const triggered: string[] = [];
  const unknown: string[] = [];
  for (const rule of plan.invalidationRules) {
    if (rule.kind === 'manual-confirmation') {
      unknown.push(rule.id);
      continue;
    }
    if (rule.kind === 'market-fact') {
      if (rule.factId === undefined || factStatus.get(rule.factId) !== 'available') {
        triggered.push(rule.id);
      }
      continue;
    }
    const result = evaluateTradingPlanCondition(rule, input.factsByConditionId ?? new Map());
    if (result === true) triggered.push(rule.id);
    else if (result === null) unknown.push(rule.id);
  }
  if (triggered.length > 0) return { status: 'triggered', ruleIds: triggered };
  if (unknown.length > 0) return { status: 'unavailable', ruleIds: unknown };
  return { status: 'not-triggered' };
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
