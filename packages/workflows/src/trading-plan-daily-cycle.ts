import { randomUUID } from 'node:crypto';

import {
  type AccountFacts,
  type Advice,
  addTradingDays,
  applyTradingPlanBudgetConstraint,
  dateInShanghai,
  isAdviceQuoteCurrent,
  isMaterialTradingPlanChange,
  isRuleFallbackAdvice,
  isUsableVolatilityPct,
  money,
  narrowTradingPlanRange,
  resolveTradingPlanVersions,
  resolveTradingPlanVolatilityPolicy,
  TRADING_PLAN_DRAFT_TRADING_DAYS,
  TRADING_PLAN_VOLATILITY_WINDOW,
  type TradingPlan,
  type TradingPlanCondition,
  type TradingPlanRangePick,
  TradingPlanReviewSchema,
  TradingPlanSchema,
  TradingPlanV2Schema,
  type TradingPlanVolatilityPolicy,
  tradingPlanExpiresAt,
  tradingPlanPickedPct,
  tradingPlanRangeWidthCap,
  tradingPlanVersionId,
  volatilityScaledRangePick,
} from '@luoome/core';
import { z } from 'zod';

import { defineWorkflow, type WorkflowContext } from './define-workflow.js';

export const TradingPlanDailyCycleInput = z.object({
  accountId: z.string().min(1).optional(),
  date: z.string().date().optional(),
  maxCandidates: z.number().int().positive().max(10).default(10),
  mode: z.enum(['manual', 'scheduled']).default('manual'),
  /**
   * 波动率 σ 下限（百分点）。缺省 0.1 —— **未标定的经验值**，需按真实 `daily_bars` 分布调整。
   * 低于下限的样本按「停牌 / 无成交」处理，选点降级到区间下限。
   * 优先级：本入参 > 环境变量 `LUOOME_TRADING_PLAN_VOLATILITY_MIN_PCT` > 0.1。
   */
  volatilityMinPct: z.number().finite().min(0).max(100).optional(),
  /**
   * 日线新鲜度上限（交易日）。缺省 5 —— **未回测的经验值**。
   * 春节 / 国庆等连续长假会让正常停更跨过该值而被误判为「数据过期」，长假前后的复核
   * 应显式调高；调高后计划里的降级文案会写出实际用的阈值，历史计划仍可解释。
   * 优先级：本入参 > 环境变量 `LUOOME_TRADING_PLAN_VOLATILITY_MAX_STALENESS_TRADING_DAYS` > 5。
   */
  volatilityMaxStalenessTradingDays: z.number().int().nonnegative().max(365).optional(),
});
export type TradingPlanDailyCycleInputT = z.infer<typeof TradingPlanDailyCycleInput>;

const PlanErrorSchema = z.object({
  stockId: z.string(),
  stage: z.enum(['holding', 'candidate', 'save']),
  reason: z.string(),
});

export const TradingPlanDailyCycleOutput = z.object({
  accountId: z.string(),
  date: z.string().date(),
  status: z.enum(['complete', 'partial', 'blocked']),
  accountFactsAsOf: z.date().optional(),
  accountFactsDigest: z.string().optional(),
  plans: z.array(TradingPlanSchema),
  holdingReviews: z.number().int().nonnegative(),
  candidateReviews: z.number().int().nonnegative(),
  errors: z.array(PlanErrorSchema),
  reviews: z.array(TradingPlanReviewSchema).default([]),
  createdPlans: z.number().int().nonnegative().default(0),
  maintainedPlans: z.number().int().nonnegative().default(0),
  draftPlans: z.number().int().nonnegative().default(0),
  budget: z.unknown().optional(),
});
export type TradingPlanDailyCycleOutputT = z.infer<typeof TradingPlanDailyCycleOutput>;

export type TradingPlanHoldingContext = {
  readonly holding: {
    readonly id: string;
    readonly accountId: string;
    readonly stockId: string;
    readonly quantity: number;
    readonly availableQuantity: number;
    readonly closedAt: Date | null;
    readonly avgCost?: number;
    readonly openedAt?: Date;
  };
  readonly stockName: string;
};

const errorText = (error: {
  readonly kind?: unknown;
  readonly message?: unknown;
  readonly cause?: unknown;
}): string =>
  typeof error.message === 'string'
    ? error.message
    : typeof error.cause === 'string'
      ? error.cause
      : String(error.kind ?? 'unknown error');

const roundPct = (value: number): number => Math.round(value * 100) / 100;

const actionForAdvice = (advice: Advice, holding: TradingPlanHoldingContext | undefined) => {
  if (holding !== undefined) {
    switch (advice.decision) {
      case 'buy':
        return 'add' as const;
      case 'sell':
        return 'exit' as const;
      case 'hold':
        return 'hold' as const;
      case 'watch':
        return 'observe' as const;
      case 'avoid':
        return 'reduce' as const;
    }
  }
  switch (advice.decision) {
    case 'buy':
      return 'enter' as const;
    case 'avoid':
      return 'avoid' as const;
    case 'sell':
      return 'avoid' as const;
    default:
      return 'observe' as const;
  }
};

const holdingWindow = (horizon: Advice['horizon']): { min: number; max: number } => {
  switch (horizon) {
    case 'intraday':
      return { min: 0, max: 1 };
    case 'short':
      return { min: 1, max: 5 };
    case 'medium':
      return { min: 5, max: 30 };
    case 'long':
      return { min: 20, max: 120 };
  }
};

const adviceStockId = (
  advice: Advice,
  holdings: readonly TradingPlanHoldingContext[],
): string | null => {
  if (advice.subjectKind === 'stock') return advice.subjectId;
  if (advice.subjectKind === 'position') {
    return holdings.find((item) => item.holding.id === advice.subjectId)?.holding.stockId ?? null;
  }
  return null;
};

