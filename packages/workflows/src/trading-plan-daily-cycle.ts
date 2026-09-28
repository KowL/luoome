import {
  type AccountFacts,
  type Advice,
  addTradingDays,
  dateInShanghai,
  isAdviceQuoteCurrent,
  isRuleFallbackAdvice,
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
  readonly supportingAdvices?: readonly Advice[];
  readonly holding?: TradingPlanHoldingContext;
  readonly previous: readonly TradingPlan[];
  readonly now: Date;
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
      : `同股策略建议的动作、价格或仓位条件不一致（${[advice.id, ...conflictingAdvices.map((item) => item.id)].join('、')}），需要重新研究`;
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
  const canActivate =
    accountFacts.status === 'complete' &&
    accountFacts.totalAssets !== null &&
    targetPct !== null &&
    (!carriesEntryPlan ||
      (advice.entryPriceLow !== undefined &&
        advice.entryPriceHigh !== undefined &&
        entryConditions.length > 0)) &&
    facts.every((fact) => fact.status === 'available') &&
    !ruleFallback &&
    conflictReason === undefined;
  const unknowns = [
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
  const position = {
    currentPct,
    targetPct,
    deltaPct: currentPct !== null && targetPct !== null ? roundPct(targetPct - currentPct) : null,
    constraintStatus: canActivate
      ? ('passed' as const)
      : conflictReason === undefined
        ? ('unavailable' as const)
        : ('blocked' as const),
    constraintReasons: canActivate ? [] : unknowns,
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
  return TradingPlanSchema.parse({
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
    validFrom: advice.validFrom,
    validUntil:
      advice.validUntil.getTime() > now.getTime() ? advice.validUntil : addTradingDays(now, 1),
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

  let candidateReviews = 0;
  const dayStart = new Date(`${date}T00:00:00+08:00`);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000 - 1);
  const candidatesResult = await ctx.tools.get_advice.execute({
    sourceTool: 'analyze_strategy_candidate',
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
      const strategy = advice.basedOn.strategy;
      if (strategy?.accountId !== accountId) continue;
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
        supportingAdvices:
          candidateGroups.get(stockId)?.filter((supporting) => supporting.id !== item.advice.id) ??
          [],
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
    candidateReviews,
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
