import {
  type AccountFacts,
  type Advice,
  addTradingDays,
  dateInShanghai,
  isAdviceQuoteCurrent,
  money,
  type TradingPlan,
  TradingPlanSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineWorkflow, type WorkflowContext } from './define-workflow.js';

export const TradingPlanDailyCycleInput = z.object({
  accountId: z.string().min(1).optional(),
  date: z.string().date().optional(),
  maxCandidates: z.number().int().positive().max(10).default(10),
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

export const buildTradingPlanFromAdvice = (input: {
  readonly accountId: string;
  readonly accountFacts: AccountFacts;
  readonly advice: Advice;
  readonly holding?: TradingPlanHoldingContext;
  readonly previous: readonly TradingPlan[];
  readonly now: Date;
}): TradingPlan => {
  const { advice, holding, accountFacts, now } = input;
  const stockId = adviceStockId(advice, holding === undefined ? [] : [holding]);
  if (stockId === null) throw new Error('advice is not stock or position scoped');
  const currentPct = currentPositionPct(stockId, accountFacts);
  const action = actionForAdvice(advice, holding);
  const targetPct =
    action === 'hold' || action === 'observe'
      ? currentPct
      : action === 'exit' || action === 'reduce' || action === 'avoid'
        ? 0
        : (advice.targetPositionPct ?? null);
  const quote = advice.basedOn.quotes?.[stockId];
  const factStatus =
    quote === undefined
      ? ('unknown' as const)
      : quote.observedAt.getTime() > now.getTime()
        ? ('unknown' as const)
        : isAdviceQuoteCurrent(quote, now)
          ? ('available' as const)
          : ('stale' as const);
  const facts =
    quote === undefined
      ? []
      : [
          {
            id: `price:${stockId}:${advice.id}`,
            stockId,
            metric: 'price',
            value: quote.close,
            unit: 'CNY',
            source: quote.source,
            observedAt: quote.observedAt,
            fetchedAt: quote.fetchedAt,
            timestampSource: quote.timestampSource,
            frequency: 'quote',
            status: factStatus,
          },
        ];
  const evidence = [
    {
      id: `advice:${advice.id}`,
      kind: 'strategy' as const,
      source: advice.sourceTool ?? 'advice',
      observedAt: advice.basedOn.dataAsOf,
      factIds: facts.map((fact) => fact.id),
      summary: advice.reasoning.premise,
    },
    {
      id: `account-facts:${accountFacts.accountId}`,
      kind: 'account' as const,
      source: 'account-facts',
      observedAt: accountFacts.asOf,
      factIds: [],
      summary: `账户事实 ${accountFacts.asOf.toISOString()}（现金 ${accountFacts.cashBalance}）`,
    },
  ];
  const entryConditions =
    action === 'enter' || action === 'add'
      ? advice.entryPriceLow !== undefined && advice.entryPriceHigh !== undefined
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
                description: `价格不高于旧版建议买点 ${advice.entryPrice}`,
              },
            ]
      : [];
  const window = holdingWindow(advice.horizon);
  const previousVersion = input.previous
    .filter((plan) => plan.id === `account:${input.accountId}:stock:${stockId}`)
    .sort((a, b) => b.version - a.version)[0];
  const version = (previousVersion?.version ?? 0) + 1;
  const canActivate =
    accountFacts.status === 'complete' &&
    accountFacts.totalAssets !== null &&
    targetPct !== null &&
    ((action !== 'enter' && action !== 'add') ||
      (advice.entryPriceLow !== undefined &&
        advice.entryPriceHigh !== undefined &&
        entryConditions.length > 0)) &&
    facts.every((fact) => fact.status === 'available');
  const unknowns = [
    ...(targetPct === null ? ['AI Advice 未提供可核验的目标仓位百分比'] : []),
    ...(advice.entryPriceLow === undefined || advice.entryPriceHigh === undefined
      ? action === 'enter' || action === 'add'
        ? ['缺少价格区间，不能标为当前可执行建仓']
        : []
      : []),
    ...(accountFacts.status !== 'complete' ? ['账户事实不可用（现金待核对或持仓缺合格行情）'] : []),
    ...(facts.some((fact) => fact.status !== 'available') ? ['行情时间未达到盘中实时资格'] : []),
  ];
  const position = {
    currentPct,
    targetPct,
    deltaPct: currentPct !== null && targetPct !== null ? roundPct(targetPct - currentPct) : null,
    constraintStatus: canActivate ? ('passed' as const) : ('unavailable' as const),
    constraintReasons: canActivate ? [] : unknowns,
    prerequisiteActions:
      action === 'enter' || action === 'add'
        ? ['用户确认条件满足后手动执行；执行后更新账户快照']
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
  const source =
    advice.basedOn.strategy === undefined
      ? {
          strategyIds: [],
          strategyVersionIds: [],
          runIds: [],
          signalIds: [],
          adviceIds: [advice.id],
        }
      : {
          strategyIds: [advice.basedOn.strategy.strategyId],
          strategyVersionIds: [advice.basedOn.strategy.strategyVersionId],
          runIds: [advice.basedOn.strategy.runId],
          signalIds: [...advice.basedOn.strategy.signalIds],
          adviceIds: [advice.id],
        };
  return TradingPlanSchema.parse({
    id: `account:${input.accountId}:stock:${stockId}`,
    version,
    accountId: input.accountId,
    stockId,
    ...(advice.stockName === undefined ? {} : { stockName: advice.stockName }),
    status: canActivate ? 'active' : 'draft',
    action,
    ...(action !== 'enter' && action !== 'add'
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
    validFrom: advice.validFrom,
    validUntil:
      advice.validUntil.getTime() > now.getTime() ? advice.validUntil : addTradingDays(now, 1),
    invalidationConditions: ['关键行情事实过期', '账户快照版本改变', '新计划版本替代本版本'],
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
      counterEvidence: [...advice.reasoning.counterEvidence],
      risks: [...advice.risks],
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
    return {
      accountId,
      date,
      status: 'blocked',
      plans: [],
      holdingReviews: 0,
      candidateReviews: 0,
      errors: [{ stockId: accountId, stage: 'save', reason: `account not found: ${accountId}` }],
    };
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
  const existingResult = await ctx.tools.list_trading_plans.execute({ accountId, limit: 500 });
  const existing = existingResult.ok ? existingResult.data.plans : [];
  const advices: Array<{ advice: Advice; holding?: TradingPlanHoldingContext }> = [];
  const positionResults = await Promise.all(
    holdings.map(async (holding) => ({
      holding,
      result: await ctx.tools.analyze_position.execute({ holdingId: holding.holding.id }),
    })),
  );
  for (const item of positionResults) {
    if (item.result.ok)
      advices.push({ advice: item.result.data.advice as Advice, holding: item.holding });
    else
      errors.push({
        stockId: item.holding.holding.stockId,
        stage: 'holding',
        reason: errorText(item.result.error),
      });
  }
  // 每个持仓的 analyze_position 已把当日行情落库；现在派生账户事实（现金字段 + 持仓 × 行情）。
  const accountFactsResult = await ctx.tools.get_account_facts.execute({ accountId });
  if (!accountFactsResult.ok) {
    return {
      accountId,
      date,
      status: 'blocked',
      plans: [],
      holdingReviews: positionResults.length,
      candidateReviews: 0,
      errors: [
        { stockId: accountId, stage: 'holding', reason: errorText(accountFactsResult.error) },
      ],
    };
  }
  const accountFacts = accountFactsResult.data.facts;

  const dayStart = new Date(`${date}T00:00:00+08:00`);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000 - 1);
  const candidatesResult = await ctx.tools.get_advice.execute({
    sourceTool: 'analyze_strategy_candidate',
    since: dayStart,
    until: dayEnd,
    includeExpired: true,
    limit: 500,
  });
  if (candidatesResult.ok) {
    const holdingStocks = new Set(holdings.map((item) => item.holding.stockId));
    const byStock = new Map<string, Advice>();
    for (const adviceValue of candidatesResult.data.advices) {
      const advice = adviceValue as Advice;
      if (advice.basedOn.strategy?.accountId !== accountId) continue;
      const stockId = adviceStockId(advice, holdings);
      if (stockId === null || holdingStocks.has(stockId)) continue;
      const current = byStock.get(stockId);
      if (current === undefined || advice.confidence > current.confidence)
        byStock.set(stockId, advice as Advice);
    }
    for (const advice of [...byStock.values()]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, input.maxCandidates)) {
      advices.push({ advice });
    }
  } else {
    errors.push({
      stockId: accountId,
      stage: 'candidate',
      reason: errorText(candidatesResult.error),
    });
  }
  const plans: TradingPlan[] = [];
  for (const item of advices) {
    const stockId = adviceStockId(item.advice, item.holding === undefined ? [] : [item.holding]);
    if (stockId === null) continue;
    try {
      const previousPlans = existing.filter((plan) => plan.stockId === stockId);
      const draft = buildTradingPlanFromAdvice({
        accountId,
        accountFacts,
        advice: item.advice,
        ...(item.holding === undefined ? {} : { holding: item.holding }),
        previous: previousPlans,
        now,
      });
      let saved = await ctx.tools.save_trading_plan.execute({ plan: draft });
      if (!saved.ok && draft.status === 'active') {
        const blocked = TradingPlanSchema.parse({
          ...draft,
          status: 'draft',
          position: {
            ...draft.position,
            constraintStatus: 'blocked',
            constraintReasons: [errorText(saved.error)],
          },
          explanation: {
            ...draft.explanation,
            unknowns: [...draft.explanation.unknowns, errorText(saved.error)],
          },
        });
        saved = await ctx.tools.save_trading_plan.execute({ plan: blocked });
      }
      if (saved.ok) plans.push(saved.data.plan);
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
  return TradingPlanDailyCycleOutput.parse({
    accountId,
    date,
    status: errors.length === 0 ? 'complete' : plans.length > 0 ? 'partial' : 'blocked',
    ...(accountFacts === undefined
      ? {}
      : { accountFactsAsOf: accountFacts.asOf, accountFactsDigest: accountFacts.digest }),
    plans,
    holdingReviews: positionResults.length,
    candidateReviews: Math.max(0, advices.length - positionResults.length),
    errors,
    ...(budgetResult.ok ? { budget: budgetResult.data } : {}),
  });
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