const currentPositionPct = (stockId: string, accountFacts: AccountFacts): number | null => {
  if (accountFacts.totalAssets === null || accountFacts.totalAssets <= 0) return null;
  const position = accountFacts.positions.find((item) => item.stockId === stockId);
  return position === undefined
    ? 0
    : roundPct((position.marketValue / accountFacts.totalAssets) * 100);
};

/**
 * 生成器看到的波动率输入：可用样本带新鲜度与窗口，不可用时带原因。
 * 缺省（undefined）表示调用方根本没取到样本，与「取到了但不可用」在文案上区分。
 *
 * 窗口字段是必填的：可用样本必须能回答「这个 σ 是哪 21 根 bar」，否则计划落库后无法复盘。
 */
export type TradingPlanVolatilityInput =
  | {
      readonly status: 'available';
      readonly volatilityPct: number;
      readonly latestBarDate: Date;
      readonly stalenessTradingDays: number;
      readonly windowStart: Date;
      readonly windowEnd: Date;
      readonly barsCount: number;
      /** 窗口内相邻 bar 之间缺失的交易日数；0 = 无断档，> 0 = 窗口跨过停牌。 */
      readonly maxGapTradingDays: number;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: 'insufficient-daily-bars' | 'invalid-daily-bars' | 'insufficient-volatility';
      /**
       * 有效日收益率个数（仅 `insufficient-volatility` 由 `get_daily_volatility` 给出）。
       * 不足窗口宽度说明窗口跨了停牌断档或含零成交 bar——与「σ 太低」同属样本无效，
       * 但成因不同，降级文案要能说清是哪一种。
       */
      readonly returnsCount?: number;
    };

const VOLATILITY_NOTE_MISSING = '波动率不可用（daily_bars 缺 20 个交易日样本），区间选点降级取下限';
const VOLATILITY_NOTE_LOW = '波动率异常低（可能停牌或无成交），按不可用处理，取区间下限';
/** 有效收益率不足：窗口跨了停牌断档，或含 volume=0 的占位 bar（停牌但 provider 仍写了 bar）。 */
const VOLATILITY_NOTE_SHORT =
  '波动率样本不足（窗口跨停牌断档或含零成交 bar，有效日收益率少于 20 个），按不可用处理，取区间下限';

/** 只需要 warn：阈值解析失败时留一条可见记录。 */
type VolatilityThresholdLogger = {
  readonly warn: (message: string, meta?: Record<string, unknown>) => void;
};

/** 阈值也可从环境变量给（运维按真实分布标定用，不必改代码）。 */
const VOLATILITY_MIN_PCT_ENV = 'LUOOME_TRADING_PLAN_VOLATILITY_MIN_PCT';
const VOLATILITY_MAX_STALENESS_ENV = 'LUOOME_TRADING_PLAN_VOLATILITY_MAX_STALENESS_TRADING_DAYS';

const readEnvThreshold = (name: string, logger: VolatilityThresholdLogger): number | undefined => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    // 不静默吞掉：配错了要能看见，否则会以为「阈值改了但没生效」。
    logger.warn(`[trading-plan-daily-cycle] 忽略无法解析的 ${name}`, { value: raw });
    return undefined;
  }
  return value;
};

/**
 * 阈值来源优先级：显式入参 > 环境变量 > 默认值（0.1 / 5，未标定）。
 * 环境变量是给**定时路径**用的——`account-plan-batch` 不传阈值，只有 env 能在不改代码的前提下调整。
 */
const volatilityPolicyFromEnv = (
  logger: VolatilityThresholdLogger,
): Partial<TradingPlanVolatilityPolicy> => {
  const minVolatilityPct = readEnvThreshold(VOLATILITY_MIN_PCT_ENV, logger);
  const maxStalenessTradingDays = readEnvThreshold(VOLATILITY_MAX_STALENESS_ENV, logger);
  return {
    ...(minVolatilityPct === undefined ? {} : { minVolatilityPct }),
    ...(maxStalenessTradingDays === undefined ? {} : { maxStalenessTradingDays }),
  };
};

/**
 * 波动率样本能不能用来选点；能用返回 null，不能用返回降级原因。
 *
 * 两道闸门都是「看起来有样本、其实不能用」：
 * - σ 低于下限（停牌 / 长期无成交）：不是低波动，是没有有效价格，按不可用处理。
 * - 最新日线过期：两个月前的窗口不等于「当前波动率」，不静默当当前。
 * 两个阈值都来自 `policy`（默认值未标定），降级文案写出**实际用的阈值**，改阈值不破坏可复盘性。
 */
const volatilityDegradeReason = (
  volatility: TradingPlanVolatilityInput | undefined,
  policy: TradingPlanVolatilityPolicy,
): string | null => {
  if (volatility === undefined) return VOLATILITY_NOTE_MISSING;
  if (volatility.status === 'unavailable') {
    switch (volatility.reason) {
      case 'insufficient-volatility':
        return volatility.returnsCount !== undefined &&
          volatility.returnsCount < TRADING_PLAN_VOLATILITY_WINDOW
          ? VOLATILITY_NOTE_SHORT
          : VOLATILITY_NOTE_LOW;
      case 'insufficient-daily-bars':
        return VOLATILITY_NOTE_MISSING;
      case 'invalid-daily-bars':
        return '波动率样本异常（收盘价非正或日期乱序），按不可用处理，取区间下限';
    }
  }
  if (!isUsableVolatilityPct(volatility.volatilityPct, policy.minVolatilityPct))
    return VOLATILITY_NOTE_LOW;
  if (volatility.stalenessTradingDays > policy.maxStalenessTradingDays)
    return `波动率样本已过期（最新日线 ${dateInShanghai(volatility.latestBarDate)}，滞后 ${String(volatility.stalenessTradingDays)} 个交易日，阈值 ${String(policy.maxStalenessTradingDays)}），按不可用处理，取区间下限`;
  return null;
};

