import {
  type AccountFacts,
  dateInShanghai,
  evaluateTradingPlanCondition,
  evaluateTradingPlanEntryConditions,
  isAshareTradingSession,
  isIntradayQuoteCurrent,
  money,
  notificationText,
  notificationTime,
  type TradingPlan,
  type TradingPlanCondition,
  type TradingPlanConditionFact,
  type TradingPlanMarketFact,
  tradingPlanMonitoring,
  tradingPlanVersionId,
  type WatchTrigger,
  WatchTriggerSchema,
} from '@luoome/core';
import { z } from 'zod';
import { defineWorkflow, type WorkflowContext } from './define-workflow.js';
import { type WatchWorkflowContext, watchExecutionStep } from './internal/watch-execution.js';

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

export const IntradayTradingPlanWatchOutput = z.object({
  accountId: z.string(),
  date: z.string().date(),
  status: z.enum(['complete', 'partial', 'blocked']),
  checkedPlans: z.number().int().nonnegative(),
  freshQuotes: z.number().int().nonnegative(),
  stalePlans: z.number().int().nonnegative(),
  triggers: z.array(WatchTriggerSchema),
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
  readonly retrieval?: 'live' | 'local-fallback';
  readonly quote?: {
    readonly close: number;
    readonly prevClose?: number;
    readonly observedAt: Date;
    readonly fetchedAt: Date;
    readonly timestampSource: 'upstream' | 'retrieval';
    readonly source: string;
  };
  readonly freshness?: 'fresh' | 'stale';
  readonly reason?: string;
};

type Candidate = {
  readonly trigger: WatchTrigger;
  readonly plan: TradingPlan;
  readonly condition: TradingPlanCondition;
  readonly isRetry?: boolean;
  readonly sourceTriggerId?: string;
};

const MAX_PUBLICATION_AGE_MS = 10 * 60_000;

const decisionQuote = (item: BatchQuoteItem | undefined, now: Date) => {
  if (item?.status !== 'ok' || item.freshness !== 'fresh' || item.retrieval !== 'live')
    return undefined;
  const quote = item.quote;
  return quote !== undefined && isIntradayQuoteCurrent(quote, now) ? quote : undefined;
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
    (plan.position.currentPct ?? 0) <= 0 &&
    (condition.phase === 'risk' || condition.phase === 'exit')
  )
    return 'watch';
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

/** 计划的 metric 是开放字符串；无法归类时不能把非价格度量冒充成价格事实（PRD §6.2）。 */
const conditionMetric = (value: string): TradingPlanConditionFact['metric'] | undefined =>
  value === 'price' ||
  value === 'changePct' ||
  value === 'marketIndexChangePct' ||
  value === 'marketBreadthPct'
    ? value
    : undefined;

const factForMarketFact = (fact: TradingPlanMarketFact): TradingPlanConditionFact | undefined => {
  const metric = conditionMetric(fact.metric);
  return metric === undefined ? undefined : { metric, value: fact.value };
};

const conditionFacts = (
  plan: TradingPlan,
  quote: BatchQuoteItem['quote'],
  now: Date,
): ReadonlyMap<string, TradingPlanConditionFact> => {
  const facts = new Map<string, TradingPlanConditionFact>();
  for (const fact of plan.marketFacts) {
    const age = now.getTime() - fact.observedAt.getTime();
    const conditionFact =
      fact.status === 'available' && age >= 0 && age <= MAX_PUBLICATION_AGE_MS
        ? factForMarketFact(fact)
        : undefined;
    if (conditionFact !== undefined) facts.set(fact.id, conditionFact);
  }
  if (quote === undefined) return facts;
  for (const condition of [...plan.entryConditions, ...plan.exit.triggerConditions]) {
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
  }
  return facts;
};

const evaluate = (
  plan: TradingPlan,
  condition: TradingPlanCondition,
  quote: BatchQuoteItem['quote'],
  now: Date,
): boolean | null => {
  const facts = conditionFacts(plan, quote, now);
  return plan.entryConditions.some((item) => item.id === condition.id)
    ? evaluateTradingPlanEntryConditions(plan, facts)
    : evaluateTradingPlanCondition(condition, facts);
};

const isEntry = (plan: TradingPlan, condition: TradingPlanCondition): boolean =>
  plan.entryConditions.some((item) => item.id === condition.id);

const conditionDescription = (plan: TradingPlan, condition: TradingPlanCondition): string =>
  isEntry(plan, condition)
    ? `全部入场条件满足：${plan.entryConditions.map((item) => item.description).join('；')}`
    : condition.description;

const actionLabels: Record<TradingPlan['action'], string> = {
  observe: '观察',
  enter: '建仓',
  add: '加仓',
  hold: '持有',
  reduce: '减仓',
  exit: '退出',
  avoid: '回避',
};

const nextStep = (plan: TradingPlan, condition: TradingPlanCondition): string => {
  if (!isEntry(plan, condition)) {
    if ((plan.position.currentPct ?? 0) <= 0)
      return '尚未持仓，原入场前提已变化；暂停入场并重新评估计划';
    return plan.exit.canSellNow
      ? '原计划风险或退出条件已命中，请优先复核持仓并自主决定是否调整'
      : `请优先复核持仓；${plan.exit.unavailableReason ?? '当前不可卖出'}，不要将提醒视为可立即成交`;
  }
  return plan.action === 'observe'
    ? '观察条件已满足，请重新评估后决定是否生成建仓计划'
    : '全部入场条件已满足，请核对当前仓位和价格后自主决定；成交后登记账户账本';
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
      `${actionLabels[plan.action]}计划：${conditionDescription(plan, condition)}；${quoteText}；计划版本 ${versionId}`.slice(
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
      conditionDescription: conditionDescription(plan, condition),
      conditionIds: isEntry(plan, condition)
        ? plan.entryConditions.map((item) => item.id)
        : [condition.id],
      nextStep: nextStep(plan, condition),
      strategyIds: plan.source.strategyIds,
      adviceIds: plan.source.adviceIds,
      quoteClose: quote?.close,
      quoteObservedAt: quote?.observedAt,
      firstEventAt: quote?.observedAt.toISOString(),
      firstAcquiredAt: quote?.fetchedAt.toISOString(),
      quoteSource: quote?.source,
      accountFactsDigest: plan.accountFactsDigest,
      accountFactsAsOf: plan.accountFactsAsOf.toISOString(),
      validUntil: plan.validUntil,
    },
    notified: false,
    createdAt: now,
  };
};

