import { z } from 'zod';
import {
  type AlertPlan,
  AlertPlanSchema,
  assertAlertPlanInvariants,
} from '../entity/alert-plan.js';
import { isIntradayQuoteCurrent, type Quote, QuoteSchema } from '../entity/quote.js';
import { StockSchema } from '../entity/stock.js';
import {
  PriceChangeRuleSchema,
  PriceLevelRuleSchema,
  type WatchRuleState,
  WatchRuleStateSchema,
  type WatchTrigger,
  WatchTriggerSchema,
} from '../entity/watch-trigger.js';
import {
  WatchlistMemberSchema,
  WatchlistMemberSourceSchema,
  WatchlistSchema,
} from '../entity/watchlist.js';
import { InvariantError } from '../error/index.js';
import { dateInShanghai } from '../trading-calendar.js';
import { HashSchema } from './hash.js';
import { PersonalOperationReceiptSchema } from './receipt.js';

const PersonalRuleId = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,48}$/)
  .refine((id) => id !== 'composite', { message: 'composite 是组合条件的保留身份' });
export const PersonalPriceRuleSchema = z.discriminatedUnion('kind', [
  PriceLevelRuleSchema.extend({ id: PersonalRuleId }),
  PriceChangeRuleSchema.extend({ id: PersonalRuleId }),
]);
const PersonalAlertPlanFieldsSchema = AlertPlanSchema.extend({
  rules: z.array(PersonalPriceRuleSchema).min(1).max(10),
  triggerMode: z.enum(['on-enter', 'daily-first']),
  cooldownMinutes: z.number().int().min(0).max(1440),
  dailyNotificationLimit: z.number().int().min(1).max(100),
});
const uniquePersonalRuleIds = (
  plan: { rules: readonly { id: string }[] },
  ctx: z.RefinementCtx,
) => {
  if (new Set(plan.rules.map((rule) => rule.id)).size !== plan.rules.length)
    ctx.addIssue({ code: 'custom', path: ['rules'], message: '条件身份必须唯一' });
};
export const PersonalAlertPlanSchema =
  PersonalAlertPlanFieldsSchema.superRefine(uniquePersonalRuleIds);
export type PersonalAlertPlan = z.infer<typeof PersonalAlertPlanSchema>;
export const PersonalAlertPlanConfigSchema = PersonalAlertPlanFieldsSchema.omit({
  createdAt: true,
  updatedAt: true,
}).superRefine(uniquePersonalRuleIds);
export const personalAlertConditionInput = (plan: AlertPlan): string =>
  JSON.stringify({
    watchlistId: plan.watchlistId,
    rules: plan.rules,
    logic: plan.logic,
    triggerMode: plan.triggerMode,
    cooldownMinutes: plan.cooldownMinutes,
    dailyNotificationLimit: plan.dailyNotificationLimit,
    notifyOnRecovery: plan.notifyOnRecovery,
    enabled: plan.enabled,
  });