export const buildTradingPlanFromAdvice = (input: {
  readonly accountId: string;
  readonly accountFacts: AccountFacts;
  readonly advice: Advice;
  readonly supportingAdvices?: readonly Advice[];
  readonly holding?: TradingPlanHoldingContext;
  readonly previous: readonly TradingPlan[];
  readonly now: Date;
  /**
   * 已实现波动率样本（百分点，20 日窗口）与新鲜度；缺省表示不可用。
   * 只有非退化区间（min < max）且样本可用（σ ≥ 下限、日线不过期）才据此选点，
   * 否则降级为 `lower-bound` 并在 `constraintReasons` 说明，不猜一个波动率。
   */
  readonly volatility?: TradingPlanVolatilityInput;
  /**
   * 波动率闸门阈值（局部覆盖）；缺省用 `DEFAULT_TRADING_PLAN_VOLATILITY_POLICY` 的未标定默认值。
   * 阈值随降级文案落库，改阈值不会让历史计划失去解释力。
   */
  readonly volatilityPolicy?: Partial<TradingPlanVolatilityPolicy>;
}): TradingPlan => {
  const { advice, holding, accountFacts, now } = input;
  const stockId = adviceStockId(advice, holding === undefined ? [] : [holding]);
  if (stockId === null) throw new Error('advice is not stock or position scoped');
  const sourceAdvices = [
    advice,
    ...(input.supportingAdvices ?? []).filter((item) => item.id !== advice.id),
  ];
  const actionTerms = (item: Advice) =>
    JSON.stringify([
      item.decision,
      item.horizon,
      item.entryPriceLow ?? null,
      item.entryPriceHigh ?? null,
      item.targetPositionPct ?? null,
      item.stopLoss ?? null,
      item.targetPrice ?? null,
    ]);
  const conflictingAdvices = sourceAdvices.filter(
    (item) => !isRuleFallbackAdvice(item) && actionTerms(item) !== actionTerms(advice),
  );
  const conflictReason =
    conflictingAdvices.length === 0
      ? undefined
      : '同股策略建议的动作、价格或仓位条件不一致，需要重新研究';
  const currentPct = currentPositionPct(stockId, accountFacts);
  const action = actionForAdvice(advice, holding);
  // 观察计划（候选机会）未持仓时带 AI 给出的目标仓位，表示「条件满足后建仓多少」；
  // 已持仓的观察仍维持当前仓位，避免把等待条件的候选算成加仓。
  const candidateTargetPct =
    action === 'observe' && (currentPct === null || currentPct === 0)
      ? (advice.targetPositionPct ?? null)
      : null;
  const targetPct =
    action === 'hold' || action === 'observe'
      ? (candidateTargetPct ?? currentPct)
      : action === 'exit' || action === 'reduce' || action === 'avoid'
        ? 0
        : (advice.targetPositionPct ?? null);
  const facts = sourceAdvices.flatMap((item) => {
    const quote = item.basedOn.quotes?.[stockId];
    if (quote === undefined) return [];
    const status =
      quote.observedAt.getTime() > now.getTime()
        ? ('unknown' as const)
        : isAdviceQuoteCurrent(quote, now)
          ? ('available' as const)
          : ('stale' as const);
    return [
      {
        id: `price:${stockId}:${item.id}`,
        stockId,
        metric: 'price',
        value: quote.close,
        unit: 'CNY',
        source: quote.source,
        observedAt: quote.observedAt,
        fetchedAt: quote.fetchedAt,
        timestampSource: quote.timestampSource,
        frequency: 'quote',
        status,
      },
    ];
  });
  const evidence = [
    ...sourceAdvices.map((item) => ({
      id: `advice:${item.id}`,
      kind: 'strategy' as const,
      source: item.sourceTool ?? 'advice',
      observedAt: item.basedOn.dataAsOf,
      factIds: facts
        .filter((fact) => fact.id === `price:${stockId}:${item.id}`)
        .map((fact) => fact.id),
      summary: item.reasoning.premise,
    })),
    {
      id: `account-facts:${accountFacts.accountId}`,
      kind: 'account' as const,
      source: 'account-facts',
      observedAt: accountFacts.asOf,
      factIds: [],
      summary: `账户事实 ${accountFacts.asOf.toISOString()}（现金 ${accountFacts.cashBalance}）`,
    },
  ];
  // 观察计划同样携带条件性价位：watch ≠ 空白记录，只是「现在还没满足前提」。
  const carriesEntryPlan = action === 'enter' || action === 'add' || action === 'observe';
  const entryConditions = !carriesEntryPlan
    ? []
    : advice.entryPriceLow !== undefined && advice.entryPriceHigh !== undefined
      ? [
          {
            id: `entry:${stockId}:${advice.id}`,
            kind: 'price-range' as const,
            phase: 'entry' as const,
            metric: 'price' as const,
            comparator: 'between' as const,
            value: advice.entryPriceLow,
            valueTo: advice.entryPriceHigh,
            description: `价格处于入场区间 ${advice.entryPriceLow}-${advice.entryPriceHigh}`,
          },
        ]
      : advice.entryPrice === undefined
        ? []
        : [
            {
              id: `entry:${stockId}:${advice.id}`,
              kind: 'price-threshold' as const,
              phase: 'entry' as const,
              metric: 'price' as const,
              comparator: 'lte' as const,
              value: advice.entryPrice,
              description: `价格不高于建议买点 ${advice.entryPrice}`,
            },
          ];
  const window = holdingWindow(advice.horizon);
  const previousVersion = input.previous
    .filter((plan) => plan.id === `account:${input.accountId}:stock:${stockId}`)
    .sort((a, b) => b.version - a.version)[0];
  const version = (previousVersion?.version ?? 0) + 1;
  // 规则兜底建议（AI 不可用）没有研究结论，不能变成生效计划，只能留作草案并说明原因。
  const ruleFallback = isRuleFallbackAdvice(advice);
  const sourcesCurrent = sourceAdvices.every(
    (item) => item.validFrom <= now && item.validUntil > now,
  );
  // 结构化失效条件：行情事实过期、止损触发、目标价达成；三者皆无则只能留草案。
  const invalidationRules: TradingPlanCondition[] = [
    ...(facts.length === 0
      ? []
      : [
          {
            id: `invalidate-market:${stockId}`,
            kind: 'market-fact' as const,
            phase: 'risk' as const,
            factId: facts[0]?.id,
            description: '关键行情事实过期',
          },
        ]),
    ...(advice.stopLoss === undefined
      ? []
      : [
          {
            id: `invalidate-stop:${stockId}:${advice.id}`,
            kind: 'price-threshold' as const,
            phase: 'risk' as const,
            metric: 'price' as const,
            comparator: 'lte' as const,
            value: advice.stopLoss,
            description: `价格不高于止损 ${advice.stopLoss}，原计划前提失效`,
          },
        ]),
    ...(advice.targetPrice === undefined
      ? []
      : [
          {
            id: `invalidate-target:${stockId}:${advice.id}`,
            kind: 'price-threshold' as const,
            phase: 'exit' as const,
            metric: 'price' as const,
            comparator: 'gte' as const,
            value: advice.targetPrice,
            description: `价格达到目标 ${advice.targetPrice}，原计划前提结束`,
          },
        ]),
  ];
  const canActivate =
    sourcesCurrent &&
    accountFacts.status === 'complete' &&
    accountFacts.totalAssets !== null &&
    targetPct !== null &&
    (!carriesEntryPlan ||
      (advice.entryPriceLow !== undefined &&
        advice.entryPriceHigh !== undefined &&
        entryConditions.length > 0)) &&
    // 建仓类计划必须至少有一条可核验行情事实，否则空数组会让 every 恒真而错误激活；
    // 持有/减仓类计划不强制要求行情，但只要有事实就必须全部 available。
    (!carriesEntryPlan || facts.length > 0) &&
    facts.every((fact) => fact.status === 'available') &&
    invalidationRules.length > 0 &&
    !ruleFallback &&
    conflictReason === undefined;
  const unknowns = [
    ...(!sourcesCurrent ? ['来源建议不在有效期内，需要新证据'] : []),
    ...(conflictReason === undefined ? [] : [conflictReason]),
    ...(ruleFallback ? ['AI 推理不可用（规则兜底建议），未给出可核验的价格计划'] : []),
    ...(targetPct === null ? ['AI Advice 未提供可核验的目标仓位百分比'] : []),
    ...(advice.entryPriceLow === undefined || advice.entryPriceHigh === undefined
      ? action === 'enter' || action === 'add'
        ? ['缺少价格区间，不能标为当前可执行建仓']
        : action === 'observe'
          ? ['AI 未给出条件性价格计划，只能作为观察记录']
          : []
      : []),
    ...(accountFacts.status !== 'complete' ? ['账户事实不可用（现金待核对或持仓缺合格行情）'] : []),
    ...accountFacts.reasons,
    ...accountFacts.notes,
    ...(facts.some((fact) => fact.status !== 'available') ? ['行情时间未达到盘中实时资格'] : []),
  ];
  // 区间来源：Advice 的 targetPositionPctRange 优先；旧单值回落退化区间 {t,t}。
  const adviceRangeApplies = action === 'enter' || action === 'add' || action === 'observe';
  const requestedRange =
    adviceRangeApplies && advice.targetPositionPctRange !== undefined
      ? advice.targetPositionPctRange
      : targetPct === null
        ? null
        : { min: targetPct, max: targetPct };
  // H4 对称收窄：保中点、只削宽度；钳制后仍由 TradingPlanV2Schema 校验。
  const narrowed = requestedRange === null ? null : narrowTradingPlanRange(requestedRange);
  const targetPctRange = narrowed === null ? null : narrowed.applied;
  // 波动率样本不可用（缺样本 / σ 贴地 / 日线过期）时只降级到下限，不猜一个波动率。
  const volatilityPolicy = resolveTradingPlanVolatilityPolicy(input.volatilityPolicy);
  const volatilityDegrade = volatilityDegradeReason(input.volatility, volatilityPolicy);
  const usableVolatility =
    input.volatility !== undefined &&
    input.volatility.status === 'available' &&
    volatilityDegrade === null
      ? input.volatility
      : null;
  // 退化区间（min === max）没有可选点，仍用 lower-bound：把 `volatility-scaled` 写进零宽区间
  // 只会让复盘看到一个"选过点"的假象。
  const rangePick: TradingPlanRangePick | null =
    targetPctRange === null
      ? null
      : targetPctRange.max > targetPctRange.min && usableVolatility !== null
        ? volatilityScaledRangePick(usableVolatility.volatilityPct, {
            // 窗口与 σ 一起落库：复盘能从计划本身回答「这个 σ 是哪 21 根 bar」。
            windowStart: usableVolatility.windowStart,
            windowEnd: usableVolatility.windowEnd,
            barsCount: usableVolatility.barsCount,
            maxGapTradingDays: usableVolatility.maxGapTradingDays,
          })
        : { ruleId: 'lower-bound' as const };
  const appliedPct =
    targetPctRange === null || rangePick === null
      ? null
      : tradingPlanPickedPct(targetPctRange, rangePick);
  const fallbackPct = targetPctRange === null ? null : targetPctRange.min;
  const volatilityNote =
    targetPctRange === null ||
    targetPctRange.max <= targetPctRange.min ||
    volatilityDegrade === null
      ? []
      : [volatilityDegrade];
  const rangeAdjustment =
    narrowed === null || !narrowed.clamped || requestedRange === null || targetPctRange === null
      ? undefined
      : {
          requested: requestedRange,
          applied: targetPctRange,
          reason: 'h4-width-cap' as const,
          ruleVersion: 'trading-plan-h4-v1' as const,
        };
  const rangeAdjustmentNote =
    rangeAdjustment === undefined
      ? []
      : [
          `区间被 H4 收窄：请求 ${rangeAdjustment.requested.min}–${rangeAdjustment.requested.max}%，实际 ${rangeAdjustment.applied.min}–${rangeAdjustment.applied.max}%（上限 ${tradingPlanRangeWidthCap(rangeAdjustment.requested.max)} 个百分点）`,
        ];
  const position = {
    currentPct,
    targetPctRange,
    appliedPct,
    fallbackPct,
    rangePick,
    ...(rangeAdjustment === undefined ? {} : { rangeAdjustment }),
    constraintStatus: canActivate
      ? ('passed' as const)
      : conflictReason === undefined
        ? ('unavailable' as const)
        : ('blocked' as const),
    constraintReasons: canActivate
      ? [...rangeAdjustmentNote, ...volatilityNote]
      : [...rangeAdjustmentNote, ...volatilityNote, ...unknowns],
    prerequisiteActions:
      action === 'enter' || action === 'add'
        ? ['用户确认条件满足后手动执行；执行后更新持仓与资金记录']
        : action === 'observe'
          ? ['等待条件满足后重新评估，再决定是否建仓']
          : [],
  };
  const exit = {
    ...(advice.stopLoss === undefined ? {} : { stopLoss: money(advice.stopLoss) }),
    ...(advice.targetPrice === undefined ? {} : { takeProfit: money(advice.targetPrice) }),
    conditions: [
      ...(advice.stopLoss === undefined ? [] : [`价格触及止损 ${advice.stopLoss}`]),
      ...(advice.targetPrice === undefined ? [] : [`价格达到目标 ${advice.targetPrice}`]),
    ],
    triggerConditions: [
      ...(advice.stopLoss === undefined
        ? []
        : [
            {
              id: `exit-stop:${stockId}:${advice.id}`,
              kind: 'price-threshold' as const,
              phase: 'risk' as const,
              metric: 'price' as const,
              comparator: 'lte' as const,
              value: advice.stopLoss,
              description: `价格不高于止损 ${advice.stopLoss}`,
            },
          ]),
      ...(advice.targetPrice === undefined
        ? []
        : [
            {
              id: `exit-target:${stockId}:${advice.id}`,
              kind: 'price-threshold' as const,
              phase: 'exit' as const,
              metric: 'price' as const,
              comparator: 'gte' as const,
              value: advice.targetPrice,
              description: `价格不低于目标价 ${advice.targetPrice}`,
            },
          ]),
    ],
    canSellNow: holding !== undefined && holding.holding.availableQuantity > 0,
    ...(holding !== undefined && holding.holding.availableQuantity === 0
      ? { unavailableReason: '当前持仓可卖数量为 0' }
      : {}),
  };
  const source = {
    strategyIds: [
      ...new Set(sourceAdvices.flatMap((item) => item.basedOn.strategy?.strategyId ?? [])),
    ],
    strategyVersionIds: [
      ...new Set(sourceAdvices.flatMap((item) => item.basedOn.strategy?.strategyVersionId ?? [])),
    ],
    runIds: [...new Set(sourceAdvices.flatMap((item) => item.basedOn.strategy?.runId ?? []))],
    signalIds: [
      ...new Set(sourceAdvices.flatMap((item) => item.basedOn.strategy?.signalIds ?? [])),
    ],
    adviceIds: sourceAdvices.map((item) => item.id),
  };
  const draftDeadline = addTradingDays(now, TRADING_PLAN_DRAFT_TRADING_DAYS);
  const previousDraftDeadline =
    previousVersion?.status === 'draft' &&
    previousVersion.accountFactsDigest === accountFacts.digest
      ? tradingPlanExpiresAt(previousVersion)
      : undefined;
  return TradingPlanV2Schema.parse({
    id: `account:${input.accountId}:stock:${stockId}`,
    version,
    accountId: input.accountId,
    stockId,
    ...(advice.stockName === undefined ? {} : { stockName: advice.stockName }),
    status: canActivate ? 'active' : 'draft',
    action,
    ...(!carriesEntryPlan
      ? {}
      : advice.entryPriceLow !== undefined && advice.entryPriceHigh !== undefined
        ? {
            entryPriceLow: advice.entryPriceLow,
            entryPriceHigh: advice.entryPriceHigh,
          }
        : advice.entryPrice === undefined
          ? {}
          : { entryPriceLow: advice.entryPrice, entryPriceHigh: advice.entryPrice }),
    entryConditions,
    invalidEntryConditions: unknowns,
    position,
    holding: {
      minTradingDays: window.min,
      maxTradingDays: window.max,
      nextReviewAt: addTradingDays(now, Math.max(1, window.min)),
      earlyExitConditions: exit.conditions,
      extensionBasis: ['新证据仍支持原市场前提并通过发布前校验'],
    },
    exit,
    validFrom: now,
    validUntil: canActivate
      ? addTradingDays(now, Math.max(1, window.max))
      : previousDraftDeadline !== undefined && previousDraftDeadline > now
        ? new Date(Math.min(draftDeadline.getTime(), previousDraftDeadline.getTime()))
        : draftDeadline,
    invalidationRules,
    invalidationConditions: [
      '关键行情事实过期',
      '账户事实变化（持仓或现金变动）',
      '新计划版本替代本版本',
    ],
    ...(previousVersion === undefined
      ? {}
      : { supersedesVersionId: `${previousVersion.id}:v${previousVersion.version}` }),
    accountFactsAsOf: accountFacts.asOf,
    accountFactsDigest: accountFacts.digest,
    marketFacts: facts,
    evidence,
    source,
    explanation: {
      supportingEvidenceIds: evidence.map((item) => item.id),
      counterEvidence: [
        ...new Set(sourceAdvices.flatMap((item) => item.reasoning.counterEvidence)),
      ],
      risks: [...new Set(sourceAdvices.flatMap((item) => item.risks))],
      unknowns,
      ...(previousVersion === undefined
        ? {}
        : { changeSummary: `基于上一计划 v${previousVersion.version} 重新复核` }),
    },
    confidence: advice.confidence,
    createdAt: now,
  });
};

