import {
  type AccountSnapshot,
  type Advice,
  dateInShanghai,
  evaluateTradingPlanCondition,
  money,
  type TradingPlan,
  type TradingPlanCondition,
  type TradingPlanConditionFact,
  type TradingPlanMarketFact,
  tradingPlanVersionId,
  type WatchTrigger,
  WatchTriggerSchema,
} from '@luoome/core';
import { z } from 'zod';
import { defineWorkflow, type WorkflowContext } from './define-workflow.js';
import {
  buildTradingPlanFromAdvice,
  type TradingPlanHoldingContext,
} from './trading-plan-daily-cycle.js';

export const IntradayTradingPlanWatchInput = z.object({
  accountId: z.string().min(1).optional(),
  notify: z.boolean().default(true),
  watchIntervalSeconds: z.number().int().positive().max(3600).default(60),
  cooldownMinutes: z
    .number()
    .int()
    .nonnegative()
    .max(24 * 60)
    .default(60),
  dailyNotificationLimit: z.number().int().positive().max(500).default(50),
});
export type IntradayTradingPlanWatchInputT = z.infer<typeof IntradayTradingPlanWatchInput>;

const PlanReviewSchema = z.object({
  stockId: z.string(),
  status: z.enum(['saved', 'blocked', 'failed', 'skipped']),
  planVersionId: z.string().optional(),
  reason: z.string().optional(),
});

export const IntradayTradingPlanWatchOutput = z.object({
  accountId: z.string(),
  date: z.string().date(),
  status: z.enum(['complete', 'partial', 'blocked']),
  checkedPlans: z.number().int().nonnegative(),
  freshQuotes: z.number().int().nonnegative(),
  stalePlans: z.number().int().nonnegative(),
  triggers: z.array(WatchTriggerSchema),
  reviewedPlans: z.array(PlanReviewSchema),
  notified: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  suppressedByCooldown: z.number().int().nonnegative(),
  suppressedByDailyLimit: z.number().int().nonnegative(),
  notifyFailed: z.number().int().nonnegative(),
  errors: z.array(z.string()),
});
export type IntradayTradingPlanWatchOutputT = z.infer<typeof IntradayTradingPlanWatchOutput>;

type BatchQuoteItem = {
  readonly stockId: string;
  readonly status: 'ok' | 'unresolved' | 'unavailable';
  readonly quote?: {
    readonly close: number;
    readonly prevClose?: number;
    readonly observedAt: Date;
    readonly source: string;
  };
  readonly freshness?: 'fresh' | 'stale';
  readonly reason?: string;
};