const notificationContent = (candidate: Candidate): string => {
  const plan = candidate.plan;
  const quote = candidate.trigger.quote;
  return [
    `**${notificationText(conditionDescription(plan, candidate.condition), 130)}**`,
    `现价 ${quote?.close.toFixed(2) ?? '待核对'} · 原计划${actionLabels[plan.action]}`,
    `**下一步**\n${nextStep(plan, candidate.condition)}`,
    [
      ...(isEntry(plan, candidate.condition) &&
      plan.entryPriceLow !== undefined &&
      plan.entryPriceHigh !== undefined
        ? [`入场 ${plan.entryPriceLow.toFixed(2)}–${plan.entryPriceHigh.toFixed(2)}`]
        : []),
      ...(plan.exit.stopLoss === undefined ? [] : [`止损 ${plan.exit.stopLoss.toFixed(2)}`]),
      ...(plan.exit.takeProfit === undefined ? [] : [`目标价 ${plan.exit.takeProfit.toFixed(2)}`]),
      ...(plan.position.targetPct === null
        ? []
        : [`目标仓位 ${plan.position.targetPct.toFixed(1)}%`]),
    ].join(' · '),
    `反证：${notificationText(plan.explanation.counterEvidence.join('；'), 90) || '未记录，请核对原计划'}`,
    `风险：${notificationText(plan.explanation.risks.join('；'), 90) || '未记录，请核对原计划'}`,
    ...(plan.explanation.unknowns.length === 0
      ? []
      : [`待确认：${notificationText(plan.explanation.unknowns.join('；'), 90)}`]),
    `行情 ${notificationTime(quote?.ts ?? candidate.trigger.createdAt)} · 有效至 ${notificationTime(plan.validUntil)}（北京时间）`,
    '完整计划与触发证据见 luoome「预警」。不构成投资建议，不代表成交或自动下单。',
  ]
    .filter(Boolean)
    .join('\n\n');
};

type PublicationValidation =
  | {
      readonly ok: true;
      readonly candidates: readonly Candidate[];
      readonly rejected: readonly WatchTrigger[];
      /** 单条候选被丢弃的原因；其它候选仍可发布。 */
      readonly dropped: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly status: 'invalidated' | 'unverifiable';
    };