const run = async (
  previous: unknown,
  ctx: WorkflowContext,
): Promise<TradingPlanDailyCycleOutputT> => {
  const input = previous as TradingPlanDailyCycleInputT;
  const accountId = input.accountId ?? ctx.user.defaultAccountId;
  const now = ctx.clock();
  const date = input.date ?? dateInShanghai(now);
  const accountResult = await ctx.tools.get_account.execute({ accountId });
  if (!accountResult.ok) {
    return TradingPlanDailyCycleOutput.parse({
      accountId,
      date,
      status: 'blocked',
      plans: [],
      holdingReviews: 0,
      candidateReviews: 0,
      errors: [{ stockId: accountId, stage: 'save', reason: `account not found: ${accountId}` }],
    });
  }
  const errors: Array<z.infer<typeof PlanErrorSchema>> = [];
  // 当前持仓就是权威仓位来源（账本持仓），不再经由账户快照。
  const holdingsResult = await ctx.tools.list_holdings.execute({ accountId, status: 'active' });
  if (!holdingsResult.ok) {
    errors.push({ stockId: accountId, stage: 'holding', reason: errorText(holdingsResult.error) });
  }
  const holdings: TradingPlanHoldingContext[] = (
    holdingsResult.ok ? holdingsResult.data.holdings : []
  )
    .filter((item) => item.holding.quantity > 0)
    .map((item) => ({ holding: item.holding, stockName: item.stockName }));
  const existingResult = await ctx.tools.list_trading_plans.execute({
    accountId,
    currentOnly: true,
    limit: 500,
  });
  if (!existingResult.ok) {
    return TradingPlanDailyCycleOutput.parse({
      accountId,
      date,
      status: 'blocked',
      plans: [],
      holdingReviews: 0,
      candidateReviews: 0,
      errors: [{ stockId: accountId, stage: 'save', reason: errorText(existingResult.error) }],
    });
  }
  const existing = existingResult.data.plans;
  const advices: Array<{ advice: Advice; holding?: TradingPlanHoldingContext }> = [];
  // 内置 AI 已下线：当日行情落库改由 sync_quotes 承担；持仓建议只读取当日已持久化的
  // analyze_position 记录（无队列期不本地产生新建议，未来由外部消费者经 record_advice 写入）。
  const dayStart = new Date(`${date}T00:00:00+08:00`);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000 - 1);
  const syncResult = await ctx.tools.sync_quotes.execute({ accountId });
  if (!syncResult.ok) {
    errors.push({ stockId: accountId, stage: 'holding', reason: errorText(syncResult.error) });
  }
  // 读取口径按**建议本身的维度**过滤：真实写入方是 record_advice / complete_analysis_job，
  // 历史 sourceTool 过滤（analyze_position / analyze_strategy_candidate）已无写入方，会恒空。
  const positionAdvicesResult = await ctx.tools.get_advice.execute({
    subjectKind: 'position',
    since: dayStart,
    until: dayEnd,
    includeExpired: true,
    limit: 500,
  });
  let holdingReviews = 0;
  if (positionAdvicesResult.ok) {
    const latestBySubject = new Map<string, Advice>();
    for (const adviceValue of positionAdvicesResult.data.advices) {
      const advice = adviceValue as Advice;
      const prior = latestBySubject.get(advice.subjectId);
      if (prior === undefined || advice.createdAt > prior.createdAt)
        latestBySubject.set(advice.subjectId, advice);
    }
    for (const holding of holdings) {
      const advice =
        latestBySubject.get(holding.holding.id) ?? latestBySubject.get(holding.holding.stockId);
      if (advice === undefined) continue;
      advices.push({ advice, holding });
      holdingReviews += 1;
    }
  }
  // 当日行情已由 sync_quotes 落库；现在派生账户事实（现金字段 + 持仓 × 行情）。
  const accountFactsResult = await ctx.tools.get_account_facts.execute({ accountId });
  if (!accountFactsResult.ok) {
    return TradingPlanDailyCycleOutput.parse({
      accountId,
      date,
      status: 'blocked',
      plans: [],
      holdingReviews,
      candidateReviews: 0,
      errors: [
        { stockId: accountId, stage: 'holding', reason: errorText(accountFactsResult.error) },
      ],
    });
  }
  const accountFacts = accountFactsResult.data.facts;

  let candidateReviews = 0;
  const candidatesResult = await ctx.tools.get_advice.execute({
    subjectKind: 'stock',
    since: dayStart,
    until: dayEnd,
    includeExpired: true,
    limit: 500,
  });
  const candidateGroups = new Map<string, Advice[]>();
  if (candidatesResult.ok) {
    const holdingStocks = new Set(holdings.map((item) => item.holding.stockId));
    for (const adviceValue of candidatesResult.data.advices) {
      const advice = adviceValue as Advice;
      // 只有携带已发布运行证据的建议才是「策略候选」；普通个股建议不参与计划。
      const strategy = advice.basedOn.strategy;
      if (strategy === undefined || strategy.accountId !== accountId) continue;
      if (advice.validFrom > now || advice.validUntil <= now) continue;
      const stockId = adviceStockId(advice, holdings);
      if (stockId === null) continue;
      const group = candidateGroups.get(stockId) ?? [];
      const priorIndex = group.findIndex(
        (item) => item.basedOn.strategy?.strategyId === strategy.strategyId,
      );
      if (priorIndex < 0) group.push(advice);
      else {
        const prior = group[priorIndex] as Advice;
        if (
          advice.createdAt > prior.createdAt ||
          (advice.createdAt.getTime() === prior.createdAt.getTime() && advice.id > prior.id)
        )
          group[priorIndex] = advice;
      }
      candidateGroups.set(stockId, group);
    }
    const preferred = (group: readonly Advice[]): Advice =>
      [...group].sort(
        (a, b) =>
          Number(isRuleFallbackAdvice(a)) - Number(isRuleFallbackAdvice(b)) ||
          b.confidence - a.confidence ||
          a.id.localeCompare(b.id),
      )[0] as Advice;
    for (const [, group] of [...candidateGroups.entries()]
      .filter(([stockId]) => !holdingStocks.has(stockId))
      .sort(
        (a, b) =>
          preferred(b[1]).confidence - preferred(a[1]).confidence || a[0].localeCompare(b[0]),
      )
      .slice(0, input.maxCandidates)) {
      advices.push({ advice: preferred(group) });
      candidateReviews += 1;
    }
  } else {
    errors.push({
      stockId: accountId,
      stage: 'candidate',
      reason: errorText(candidatesResult.error),
    });
  }
  // 波动率一次批量取，按标的落到生成器：缺样本 / σ 无效的标的不会拿到可用值，选点据此降级到下限。
  // 两个阈值在入口解析一次，同时喂给数据层（σ 下限）与生成器（新鲜度上限），避免两处各判一套。
  const volatilityPolicy = resolveTradingPlanVolatilityPolicy({
    ...volatilityPolicyFromEnv(ctx.logger),
    ...(input.volatilityMinPct === undefined ? {} : { minVolatilityPct: input.volatilityMinPct }),
    ...(input.volatilityMaxStalenessTradingDays === undefined
      ? {}
      : { maxStalenessTradingDays: input.volatilityMaxStalenessTradingDays }),
  });
  const volatilityByStock = new Map<string, TradingPlanVolatilityInput>();
  const volatilityStockIds = [
    ...new Set(
      advices
        .map((item) => adviceStockId(item.advice, item.holding === undefined ? [] : [item.holding]))
        .filter((stockId): stockId is string => stockId !== null),
    ),
  ];
  if (volatilityStockIds.length > 0) {
    const volatilityResult = await ctx.tools.get_daily_volatility.execute({
      stockIds: volatilityStockIds,
      // σ 是百分点，理论上限 100：把阈值调到 100 以上在语义上是「一律不放行」，
      // 但工具入参 schema 只接受到 100。夹到 100 保持同一语义，同时让降级原因仍是
      // 「σ 过低」而不是被 schema 拒掉、伪装成「daily_bars 缺样本」。
      minVolatilityPct: Math.min(volatilityPolicy.minVolatilityPct, 100),
    });
    if (volatilityResult.ok) {
      for (const item of volatilityResult.data.items) {
        volatilityByStock.set(
          item.stockId,
          item.status === 'ok'
            ? {
                status: 'available',
                volatilityPct: item.volatilityPct,
                latestBarDate: item.latestBarDate,
                stalenessTradingDays: item.stalenessTradingDays,
                windowStart: item.windowStart,
                windowEnd: item.windowEnd,
                barsCount: item.barsCount,
                maxGapTradingDays: item.maxGapTradingDays,
              }
            : {
                status: 'unavailable',
                reason: item.reason,
                ...(item.returnsCount === undefined ? {} : { returnsCount: item.returnsCount }),
              },
        );
      }
    } else {
      ctx.logger.warn('[trading-plan-daily-cycle] get_daily_volatility failed', {
        error: volatilityResult.error,
      });
    }
  }
  const plans: TradingPlan[] = [];
  const reviews: Array<z.infer<typeof TradingPlanReviewSchema>> = [];
  for (const item of advices) {
    const stockId = adviceStockId(item.advice, item.holding === undefined ? [] : [item.holding]);
    if (stockId === null) continue;
    try {
      const volatility = volatilityByStock.get(stockId);
      const previousPlans = existing.filter((plan) => plan.stockId === stockId);
      const prior = resolveTradingPlanVersions(previousPlans);
      const draft = buildTradingPlanFromAdvice({
        accountId,
        accountFacts,
        advice: item.advice,
        supportingAdvices:
          candidateGroups.get(stockId)?.filter((supporting) => supporting.id !== item.advice.id) ??
          [],
        ...(item.holding === undefined ? {} : { holding: item.holding }),
        ...(volatility === undefined ? {} : { volatility }),
        volatilityPolicy,
        previous: previousPlans,
        // 计划在行情抓取与 AI 分析之后构建，必须用构建时刻的时钟；沿用工作流启动时刻会把
        // retrieval 口径的抓取时间（必然晚于启动时钟）误判为未来时间，计划被压成草案。
        now: ctx.clock(),
      });
      const budgetResult = await ctx.tools.evaluate_trading_plan_budget.execute({
        accountId,
        candidate: draft,
      });
      const candidate = budgetResult.ok
        ? applyTradingPlanBudgetConstraint(draft, budgetResult.data)
        : draft;
      const reuse = (candidate: TradingPlan): TradingPlan | undefined => {
        const latest = prior.latest;
        if (latest === undefined || latest.accountFactsDigest !== candidate.accountFactsDigest)
          return undefined;
        if (candidate.status === 'draft' && latest.status === 'draft') {
          if (
            tradingPlanExpiresAt(latest) <= ctx.clock() ||
            !isMaterialTradingPlanChange(latest, candidate)
          )
            return latest;
        }
        if (
          candidate.status === 'active' &&
          latest.status === 'active' &&
          latest.validFrom <= ctx.clock() &&
          latest.validUntil > ctx.clock() &&
          !isMaterialTradingPlanChange(latest, candidate)
        )
          return latest;
        return undefined;
      };
      const remember = (
        plan: TradingPlan,
        outcome: z.infer<typeof TradingPlanReviewSchema>['outcome'],
        reviewed = draft,
      ) => {
        plans.push(plan);
        reviews.push({
          stockId,
          versionId: tradingPlanVersionId(plan),
          outcome,
          reviewedAt: ctx.clock(),
          adviceIds: draft.source.adviceIds,
          reasons: plan.status === 'draft' ? reviewed.position.constraintReasons : [],
        });
      };
      const maintained = reuse(candidate);
      if (maintained !== undefined) {
        remember(maintained, maintained.status === 'active' ? 'maintained' : 'unchanged-draft');
        continue;
      }
      let saved = await ctx.tools.save_trading_plan.execute({ plan: candidate });
      if (!saved.ok && candidate.status === 'active') {
        const blocked = TradingPlanV2Schema.parse({
          ...candidate,
          status: 'draft',
          validUntil:
            prior.latest?.status === 'draft' &&
            prior.latest.accountFactsDigest === draft.accountFactsDigest &&
            tradingPlanExpiresAt(prior.latest) > ctx.clock()
              ? tradingPlanExpiresAt(prior.latest)
              : addTradingDays(draft.createdAt, TRADING_PLAN_DRAFT_TRADING_DAYS),
          position: {
            ...candidate.position,
            constraintStatus: 'blocked',
            constraintReasons: [errorText(saved.error)],
          },
          explanation: {
            ...candidate.explanation,
            unknowns: [...candidate.explanation.unknowns, errorText(saved.error)],
          },
        });
        const unchanged = reuse(blocked);
        if (unchanged !== undefined) {
          remember(unchanged, 'unchanged-draft', blocked);
          continue;
        }
        saved = await ctx.tools.save_trading_plan.execute({ plan: blocked });
      }
      if (saved.ok) remember(saved.data.plan, 'created', saved.data.plan);
      else errors.push({ stockId, stage: 'save', reason: errorText(saved.error) });
    } catch (error) {
      errors.push({
        stockId,
        stage: 'save',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const budgetResult = await ctx.tools.evaluate_trading_plan_budget.execute({ accountId });
  const draftPlans = plans.filter((plan) => plan.status === 'draft').length;
  const output = TradingPlanDailyCycleOutput.parse({
    accountId,
    date,
    status:
      errors.length === 0 && draftPlans === 0
        ? 'complete'
        : plans.length > 0
          ? 'partial'
          : 'blocked',
    ...(accountFacts === undefined
      ? {}
      : { accountFactsAsOf: accountFacts.asOf, accountFactsDigest: accountFacts.digest }),
    plans,
    holdingReviews,
    candidateReviews,
    errors,
    reviews,
    createdPlans: reviews.filter((review) => review.outcome === 'created').length,
    maintainedPlans: reviews.filter((review) => review.outcome === 'maintained').length,
    draftPlans,
    ...(budgetResult.ok ? { budget: budgetResult.data } : {}),
  });
  const audited = await ctx.tools.record_workflow_run.execute({
    run: {
      id: randomUUID(),
      workflowName: 'trading-plan-daily-cycle',
      mode: input.mode,
      status:
        output.status === 'complete'
          ? 'succeeded'
          : output.status === 'partial'
            ? 'partial'
            : 'failed',
      startedAt: now,
      finishedAt: ctx.clock(),
      inputSummary: { accountId, date },
      outputSummary: {
        createdPlans: output.createdPlans,
        maintainedPlans: output.maintainedPlans,
        draftPlans,
        reviews,
        errors,
      },
      providerStatuses: [],
      ...(output.status === 'blocked' ? { error: '交易计划复核未完成' } : {}),
    },
  });
  if (!audited.ok) {
    output.errors.push({ stockId: accountId, stage: 'save', reason: errorText(audited.error) });
    if (output.status === 'complete') output.status = 'partial';
  }
  return output;
};

export const tradingPlanDailyCycleWorkflow = defineWorkflow<
  TradingPlanDailyCycleInputT,
  TradingPlanDailyCycleOutputT
>({
  name: 'trading-plan-daily-cycle',
  description: '统一复核账户全部持仓与新增候选，生成结构化计划并合并校验组合预算',
  input: TradingPlanDailyCycleInput,
  steps: [run],
});