type Candidate = {
  readonly trigger: WatchTrigger;
  readonly plan: TradingPlan;
  readonly condition: TradingPlanCondition;
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

const dayStart = (now: Date): Date => new Date(`${dateInShanghai(now)}T00:00:00+08:00`);

const conditionRuleKind = (condition: TradingPlanCondition): WatchTrigger['ruleKind'] => {
  if (condition.kind === 'price-range' || condition.kind === 'price-threshold')
    return 'price-level';
  if (condition.kind === 'change-pct-threshold') return 'price-change';
  return 'strategy-signal';
};

const priorityForCondition = (
  plan: TradingPlan,
  condition: TradingPlanCondition,
): WatchTrigger['priority'] => {
  if (condition.phase === 'risk') return 'urgent';
  if (condition.phase === 'exit' || plan.action === 'reduce' || plan.action === 'exit')
    return 'important';
  return 'normal';
};

const directionForCondition = (
  plan: TradingPlan,
  condition: TradingPlanCondition,
): WatchTrigger['direction'] => {
  if (
    condition.phase === 'risk' ||
    condition.phase === 'exit' ||
    plan.action === 'reduce' ||
    plan.action === 'exit'
  ) {
    return 'sell';
  }
  if (plan.action === 'enter' || plan.action === 'add') return 'buy';
  return 'watch';
};

const factForMarketFact = (fact: TradingPlanMarketFact): TradingPlanConditionFact => ({
  metric: ['price', 'changePct', 'marketIndexChangePct', 'marketBreadthPct'].includes(fact.metric)
    ? (fact.metric as TradingPlanConditionFact['metric'])
    : 'price',
  value: fact.value,
});

const conditionFacts = (
  plan: TradingPlan,
  condition: TradingPlanCondition,
  quote: BatchQuoteItem['quote'],
): ReadonlyMap<string, TradingPlanConditionFact> => {
  const facts = new Map<string, TradingPlanConditionFact>();
  for (const fact of plan.marketFacts) {
    if (fact.status === 'available') facts.set(fact.id, factForMarketFact(fact));
  }
  if (quote === undefined) return facts;
  if (condition.metric === 'price') {
    facts.set(condition.id, { metric: 'price', value: quote.close });
  } else if (
    condition.metric === 'changePct' &&
    quote.prevClose !== undefined &&
    quote.prevClose > 0
  ) {
    facts.set(condition.id, {
      metric: 'changePct',
      value: ((quote.close - quote.prevClose) / quote.prevClose) * 100,
    });
  }
  return facts;
};

const evaluate = (
  plan: TradingPlan,
  condition: TradingPlanCondition,
  quote: BatchQuoteItem['quote'],
): boolean | null => {
  if (condition.kind === 'manual-confirmation') return null;
  if (condition.kind === 'market-fact') {
    const fact = plan.marketFacts.find((item) => item.id === condition.factId);
    return fact?.status === 'available' ? true : null;
  }
  return evaluateTradingPlanCondition(condition, conditionFacts(plan, condition, quote));
};

const triggerFor = (
  plan: TradingPlan,
  condition: TradingPlanCondition,
  quote: BatchQuoteItem['quote'],
  now: Date,
  poolId: string,
): WatchTrigger => {
  const versionId = tradingPlanVersionId(plan);
  const observedAt =
    quote?.observedAt ??
    plan.marketFacts.find((fact) => fact.id === condition.factId)?.observedAt ??
    now;
  const quoteText = quote === undefined ? '行情未提供价格' : `现价 ${quote.close}`;
  return {
    id: `trading-plan-trigger:${versionId}:${condition.id}:${observedAt.getTime()}`,
    alertPlanId: poolId,
    poolId,
    stockId: plan.stockId,
    ruleKind: conditionRuleKind(condition),
    ruleId: `${versionId}:${condition.id}`,
    direction: directionForCondition(plan, condition),
    triggerType: 'triggered',
    reason:
      `${plan.action} 计划命中条件：${condition.description}；${quoteText}；计划版本 ${versionId}`.slice(
        0,
        500,
      ),
    evidence: [
      `plan:${versionId}`,
      `condition:${condition.id}`,
      `observedAt:${observedAt.toISOString()}`,
    ],
    ...(quote === undefined ? {} : { quote: { close: money(quote.close), ts: quote.observedAt } }),
    priority: priorityForCondition(plan, condition),
    deliveryStatus: 'not-requested',
    evalSnapshot: {
      planVersionId: versionId,
      conditionId: condition.id,
      conditionKind: condition.kind,
      conditionDescription: condition.description,
      quoteClose: quote?.close,
      quoteObservedAt: quote?.observedAt,
      quoteSource: quote?.source,
      accountSnapshotId: plan.accountSnapshotId,
      accountSnapshotVersion: plan.accountSnapshotVersion,
      validUntil: plan.validUntil,
    },
    notified: false,
    createdAt: now,
  };
};

const notificationContent = (candidate: Candidate): string => {
  const plan = candidate.plan;
  const target = plan.position.targetPct === null ? '不可用' : `${plan.position.targetPct}%`;
  const price =
    plan.entryPriceLow === undefined || plan.entryPriceHigh === undefined
      ? '未提供'
      : `${plan.entryPriceLow} - ${plan.entryPriceHigh}`;
  return [
    `股票：${plan.stockName ?? plan.stockId}`,
    `动作：${plan.action}`,
    `命中条件：${candidate.condition.description}`,
    `入场区间：${price}`,
    `目标仓位：${target}`,
    `计划版本：${tradingPlanVersionId(plan)}`,
    `数据时间：${candidate.trigger.evalSnapshot.quoteObservedAt ?? candidate.trigger.createdAt.toISOString()}`,
    `有效期至：${plan.validUntil.toISOString()}`,
    `风险：${plan.explanation.risks.join('；') || '未记录'}`,
    `未知：${plan.explanation.unknowns.join('；') || '未记录'}`,
    '本信号仅提示研究计划条件已满足，不代表成交或自动下单。',
  ].join('\n');
};

const reviewTriggeredHoldings = async (
  candidates: readonly Candidate[],
  accountId: string,
  snapshot: AccountSnapshot,
  ctx: WorkflowContext,
): Promise<{
  reviews: IntradayTradingPlanWatchOutputT['reviewedPlans'];
  replacedTriggerIds: ReadonlySet<string>;
}> => {
  const riskCandidates = candidates.filter(
    (candidate) => candidate.condition.phase === 'risk' || candidate.condition.phase === 'exit',
  );
  if (riskCandidates.length === 0) return { reviews: [], replacedTriggerIds: new Set() };
  const holdingsResult = await ctx.tools.list_holdings.execute({ accountId, status: 'active' });
  if (!holdingsResult.ok) {
    return {
      reviews: riskCandidates.map((candidate) => ({
        stockId: candidate.plan.stockId,
        status: 'failed' as const,
        reason: errorText(holdingsResult.error),
      })),
      replacedTriggerIds: new Set(),
    };
  }
  const holdingByStock = new Map(
    holdingsResult.data.holdings.map((item) => [item.holding.stockId, item] as const),
  );
  const reviews: IntradayTradingPlanWatchOutputT['reviewedPlans'] = [];
  const replacedTriggerIds = new Set<string>();
  for (const candidate of riskCandidates) {
    const holding = holdingByStock.get(candidate.plan.stockId) as
      | TradingPlanHoldingContext
      | undefined;
    if (holding === undefined) {
      reviews.push({
        stockId: candidate.plan.stockId,
        status: 'skipped',
        reason: '当前无活跃持仓',
      });
      continue;
    }
    const adviceResult = await ctx.tools.analyze_position.execute({
      holdingId: holding.holding.id,
    });
    if (!adviceResult.ok) {
      reviews.push({
        stockId: candidate.plan.stockId,
        status: 'failed',
        reason: errorText(adviceResult.error),
      });
      continue;
    }
    const existingResult = await ctx.tools.list_trading_plans.execute({
      accountId,
      stockId: candidate.plan.stockId,
      limit: 500,
    });
    const previous = existingResult.ok ? existingResult.data.plans : [candidate.plan];
    const next = buildTradingPlanFromAdvice({
      accountId,
      snapshot,
      advice: adviceResult.data.advice as Advice,
      holding,
      previous,
      now: ctx.clock(),
    });
    let saved = await ctx.tools.save_trading_plan.execute({ plan: next });
    if (!saved.ok && next.status === 'active') {
      saved = await ctx.tools.save_trading_plan.execute({
        plan: {
          ...next,
          status: 'draft',
          position: {
            ...next.position,
            constraintStatus: 'blocked',
            constraintReasons: [errorText(saved.error)],
          },
          explanation: {
            ...next.explanation,
            unknowns: [...next.explanation.unknowns, errorText(saved.error)],
          },
        },
      });
    }
    if (!saved.ok) {
      reviews.push({
        stockId: candidate.plan.stockId,
        status: 'failed',
        reason: errorText(saved.error),
      });
      continue;
    }
    replacedTriggerIds.add(candidate.trigger.id);
    reviews.push({
      stockId: candidate.plan.stockId,
      status: 'saved',
      planVersionId: tradingPlanVersionId(saved.data.plan),
    });
  }
  return { reviews, replacedTriggerIds };
};

const run = async (
  input: IntradayTradingPlanWatchInputT,
  ctx: WorkflowContext,
): Promise<IntradayTradingPlanWatchOutputT> => {
  const accountId = input.accountId ?? ctx.user.defaultAccountId;
  const now = ctx.clock();
  const date = dateInShanghai(now);
  const errors: string[] = [];
  const snapshotResult = await ctx.tools.get_account_snapshot.execute({ accountId });
  if (!snapshotResult.ok) {
    return {
      accountId,
      date,
      status: 'blocked',
      checkedPlans: 0,
      freshQuotes: 0,
      stalePlans: 0,
      triggers: [],
      reviewedPlans: [],
      notified: 0,
      delivered: 0,
      suppressedByCooldown: 0,
      suppressedByDailyLimit: 0,
      notifyFailed: 0,
      errors: [errorText(snapshotResult.error)],
    };
  }
  const snapshot = snapshotResult.data.snapshot;
  if (snapshot.status !== 'complete' || snapshot.totalAssets === null) {
    return {
      accountId,
      date,
      status: 'blocked',
      checkedPlans: 0,
      freshQuotes: 0,
      stalePlans: 0,
      triggers: [],
      reviewedPlans: [],
      notified: 0,
      delivered: 0,
      suppressedByCooldown: 0,
      suppressedByDailyLimit: 0,
      notifyFailed: 0,
      errors: ['账户快照待核对，暂停精确盘中计划监控'],
    };
  }
  const plansResult = await ctx.tools.list_trading_plans.execute({
    accountId,
    activeOnly: true,
    limit: 500,
  });
  if (!plansResult.ok) {
    return {
      accountId,
      date,
      status: 'blocked',
      checkedPlans: 0,
      freshQuotes: 0,
      stalePlans: 0,
      triggers: [],
      reviewedPlans: [],
      notified: 0,
      delivered: 0,
      suppressedByCooldown: 0,
      suppressedByDailyLimit: 0,
      notifyFailed: 0,
      errors: [errorText(plansResult.error)],
    };
  }
  const plans = plansResult.data.plans.filter(
    (plan) =>
      plan.accountSnapshotId === snapshot.id &&
      plan.accountSnapshotVersion === snapshot.version &&
      plan.validFrom.getTime() <= now.getTime() &&
      plan.validUntil.getTime() > now.getTime(),
  );
  const stalePlans = plansResult.data.plans.length - plans.length;
  if (stalePlans > 0) errors.push(`${stalePlans} 个计划因账户版本或有效期不匹配未监控`);
  if (plans.length === 0) {
    return {
      accountId,
      date,
      status: stalePlans > 0 ? 'partial' : 'complete',
      checkedPlans: 0,
      freshQuotes: 0,
      stalePlans,
      triggers: [],
      reviewedPlans: [],
      notified: 0,
      delivered: 0,
      suppressedByCooldown: 0,
      suppressedByDailyLimit: 0,
      notifyFailed: 0,
      errors,
    };
  }
  const quotesResult = await ctx.tools.batch_quote.execute({
    stockIds: [...new Set(plans.map((plan) => plan.stockId))],
    context: 'intraday-rule',
    watchIntervalSeconds: input.watchIntervalSeconds,
  });
  if (!quotesResult.ok) {
    return {
      accountId,
      date,
      status: 'partial',
      checkedPlans: plans.length,
      freshQuotes: 0,
      stalePlans,
      triggers: [],
      reviewedPlans: [],
      notified: 0,
      delivered: 0,
      suppressedByCooldown: 0,
      suppressedByDailyLimit: 0,
      notifyFailed: 0,
      errors: [...errors, errorText(quotesResult.error)],
    };
  }
  const quoteItems = new Map<string, BatchQuoteItem>(
    quotesResult.data.items.map((item) => [item.stockId, item as BatchQuoteItem]),
  );
  const freshQuotes = [...quoteItems.values()].filter(
    (item) => item.status === 'ok' && item.freshness === 'fresh',
  ).length;
  const poolId = `trading-plan-watch:${accountId}`;
  const stateResult = await ctx.tools.list_watch_rule_states.execute({ poolId });
  if (!stateResult.ok) {
    return {
      accountId,
      date,
      status: 'partial',
      checkedPlans: plans.length,
      freshQuotes,
      stalePlans,
      triggers: [],
      reviewedPlans: [],
      notified: 0,
      delivered: 0,
      suppressedByCooldown: 0,
      suppressedByDailyLimit: 0,
      notifyFailed: 0,
      errors: [...errors, errorText(stateResult.error)],
    };
  }
  const previousStates = new Map(
    stateResult.data.states.map((state) => [`${state.stockId}:${state.ruleId}`, state]),
  );
  const nextStates = [...stateResult.data.states];
  const candidates: Candidate[] = [];
  const cooldownKeys: { poolId: string; stockId: string; ruleId: string }[] = [];
  for (const plan of plans) {
    const quoteItem = quoteItems.get(plan.stockId);
    const quote =
      quoteItem?.status === 'ok' && quoteItem.freshness === 'fresh' ? quoteItem.quote : undefined;
    if (
      quote === undefined &&
      plan.entryConditions.length + plan.exit.triggerConditions.length > 0
    ) {
      errors.push(`${plan.stockId} 缺少合格实时行情，未生成盘中行动信号`);
    }
    for (const condition of [...plan.entryConditions, ...plan.exit.triggerConditions]) {
      const ruleId = `${tradingPlanVersionId(plan)}:${condition.id}`;
      const previousState = previousStates.get(`${plan.stockId}:${ruleId}`);
      const value = evaluate(plan, condition, quote);
      if (value === null) continue;
      const nextState = {
        alertPlanId: poolId,
        poolId,
        stockId: plan.stockId,
        ruleId,
        active: value,
        lastEvaluatedAt: now,
        ...(value && previousState?.firstTriggeredAt !== undefined
          ? { firstTriggeredAt: previousState.firstTriggeredAt }
          : value
            ? { firstTriggeredAt: now }
            : {}),
        ...(value
          ? {}
          : { lastRecoveredAt: previousState?.active ? now : previousState?.lastRecoveredAt }),
        ...(quote === undefined ? {} : { lastValue: quote.close }),
      };
      const existingIndex = nextStates.findIndex(
        (state) => state.stockId === plan.stockId && state.ruleId === ruleId,
      );
      if (existingIndex >= 0) nextStates[existingIndex] = nextState;
      else nextStates.push(nextState);
      if (value && !previousState?.active) {
        const trigger = triggerFor(plan, condition, quote, now, poolId);
        candidates.push({ trigger, plan, condition });
        cooldownKeys.push({ poolId, stockId: plan.stockId, ruleId });
      }
    }
  }
  const cooldownSince = new Date(now.getTime() - input.cooldownMinutes * 60_000);
  const statsResult = await ctx.tools.get_watch_trigger_delivery_stats.execute({
    since: dayStart(now),
    cooldownSince,
    poolIds: [poolId],
    cooldownKeys,
  });
  if (!statsResult.ok) errors.push(errorText(statsResult.error));
  let globalAttempted = statsResult.ok ? statsResult.data.globalAttempted : 0;
  let poolAttempted = statsResult.ok
    ? (statsResult.data.byPool.find((item) => item.poolId === poolId)?.attempted ?? 0)
    : 0;
  const cooldowns = new Set(
    statsResult.ok
      ? statsResult.data.cooldowns
          .filter((item) => item.trigger !== null)
          .map((item) => `${item.key.stockId}:${item.key.ruleId}`)
      : [],
  );
  let suppressedByCooldown = 0;
  let suppressedByDailyLimit = 0;
  const deliveryTriggers = candidates.map((candidate) => {
    const trigger = candidate.trigger;
    if (!input.notify) return trigger;
    const key = `${trigger.stockId}:${trigger.ruleId}`;
    const bypassOrdinaryLimits = trigger.priority !== 'normal';
    if (!bypassOrdinaryLimits && cooldowns.has(key)) {
      suppressedByCooldown += 1;
      return { ...trigger, deliveryStatus: 'suppressed-cooldown' as const };
    }
    if (
      !bypassOrdinaryLimits &&
      (globalAttempted >= input.dailyNotificationLimit ||
        poolAttempted >= input.dailyNotificationLimit)
    ) {
      suppressedByDailyLimit += 1;
      return { ...trigger, deliveryStatus: 'suppressed-daily-limit' as const };
    }
    globalAttempted += 1;
    poolAttempted += 1;
    return { ...trigger, deliveryStatus: 'pending' as const };
  });
  const owner = `trading-plan-watch:${accountId}:${globalThis.crypto.randomUUID()}`;
  const lease = await ctx.tools.watch_execution.execute({ action: 'acquire', owner });
  if (!lease.ok || !lease.data.acquired) {
    return {
      accountId,
      date,
      status: 'blocked',
      checkedPlans: plans.length,
      freshQuotes,
      stalePlans,
      triggers: [],
      reviewedPlans: [],
      notified: 0,
      delivered: 0,
      suppressedByCooldown,
      suppressedByDailyLimit,
      notifyFailed: 0,
      errors: [...errors, lease.ok ? '盘中监控租约被其他实例占用' : errorText(lease.error)],
    };
  }
  let finalTriggers = deliveryTriggers;
  let reviewedPlans: IntradayTradingPlanWatchOutputT['reviewedPlans'] = [];
  let replacedTriggerIds = new Set<string>();
  try {
    const committed = await ctx.tools.commit_watch_evaluation.execute({
      owner,
      triggers: deliveryTriggers,
      states: nextStates,
    });
    if (!committed.ok) {
      return {
        accountId,
        date,
        status: 'blocked',
        checkedPlans: plans.length,
        freshQuotes,
        stalePlans,
        triggers: [],
        reviewedPlans: [],
        notified: 0,
        delivered: 0,
        suppressedByCooldown,
        suppressedByDailyLimit,
        notifyFailed: 0,
        errors: [...errors, errorText(committed.error)],
      };
    }
    const reviewed = await reviewTriggeredHoldings(candidates, accountId, snapshot, ctx);
    reviewedPlans = reviewed.reviews;
    replacedTriggerIds = new Set(reviewed.replacedTriggerIds);
    if (replacedTriggerIds.size > 0) {
      await ctx.tools.set_watch_trigger_delivery_status.execute({
        triggerIds: [...replacedTriggerIds],
        status: 'not-requested',
      });
      finalTriggers = finalTriggers.map((trigger) =>
        replacedTriggerIds.has(trigger.id)
          ? { ...trigger, deliveryStatus: 'not-requested' as const }
          : trigger,
      );
    }
    let notified = 0;
    let delivered = 0;
    let notifyFailed = 0;
    if (input.notify) {
      for (const candidate of candidates) {
        const trigger = finalTriggers.find((item) => item.id === candidate.trigger.id);
        if (trigger === undefined || trigger.deliveryStatus !== 'pending') continue;
        const attempt = await ctx.tools.begin_watch_delivery.execute({ triggerIds: [trigger.id] });
        if (!attempt.ok) {
          errors.push(errorText(attempt.error));
          notifyFailed += 1;
          continue;
        }
        const notification = await ctx.tools.send_notification.execute({
          channel: 'feishu',
          feishu: {
            title: `计划条件触发 · ${candidate.plan.stockName ?? candidate.plan.stockId}`,
            content: notificationContent(candidate),
            level:
              trigger.priority === 'urgent'
                ? 'error'
                : trigger.priority === 'important'
                  ? 'warn'
                  : 'info',
          },
        });
        const status = !notification.ok
          ? 'failed'
          : notification.data.notification.result === 'suppressed'
            ? 'fallback-log'
            : notification.data.notification.result === 'failed'
              ? 'failed'
              : 'sent';
        const notificationId = notification.ok ? notification.data.notification.id : undefined;
        await ctx.tools.set_watch_trigger_delivery_status.execute({
          triggerIds: [trigger.id],
          status,
          ...(notificationId === undefined ? {} : { notificationId }),
        });
        finalTriggers = finalTriggers.map((item) =>
          item.id === trigger.id
            ? {
                ...item,
                deliveryStatus: status,
                ...(notificationId === undefined ? {} : { notificationId }),
              }
            : item,
        );
        notified += 1;
        if (status === 'sent') delivered += 1;
        if (status === 'failed') notifyFailed += 1;
      }
    }
    return {
      accountId,
      date,
      status: errors.length === 0 ? 'complete' : 'partial',
      checkedPlans: plans.length,
      freshQuotes,
      stalePlans,
      triggers: finalTriggers,
      reviewedPlans,
      notified,
      delivered,
      suppressedByCooldown,
      suppressedByDailyLimit,
      notifyFailed,
      errors,
    };
  } finally {
    await ctx.tools.watch_execution.execute({ action: 'release', owner });
  }
};

export const intradayTradingPlanWatchWorkflow = defineWorkflow<
  IntradayTradingPlanWatchInputT,
  IntradayTradingPlanWatchOutputT
>({
  name: 'intraday-trading-plan-watch',
  description: '按新鲜行情求值当前有效交易计划，记录边沿、复核持仓计划并投递合格信号',
  input: IntradayTradingPlanWatchInput,
  steps: [(previous, ctx) => run(previous as IntradayTradingPlanWatchInputT, ctx)],
});