/**
 * 10 分钟发布时限的计时起点：优先取首次上游事件时间；旧记录读取原行情时间。
 * 缺失、不可解析或晚于检测时间时没有可信计时起点，不能把检测时间冒充事件时间。
 */
const publicationAgeStart = (trigger: WatchTrigger): Date | null => {
  const observedAt = trigger.evalSnapshot.firstEventAt ?? trigger.evalSnapshot.quoteObservedAt;
  const parsed =
    observedAt instanceof Date
      ? observedAt
      : typeof observedAt === 'string'
        ? new Date(observedAt)
        : undefined;
  if (
    parsed === undefined ||
    Number.isNaN(parsed.getTime()) ||
    parsed.getTime() > trigger.createdAt.getTime()
  )
    return null;
  return parsed;
};

const latestPlanById = (plans: readonly TradingPlan[], planId: string): TradingPlan | undefined =>
  plans
    .filter((plan) => plan.id === planId)
    .sort((a, b) => b.version - a.version || b.createdAt.getTime() - a.createdAt.getTime())
    .at(0);

/** 发布前重新锁定事实，防止求值或通知期间使用过期快照/计划/行情。 */
const validatePublication = async (
  candidates: readonly Candidate[],
  accountId: string,
  initialFacts: AccountFacts,
  ctx: WorkflowContext,
): Promise<PublicationValidation> => {
  if (candidates.length === 0) return { ok: true, candidates: [], rejected: [], dropped: [] };
  const currentFactsResult = await ctx.tools.get_account_facts.execute({ accountId });
  if (!currentFactsResult.ok) {
    return {
      ok: false,
      reason: `发布前无法读取账户事实：${errorText(currentFactsResult.error)}`,
      status: 'unverifiable',
    };
  }
  const currentFacts = currentFactsResult.data.facts;
  if (
    currentFacts.digest !== initialFacts.digest ||
    currentFacts.status !== 'complete' ||
    currentFacts.totalAssets === null
  ) {
    return {
      ok: false,
      reason: '发布前账户事实（持仓或现金）已变化或不可用，放弃本轮信号',
      status: 'invalidated',
    };
  }
  // 与监控侧一致只取「当前生效版本」：未发布的草案不能顶掉仍在监控的生效版本，
  // 否则该标的的风险/退出提醒会被草案无限期压掉（见 activeOnly 的仓储语义）。
  const plansResult = await ctx.tools.list_trading_plans.execute({
    accountId,
    activeOnly: true,
    limit: 500,
  });
  if (!plansResult.ok) {
    return {
      ok: false,
      reason: `发布前无法读取交易计划：${errorText(plansResult.error)}`,
      status: 'unverifiable',
    };
  }
  const quoteResult = await ctx.tools.batch_quote.execute({
    stockIds: [...new Set(candidates.map((candidate) => candidate.plan.stockId))],
    context: 'intraday-rule',
    watchIntervalSeconds: 60,
  });
  if (!quoteResult.ok) {
    return {
      ok: false,
      reason: `发布前无法刷新行情：${errorText(quoteResult.error)}`,
      status: 'unverifiable',
    };
  }
  const quotes = new Map<string, BatchQuoteItem>(
    quoteResult.data.items.map((item) => [item.stockId, item as BatchQuoteItem]),
  );
  const now = ctx.clock();
  const validated: Candidate[] = [];
  const rejected: WatchTrigger[] = [];
  const dropped: string[] = [];
  const reject = (
    candidate: Candidate,
    status: 'expired' | 'unverifiable' | 'invalidated',
    reason: string,
  ): void => {
    dropped.push(reason);
    rejected.push({
      ...candidate.trigger,
      deliveryStatus: status,
      evalSnapshot: {
        ...candidate.trigger.evalSnapshot,
        publicationCheckedAt: now.toISOString(),
        publicationReason: reason,
      },
    });
  };
  for (const candidate of candidates) {
    // 单条候选过期/失效只丢弃该条：否则一条超过时限的重试会阻断同轮所有其它信号。
    const eventAt = publicationAgeStart(candidate.trigger);
    if (eventAt === null) {
      reject(
        candidate,
        'unverifiable',
        `${candidate.plan.stockId} 盘中信号缺可信上游事件时间，无法核验 10 分钟发布时限`,
      );
      continue;
    }
    const ageMs = now.getTime() - eventAt.getTime();
    if (ageMs < 0 || ageMs > MAX_PUBLICATION_AGE_MS) {
      reject(
        candidate,
        ageMs < 0 ? 'unverifiable' : 'expired',
        `${candidate.plan.stockId} 盘中信号超过 10 分钟发布时限，放弃本轮信号`,
      );
      continue;
    }
    const currentPlan = latestPlanById(plansResult.data.plans, candidate.plan.id);
    if (
      currentPlan === undefined ||
      currentPlan.version !== candidate.plan.version ||
      currentPlan.accountFactsDigest !== currentFacts.digest ||
      currentPlan.validFrom.getTime() > now.getTime() ||
      currentPlan.validUntil.getTime() <= now.getTime() ||
      currentPlan.status !== 'active'
    ) {
      reject(candidate, 'invalidated', `${candidate.plan.stockId} 发布前交易计划版本已变化或失效`);
      continue;
    }
    const quote = decisionQuote(quotes.get(candidate.plan.stockId), now);
    if (quote === undefined) {
      reject(
        candidate,
        'invalidated',
        `${candidate.plan.stockId} 发布前实时行情不具备可核验决策资格`,
      );
      continue;
    }
    if (evaluate(candidate.plan, candidate.condition, quote, now) !== true) {
      reject(candidate, 'invalidated', `${candidate.plan.stockId} 发布前条件已恢复，放弃本轮信号`);
      continue;
    }
    if (candidate.isRetry === true) {
      validated.push({
        ...candidate,
        trigger: {
          ...candidate.trigger,
          evalSnapshot: {
            ...candidate.trigger.evalSnapshot,
            publicationCheckedAt: now.toISOString(),
          },
        },
      });
    } else {
      const refreshed = triggerFor(
        candidate.plan,
        candidate.condition,
        quote,
        now,
        candidate.trigger.poolId,
      );
      validated.push({
        ...candidate,
        sourceTriggerId: candidate.sourceTriggerId ?? candidate.trigger.id,
        trigger: {
          ...refreshed,
          createdAt: candidate.trigger.createdAt,
          evalSnapshot: {
            ...refreshed.evalSnapshot,
            firstEventAt: eventAt.toISOString(),
            firstAcquiredAt: candidate.trigger.evalSnapshot.firstAcquiredAt,
            publicationCheckedAt: now.toISOString(),
          },
        },
      });
    }
  }
  return { ok: true, candidates: validated, rejected, dropped };
};