export const assertPersonalAlertPlanLimits = (input: {
  plan: AlertPlan;
  plans: readonly AlertPlan[];
  maxEnabledRules: number;
  maxDailyNotifications: number;
  minCooldownMinutes: number;
}): void => {
  const plan = PersonalAlertPlanSchema.parse(input.plan);
  assertAlertPlanInvariants(plan);
  if (
    plan.dailyNotificationLimit > input.maxDailyNotifications ||
    plan.cooldownMinutes < input.minCooldownMinutes
  )
    throw new InvariantError('提醒冷却或每日上限超过服务端允许范围');
  const enabledRules =
    input.plans
      .filter((other) => other.id !== plan.id && other.enabled)
      .reduce((sum, other) => sum + other.rules.length, 0) + (plan.enabled ? plan.rules.length : 0);
  if (plan.enabled && enabledRules > input.maxEnabledRules)
    throw new InvariantError('启用条件数量超过当前套餐上限');
};
export const PersonalAlertPlanMutationSchema = z.object({
  plan: PersonalAlertPlanSchema,
  planRevision: HashSchema,
  receipt: PersonalOperationReceiptSchema,
});
export type PersonalAlertPlanMutation = z.infer<typeof PersonalAlertPlanMutationSchema>;
export const PersonalAlertPlanRemovalSchema = z.object({
  alertPlanId: z.string(),
  receipt: PersonalOperationReceiptSchema,
});
export type PersonalAlertPlanRemoval = z.infer<typeof PersonalAlertPlanRemovalSchema>;
export const PersonalAlertRequestSchema = z.object({
  watchlistId: z.string().min(1),
  period: z.string().date(),
  notificationPolicy: z.literal('never'),
  watchlistRevision: HashSchema,
  ruleFingerprint: HashSchema,
  watchlist: WatchlistSchema,
  members: z.array(WatchlistMemberSchema).min(1).max(100),
  sources: z.array(WatchlistMemberSourceSchema),
  stocks: z.array(StockSchema),
  alertPlans: z.array(PersonalAlertPlanSchema).min(1).max(100),
  maxDailyNotifications: z.number().int().min(1).max(100),
});
export type PersonalAlertRequest = z.infer<typeof PersonalAlertRequestSchema>;
export const PersonalAlertQuoteErrorSchema = z.object({
  stockId: z.string(),
  reason: z.string().max(500),
});
export const PersonalAlertEvaluationDraftSchema = z.object({
  domainLeaseOwner: z.string().min(1),
  evaluatedAt: z.coerce.date(),
  quotes: z.array(QuoteSchema).max(100),
  quoteErrors: z.array(PersonalAlertQuoteErrorSchema).max(100),
});
export type PersonalAlertEvaluationDraft = z.infer<typeof PersonalAlertEvaluationDraftSchema>;
export const PersonalPriceConditionSchema = z.object({
  alertPlanId: z.string(),
  stockId: z.string(),
  ruleId: z.string(),
  ruleKind: z.enum(['price-level', 'price-change']),
  known: z.boolean(),
  active: z.boolean().optional(),
  value: z.number().optional(),
  reason: z.string(),
  evidence: z.array(z.string()).max(16),
  dataAsOf: z.coerce.date().optional(),
});
export type PersonalPriceCondition = z.infer<typeof PersonalPriceConditionSchema>;
export const PersonalAlertEvaluationSchema = z.object({
  id: z.string().min(1),
  operationId: z.string().min(1),
  mode: z.enum(['preview', 'formal']),
  watchlistId: z.string(),
  period: z.string().date(),
  watchlistRevision: HashSchema,
  ruleFingerprint: HashSchema,
  evaluatedAt: z.coerce.date(),
  status: z.enum(['complete', 'partial']),
  notificationPolicy: z.literal('never'),
  conditions: z.array(PersonalPriceConditionSchema).max(100_000),
  triggers: z.array(WatchTriggerSchema).max(100_000),
  initializedCount: z.number().int().nonnegative(),
});
export type PersonalAlertEvaluation = z.infer<typeof PersonalAlertEvaluationSchema>;

export const personalAlertLeaseOwner = (
  operationId: string,
  attemptId: string,
  fence: number,
): string => `personal-alerts:${operationId}:${attemptId}:${fence}`;