const run = async (
  input: IntradayTradingPlanWatchInputT,
  ctx: WatchWorkflowContext,
): Promise<IntradayTradingPlanWatchOutputT> => {
  const accountId = input.accountId ?? ctx.user.defaultAccountId;
  const now = ctx.clock();
  const date = dateInShanghai(now);
  const errors: string[] = [];
  if (!isAshareTradingSession(now)) {
    return {
      accountId,
      date,
      status: 'blocked',
      checkedPlans: 0,
      freshQuotes: 0,
      stalePlans: 0,
      triggers: [],
      notified: 0,
      delivered: 0,
      suppressedByCooldown: 0,
      suppressedByDailyLimit: 0,
      notifyFailed: 0,
      errors: ['非交易时段，盘中计划监控未执行'],
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
      notified: 0,
      delivered: 0,
      suppressedByCooldown: 0,
      suppressedByDailyLimit: 0,
      notifyFailed: 0,
      errors: [errorText(plansResult.error)],
    };
  }
  const livePlans = plansResult.data.plans.filter(
    (plan) =>
      plan.validFrom.getTime() <= now.getTime() && plan.validUntil.getTime() > now.getTime(),
  );
  const expiredPlans = plansResult.data.plans.length - livePlans.length;
  if (expiredPlans > 0) errors.push(`${expiredPlans} 个计划因有效期不匹配未监控`);
  if (livePlans.length === 0) {
    return {
      accountId,
      date,
      status: expiredPlans > 0 ? 'partial' : 'complete',
      checkedPlans: 0,
      freshQuotes: 0,
      stalePlans: expiredPlans,
      triggers: [],
      notified: 0,
      delivered: 0,
      suppressedByCooldown: 0,
      suppressedByDailyLimit: 0,
      notifyFailed: 0,
      errors,
    };
  }
  const holdingsResult = await ctx.tools.list_holdings.execute({ accountId, status: 'active' });
  if (!holdingsResult.ok) {
    return {
      accountId,
      date,
      status: 'blocked',
      checkedPlans: 0,
      freshQuotes: 0,
      stalePlans: expiredPlans,
      triggers: [],
      notified: 0,
      delivered: 0,
      suppressedByCooldown: 0,
      suppressedByDailyLimit: 0,
      notifyFailed: 0,
      errors: [...errors, errorText(holdingsResult.error)],
    };
  }
  // 先刷新行情（batch_quote 会落库），再派生账户事实：盘中不能用昨日收盘当当前市值。
  const stockIds = [
    ...new Set([
      ...livePlans.map((plan) => plan.stockId),
      ...holdingsResult.data.holdings
        .filter((item) => item.holding.quantity > 0)
        .map((item) => item.holding.stockId),
    ]),
  ];
  const quoteItems = new Map<string, BatchQuoteItem>();
  for (let offset = 0; offset < stockIds.length; offset += 100) {
    const quotesResult = await ctx.tools.batch_quote.execute({
      stockIds: stockIds.slice(offset, offset + 100),
      context: 'intraday-rule',
      watchIntervalSeconds: input.watchIntervalSeconds,
    });
    if (!quotesResult.ok) {
      return {
        accountId,
        date,
        status: 'partial',
        checkedPlans: livePlans.length,
        freshQuotes: 0,
        stalePlans: expiredPlans,
        triggers: [],
        notified: 0,
        delivered: 0,
        suppressedByCooldown: 0,
        suppressedByDailyLimit: 0,
        notifyFailed: 0,
        errors: [...errors, errorText(quotesResult.error)],
      };
    }
    for (const item of quotesResult.data.items)
      quoteItems.set(item.stockId, item as BatchQuoteItem);
  }
  const freshQuotes = [...quoteItems.values()].filter((item) =>
    decisionQuote(item, ctx.clock()),
  ).length;
  const factsResult = await ctx.tools.get_account_facts.execute({ accountId });
  if (!factsResult.ok) {
    return {
      accountId,
      date,
      status: 'blocked',
      checkedPlans: livePlans.length,
      freshQuotes,
      stalePlans: expiredPlans,
      triggers: [],
      notified: 0,
      delivered: 0,
      suppressedByCooldown: 0,
      suppressedByDailyLimit: 0,
      notifyFailed: 0,
      errors: [...errors, errorText(factsResult.error)],
    };
  }
  const accountFacts = factsResult.data.facts;
  if (accountFacts.status !== 'complete' || accountFacts.totalAssets === null) {
    return {
      accountId,
      date,
      status: 'blocked',
      checkedPlans: livePlans.length,
      freshQuotes,
      stalePlans: expiredPlans,
      triggers: [],
      notified: 0,
      delivered: 0,
      suppressedByCooldown: 0,
      suppressedByDailyLimit: 0,
      notifyFailed: 0,
      errors: [
        ...errors,
        `账户事实不可用，暂停精确盘中计划监控：${accountFacts.reasons.join('；')}`,
      ],
    };
  }
  // 只监控基于当前账户事实（持仓 + 现金）的计划；账本变了，旧计划的仓位前提已失效。
  const plans = livePlans.filter((plan) => {
    const monitoring = tradingPlanMonitoring(plan, accountFacts, now);
    if (monitoring.status === 'ready') return true;
    errors.push(`${plan.stockId} ${monitoring.reason}；${monitoring.nextStep}`);
    return false;
  });
  const stalePlans = expiredPlans + (livePlans.length - plans.length);
  if (plans.length === 0) {
    // 有计划但与当前账户事实不匹配：账本变了，旧计划的仓位前提已失效，按 partial 明确暴露。
    return {
      accountId,
      date,
      status: 'partial',
      checkedPlans: 0,
      freshQuotes,
      stalePlans,
      triggers: [],
      notified: 0,
      delivered: 0,
      suppressedByCooldown: 0,
      suppressedByDailyLimit: 0,
      notifyFailed: 0,
      errors,
    };
  }
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
      notified: 0,
      delivered: 0,
      suppressedByCooldown: 0,
      suppressedByDailyLimit: 0,
      notifyFailed: 0,
      errors: [...errors, errorText(stateResult.error)],
    };
  }
  const sessionStart = new Date(
    `${date}T${now.getTime() >= new Date(`${date}T13:00:00+08:00`).getTime() ? '13:00' : '09:30'}:00+08:00`,
  );
  const currentRuleIds = new Set(
    plans.flatMap((plan) =>
      [...plan.exit.triggerConditions, ...plan.entryConditions.slice(0, 1)].map(
        (condition) => `${tradingPlanVersionId(plan)}:${condition.id}`,
      ),
    ),
  );
  const rearmed = new Map<string, (typeof stateResult.data.states)[number]>();
  const interruptedPendingIds: string[] = [];
  for (const state of stateResult.data.states) {
    if (
      !state.active ||
      state.lastEvaluatedAt.getTime() >= sessionStart.getTime() ||
      !currentRuleIds.has(state.ruleId)
    )
      continue;
    const latest = await ctx.tools.list_watch_triggers.execute({
      poolId,
      stockId: state.stockId,
      ruleId: state.ruleId,
      until: new Date(sessionStart.getTime() - 1),
      limit: 1,
    });
    if (!latest.ok) {
      return {
        accountId,
        date,
        status: 'blocked',
        checkedPlans: plans.length,
        freshQuotes,
        stalePlans,
        triggers: [],
        notified: 0,
        delivered: 0,
        suppressedByCooldown: 0,
        suppressedByDailyLimit: 0,
        notifyFailed: 0,
        errors: [...errors, errorText(latest.error)],
      };
    }
    const trigger = latest.data.triggers[0];
    if (
      trigger === undefined ||
      !['pending', 'failed', 'invalidated'].includes(trigger.deliveryStatus)
    )
      continue;
    rearmed.set(`${state.stockId}:${state.ruleId}`, {
      ...state,
      active: false,
      firstTriggeredAt: undefined,
    });
    if (trigger.deliveryStatus === 'pending') interruptedPendingIds.push(trigger.id);
  }
  if (rearmed.size > 0) {
    const reset = await ctx.tools.commit_watch_evaluation.execute({
      owner: ctx.watchExecutionOwner,
      triggers: [],
      states: [...rearmed.values()],
      ...(interruptedPendingIds.length === 0
        ? {}
        : {
            invalidatePending: {
              triggerIds: interruptedPendingIds,
              reason: '上个交易时段投递中断，当前时段重新求值',
            },
          }),
    });
    if (!reset.ok) {
      return {
        accountId,
        date,
        status: 'blocked',
        checkedPlans: plans.length,
        freshQuotes,
        stalePlans,
        triggers: [],
        notified: 0,
        delivered: 0,
        suppressedByCooldown: 0,
        suppressedByDailyLimit: 0,
        notifyFailed: 0,
        errors: [...errors, errorText(reset.error)],
      };
    }
  }
  const previousStates = new Map(
    stateResult.data.states.map((state) => [
      `${state.stockId}:${state.ruleId}`,
      rearmed.get(`${state.stockId}:${state.ruleId}`) ?? state,
    ]),
  );
  const nextStates = [...previousStates.values()];
  const candidates: Candidate[] = [];
  const cooldownKeys: { poolId: string; stockId: string; ruleId: string }[] = [];
  for (const plan of plans) {
    const quote = decisionQuote(quoteItems.get(plan.stockId), ctx.clock());
    if (
      quote === undefined &&
      plan.entryConditions.length + plan.exit.triggerConditions.length > 0
    ) {
      errors.push(
        `${plan.stockId} 缺少具有可核验上游时间且不超过 120 秒的实时行情，未生成盘中行动信号`,
      );
    }
    for (const condition of [...plan.exit.triggerConditions, ...plan.entryConditions.slice(0, 1)]) {
      const ruleId = `${tradingPlanVersionId(plan)}:${condition.id}`;
      const previousState = previousStates.get(`${plan.stockId}:${ruleId}`);
      const value = evaluate(plan, condition, quote, now);
      if (value === null) {
        errors.push(`${plan.stockId} 条件无法确认：${condition.description}`);
        continue;
      }
      const nextState = {
        alertPlanId: poolId,
        poolId,
        stockId: plan.stockId,
        ruleId,
        active: value === true,
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
  const retriesResult = await ctx.tools.list_watch_delivery_retries.execute({
    poolId,
    since: sessionStart,
  });
  if (!retriesResult.ok) {
    errors.push(errorText(retriesResult.error));
  } else {
    const currentCandidateIds = new Set(candidates.map((candidate) => candidate.trigger.id));
    for (const trigger of input.notify ? retriesResult.data.triggers : []) {
      if (currentCandidateIds.has(trigger.id)) continue;
      const versionId = trigger.evalSnapshot.planVersionId;
      const conditionId = trigger.evalSnapshot.conditionId;
      if (typeof versionId !== 'string' || typeof conditionId !== 'string') continue;
      const plan = plans.find((item) => tradingPlanVersionId(item) === versionId);
      const condition =
        plan === undefined
          ? undefined
          : [...plan.entryConditions, ...plan.exit.triggerConditions].find(
              (item) => item.id === conditionId,
            );
      if (plan === undefined || condition === undefined || trigger.stockId !== plan.stockId) {
        continue;
      }
      if (isEntry(plan, condition) && plan.entryConditions[0]?.id !== condition.id) continue;
      candidates.push({ trigger, plan, condition, isRetry: true });
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
  const priorityOrder = { urgent: 0, important: 1, normal: 2 };
  candidates.sort((a, b) => priorityOrder[a.trigger.priority] - priorityOrder[b.trigger.priority]);
  const deliveryTriggers = candidates.map((candidate) => {
    const trigger = candidate.trigger;
    if (!input.notify) return trigger;
    const key = `${trigger.stockId}:${trigger.ruleId}`;
    const bypassOrdinaryLimits = candidate.isRetry === true || trigger.priority !== 'normal';
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
  const owner = ctx.watchExecutionOwner;
  let finalTriggers = deliveryTriggers;
  const publicationFailure = async (
    reason: string,
    status: 'invalidated' | 'unverifiable',
  ): Promise<IntradayTradingPlanWatchOutputT> => {
    const checkedAt = ctx.clock().toISOString();
    const auditTriggers: WatchTrigger[] = candidates.map((candidate) => ({
      ...candidate.trigger,
      deliveryStatus: status,
      evalSnapshot: {
        ...candidate.trigger.evalSnapshot,
        publicationCheckedAt: checkedAt,
        publicationReason: reason,
      },
    }));
    const committed =
      input.notify && auditTriggers.length > 0
        ? await ctx.tools.commit_watch_evaluation.execute({
            owner,
            triggers: [],
            auditTriggers,
            states: [],
          })
        : null;
    return {
      accountId,
      date,
      status: committed !== null && !committed.ok ? 'blocked' : 'partial',
      checkedPlans: plans.length,
      freshQuotes,
      stalePlans,
      triggers: committed !== null && !committed.ok ? [] : auditTriggers,
      notified: 0,
      delivered: 0,
      suppressedByCooldown,
      suppressedByDailyLimit,
      notifyFailed: 0,
      errors: [
        ...errors,
        reason,
        ...(committed !== null && !committed.ok ? [errorText(committed.error)] : []),
      ],
    };
  };
  if (!isAshareTradingSession(ctx.clock())) {
    return publicationFailure('非交易时段，盘中行动信号已失效', 'invalidated');
  }
  const beforePublicationFacts = await ctx.tools.get_account_facts.execute({ accountId });
  if (
    !beforePublicationFacts.ok ||
    beforePublicationFacts.data.facts.digest !== accountFacts.digest
  ) {
    return publicationFailure(
      beforePublicationFacts.ok
        ? '账户事实（持仓或现金）在盘中发布开始前已变化，放弃本轮信号'
        : errorText(beforePublicationFacts.error),
      beforePublicationFacts.ok ? 'invalidated' : 'unverifiable',
    );
  }
  const publication = await validatePublication(candidates, accountId, accountFacts, ctx);
  if (!publication.ok) {
    return publicationFailure(publication.reason, publication.status);
  }
  if (!isAshareTradingSession(ctx.clock())) {
    return publicationFailure('非交易时段，盘中行动信号已失效', 'invalidated');
  }
  errors.push(...publication.dropped);
  const deliveryBySourceId = new Map(deliveryTriggers.map((trigger) => [trigger.id, trigger]));
  const acceptedTriggers = publication.candidates.map((candidate) => {
    const source = deliveryBySourceId.get(candidate.sourceTriggerId ?? candidate.trigger.id);
    return {
      ...candidate.trigger,
      ...(source === undefined ? {} : { deliveryStatus: source.deliveryStatus }),
    };
  });
  finalTriggers = [...acceptedTriggers, ...publication.rejected];
  const committed = input.notify
    ? await ctx.tools.commit_watch_evaluation.execute({
        owner,
        triggers: acceptedTriggers,
        auditTriggers: [...publication.rejected],
        states: nextStates.filter(
          (state) =>
            !candidates.some(
              (candidate) =>
                candidate.isRetry !== true &&
                candidate.trigger.stockId === state.stockId &&
                candidate.trigger.ruleId === state.ruleId &&
                !acceptedTriggers.some(
                  (trigger) => trigger.stockId === state.stockId && trigger.ruleId === state.ruleId,
                ),
            ),
        ),
      })
    : { ok: true as const };
  if (!committed.ok) {
    return {
      accountId,
      date,
      status: 'blocked',
      checkedPlans: plans.length,
      freshQuotes,
      stalePlans,
      triggers: [],
      notified: 0,
      delivered: 0,
      suppressedByCooldown,
      suppressedByDailyLimit,
      notifyFailed: 0,
      errors: [...errors, errorText(committed.error)],
    };
  }
  let notified = 0;
  let delivered = 0;
  let notifyFailed = 0;
  if (input.notify) {
    const invalidatePending = async (): Promise<void> => {
      const pending = finalTriggers.filter((trigger) => trigger.deliveryStatus === 'pending');
      if (pending.length === 0) return;
      const pendingIds = pending.map((trigger) => trigger.id);
      const pendingKeys = new Set(pending.map((trigger) => `${trigger.stockId}:${trigger.ruleId}`));
      const reason = '非交易时段，未发送剩余盘中行动信号';
      const update = await ctx.tools.commit_watch_evaluation.execute({
        owner,
        triggers: [],
        states: nextStates
          .filter((state) => pendingKeys.has(`${state.stockId}:${state.ruleId}`))
          .map((state) => ({ ...state, active: false, firstTriggeredAt: undefined })),
        invalidatePending: { triggerIds: pendingIds, reason },
      });
      errors.push(reason);
      if (!update.ok) {
        errors.push(errorText(update.error));
        return;
      }
      finalTriggers = finalTriggers.map((trigger) =>
        pendingIds.includes(trigger.id)
          ? {
              ...trigger,
              deliveryStatus: 'invalidated',
              ...(update.data.invalidatedAt === undefined
                ? {}
                : {
                    deliveryCompletedAt: update.data.invalidatedAt,
                    evalSnapshot: {
                      ...trigger.evalSnapshot,
                      publicationCheckedAt: update.data.invalidatedAt.toISOString(),
                      publicationReason: reason,
                    },
                  }),
            }
          : trigger,
      );
    };
    for (const candidate of publication.candidates) {
      const trigger = finalTriggers.find((item) => item.id === candidate.trigger.id);
      if (trigger === undefined || trigger.deliveryStatus !== 'pending') continue;
      if (!isAshareTradingSession(ctx.clock())) {
        await invalidatePending();
        break;
      }
      const attempt = await ctx.tools.begin_watch_delivery.execute({ triggerIds: [trigger.id] });
      if (!attempt.ok) {
        errors.push(errorText(attempt.error));
        notifyFailed += 1;
        continue;
      }
      if (!isAshareTradingSession(ctx.clock())) {
        await invalidatePending();
        break;
      }
      const notification = await ctx.tools.send_notification.execute({
        channel: 'feishu',
        feishu: {
          title: `${candidate.condition.phase === 'risk' ? '计划风险提醒' : isEntry(candidate.plan, candidate.condition) ? '入场条件就绪' : '计划退出提醒'} · ${candidate.plan.stockName ?? candidate.plan.stockId}`,
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
      const deliveryUpdate = await ctx.tools.set_watch_trigger_delivery_status.execute({
        triggerIds: [trigger.id],
        status,
        ...(notificationId === undefined ? {} : { notificationId }),
      });
      if (!deliveryUpdate.ok) errors.push(errorText(deliveryUpdate.error));
      finalTriggers = finalTriggers.map((item) =>
        item.id === trigger.id
          ? {
              ...item,
              deliveryStatus: status,
              ...(notificationId === undefined ? {} : { notificationId }),
              ...(deliveryUpdate.ok
                ? { deliveryCompletedAt: deliveryUpdate.data.completedAt }
                : {}),
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
    notified,
    delivered,
    suppressedByCooldown,
    suppressedByDailyLimit,
    notifyFailed,
    errors,
  };
};

export const intradayTradingPlanWatchWorkflow = defineWorkflow<
  IntradayTradingPlanWatchInputT,
  IntradayTradingPlanWatchOutputT
>({
  name: 'intraday-trading-plan-watch',
  description: '按新鲜行情求值当前有效交易计划，合并入场条件、优先提示风险并投递可追溯信号',
  input: IntradayTradingPlanWatchInput,
  steps: [
    watchExecutionStep([(previous, ctx) => run(previous as IntradayTradingPlanWatchInputT, ctx)]),
  ],
});