export const evaluatePersonalPriceAlerts = (input: {
  operationId: string;
  mode: 'preview' | 'formal';
  request: PersonalAlertRequest;
  quotes: readonly Quote[];
  quoteErrors: readonly z.infer<typeof PersonalAlertQuoteErrorSchema>[];
  states: readonly WatchRuleState[];
  priorTriggers: readonly WatchTrigger[];
  now: Date;
}): { evaluation: PersonalAlertEvaluation; states: WatchRuleState[] } => {
  const conditions: PersonalPriceCondition[] = [];
  const triggers: WatchTrigger[] = [];
  const states: WatchRuleState[] = [];
  let initializedCount = 0;
  const dayStart = new Date(`${dateInShanghai(input.now)}T00:00:00+08:00`);
  const reservedStatuses = new Set(['pending', 'sent', 'failed', 'fallback-log', 'unverifiable']);
  const personalPrior = input.priorTriggers.filter(
    (trigger) =>
      trigger.direction === 'watch' &&
      (trigger.ruleKind === 'price-level' || trigger.ruleKind === 'price-change'),
  );
  const reserved = personalPrior.filter(
    (trigger) =>
      reservedStatuses.has(trigger.deliveryStatus) || (trigger.deliveryAttempts ?? 0) > 0,
  );
  const todaysReservations = reserved.filter((trigger) => trigger.createdAt >= dayStart);
  let globalUsed = todaysReservations.reduce(
    (sum, trigger) => sum + Math.max(1, trigger.deliveryAttempts ?? 0),
    0,
  );
  const planUsed = new Map<string, number>();
  for (const trigger of todaysReservations)
    planUsed.set(
      trigger.poolId,
      (planUsed.get(trigger.poolId) ?? 0) + Math.max(1, trigger.deliveryAttempts ?? 0),
    );
  const quotes = new Map(input.quotes.map((quote) => [quote.stockId, quote]));
  const previousStates = new Map(
    input.states.map((state) => [`${state.poolId}|${state.stockId}|${state.ruleId}`, state]),
  );
  const stockIds = [
    ...new Set(
      input.request.members
        .filter(
          (member) =>
            member.stage !== 'archived' &&
            input.request.sources.some(
              (source) => source.memberId === member.id && source.status !== 'ended',
            ),
        )
        .map((member) => member.stockId),
    ),
  ].sort();
  const emit = (
    plan: PersonalAlertPlan,
    condition: PersonalPriceCondition,
    quote: Quote,
    previous: WatchRuleState | undefined,
    rule: PersonalAlertPlan['rules'][number],
  ) => {
    if (!condition.known) return;
    const active = condition.active === true;
    if (input.mode === 'formal') {
      if (previous === undefined) initializedCount += 1;
      const rising = previous !== undefined && !previous.active && active;
      states.push(
        WatchRuleStateSchema.parse({
          ...previous,
          alertPlanId: plan.id,
          poolId: plan.id,
          stockId: condition.stockId,
          ruleId: condition.ruleId,
          active,
          lastEvaluatedAt: input.now,
          lastValue: condition.value,
          firstTriggeredAt: rising
            ? (previous.firstTriggeredAt ?? input.now)
            : previous?.firstTriggeredAt,
          lastRecoveredAt: previous?.active && !active ? input.now : previous?.lastRecoveredAt,
        }),
      );
      if (previous === undefined) return;
    }
    const triggerType = active ? 'triggered' : 'recovered';
    const priorForRule = personalPrior.filter(
      (trigger) =>
        trigger.poolId === plan.id &&
        trigger.stockId === condition.stockId &&
        trigger.ruleId === condition.ruleId,
    );
    const hasEnteredToday = priorForRule.some(
      (trigger) => trigger.triggerType === 'triggered' && trigger.createdAt >= dayStart,
    );
    const entered =
      active &&
      (!previous?.active ||
        (rule.kind === 'price-change' && plan.triggerMode === 'daily-first' && !hasEnteredToday));
    const recovered = !active && previous?.active && plan.notifyOnRecovery;
    if (input.mode === 'preview' ? !active : !entered && !recovered) return;
    if (
      input.mode === 'formal' &&
      triggerType === 'triggered' &&
      plan.triggerMode === 'daily-first' &&
      hasEnteredToday
    )
      return;
    const recent = [...reserved, ...triggers].some(
      (trigger) =>
        trigger.poolId === plan.id &&
        trigger.stockId === condition.stockId &&
        trigger.ruleId === condition.ruleId &&
        reservedStatuses.has(trigger.deliveryStatus) &&
        trigger.createdAt.getTime() > input.now.getTime() - plan.cooldownMinutes * 60_000,
    );
    const deliveryStatus =
      input.mode === 'preview'
        ? 'not-requested'
        : recent
          ? 'suppressed-cooldown'
          : globalUsed >= input.request.maxDailyNotifications ||
              (planUsed.get(plan.id) ?? 0) >= plan.dailyNotificationLimit
            ? 'suppressed-daily-limit'
            : 'pending';
    const trigger = WatchTriggerSchema.parse({
      id: `personal-trigger:${input.operationId}:${triggers.length + 1}`,
      alertPlanId: plan.id,
      poolId: plan.id,
      stockId: condition.stockId,
      ruleKind: condition.ruleKind,
      ruleId: condition.ruleId,
      direction: 'watch',
      triggerType,
      reason:
        triggerType === 'recovered'
          ? `用户条件恢复：${condition.reason}`
          : `用户条件命中：${condition.reason}`,
      evidence: condition.evidence,
      quote: { close: quote.close, ts: quote.observedAt },
      priority: plan.priority ?? rule.priority ?? 'normal',
      deliveryStatus,
      notified: false,
      evalSnapshot: {
        ruleId: condition.ruleId,
        kind: condition.ruleKind,
        quoteClose: quote.close,
        quoteTs: quote.observedAt.toISOString(),
        threshold: rule.kind === 'price-level' ? rule.level : rule.pct,
        changePct: condition.ruleKind === 'price-change' ? condition.value : undefined,
        observedAt: quote.observedAt.toISOString(),
        timestampSource: quote.timestampSource,
      },
      createdAt: input.now,
    });
    triggers.push(trigger);
    if (deliveryStatus === 'pending') {
      globalUsed += 1;
      planUsed.set(plan.id, (planUsed.get(plan.id) ?? 0) + 1);
    }
  };
  for (const plan of [...input.request.alertPlans].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const stockId of stockIds) {
      const quote = quotes.get(stockId);
      const perRule = plan.rules.map((rule): PersonalPriceCondition => {
        const unavailable = input.quoteErrors.find((error) => error.stockId === stockId)?.reason;
        const base = { alertPlanId: plan.id, stockId, ruleId: rule.id, ruleKind: rule.kind };
        const stock = input.request.stocks.find((entry) => entry.id === stockId);
        if (stock === undefined || !['SH', 'SZ', 'BJ'].includes(stock.exchange))
          return {
            ...base,
            known: false,
            reason: '当前个人价格提醒只覆盖已识别的沪深北 A 股',
            evidence: [],
          };
        if (quote === undefined || !isIntradayQuoteCurrent(quote, input.now) || quote.close <= 0)
          return {
            ...base,
            known: false,
            reason: unavailable ?? '缺少可信且当前的交易时段行情',
            evidence: [],
          };
        if (rule.kind === 'price-change' && (quote.prevClose === undefined || quote.prevClose <= 0))
          return { ...base, known: false, reason: '缺少有效昨收，不能计算涨跌幅', evidence: [] };
        const value =
          rule.kind === 'price-level'
            ? Number(quote.close)
            : Number(quote.close) / Number(quote.prevClose) - 1;
        const active =
          rule.kind === 'price-level'
            ? rule.side === 'above'
              ? value >= rule.level
              : value <= rule.level
            : rule.direction === 'up'
              ? value >= rule.pct
              : rule.direction === 'down'
                ? value <= -rule.pct
                : Math.abs(value) >= rule.pct;
        const reason =
          rule.kind === 'price-level'
            ? `现价${rule.side === 'above' ? '≥' : '≤'}${rule.level}`
            : `日内${rule.direction === 'up' ? '上涨' : rule.direction === 'down' ? '下跌' : '涨跌'}幅达到 ${(rule.pct * 100).toFixed(2)}%`;
        return {
          ...base,
          known: true,
          active,
          value,
          reason,
          evidence: [
            `现价 ${quote.close}；昨收 ${quote.prevClose ?? '未知'}；市场时点 ${quote.observedAt.toISOString()}；来源 ${quote.source}`,
            reason,
          ],
          dataAsOf: quote.observedAt,
        };
      });
      conditions.push(...perRule);
      if (plan.logic === 'ANY') {
        for (const [index, condition] of perRule.entries()) {
          const rule = plan.rules[index];
          if (quote !== undefined && rule !== undefined)
            emit(
              plan,
              condition,
              quote,
              previousStates.get(`${plan.id}|${stockId}|${rule.id}`),
              rule,
            );
        }
      } else {
        const firstRule = plan.rules[0];
        if (firstRule === undefined) throw new InvariantError('个人价格条件不能为空');
        const known = perRule.every((condition) => condition.known);
        const condition: PersonalPriceCondition = {
          alertPlanId: plan.id,
          stockId,
          ruleId: 'composite',
          ruleKind: firstRule.kind,
          known,
          ...(known
            ? { active: perRule.every((entry) => entry.active), dataAsOf: quote?.observedAt }
            : {}),
          reason: known ? '所有用户条件同时命中' : '组合条件含未知数据，保留原状态',
          evidence: known ? perRule.flatMap((entry) => entry.evidence).slice(0, 16) : [],
        };
        conditions.push(condition);
        if (quote !== undefined)
          emit(
            plan,
            condition,
            quote,
            previousStates.get(`${plan.id}|${stockId}|composite`),
            firstRule,
          );
      }
    }
  }
  const evaluation = PersonalAlertEvaluationSchema.parse({
    id: `personal-alerts:${input.operationId}`,
    operationId: input.operationId,
    mode: input.mode,
    watchlistId: input.request.watchlistId,
    period: input.request.period,
    watchlistRevision: input.request.watchlistRevision,
    ruleFingerprint: input.request.ruleFingerprint,
    evaluatedAt: input.now,
    notificationPolicy: 'never',
    status: conditions.some((condition) => !condition.known) ? 'partial' : 'complete',
    conditions,
    triggers,
    initializedCount,
  });
  return { evaluation, states };
};
