import { z } from 'zod';
import {
  type AlertPlan,
  AlertPlanSchema,
  assertAlertPlanInvariants,
} from '../entity/alert-plan.js';
import { isIntradayQuoteCurrent, type Quote, QuoteSchema } from '../entity/quote.js';
import { type Report, ReportSchema } from '../entity/report.js';
import { type Stock, StockSchema } from '../entity/stock.js';
import {
  PriceChangeRuleSchema,
  PriceLevelRuleSchema,
  type WatchRuleState,
  WatchRuleStateSchema,
  type WatchTrigger,
  WatchTriggerSchema,
} from '../entity/watch-trigger.js';
import type { Watchlist, WatchlistMember, WatchlistMemberSource } from '../entity/watchlist.js';
import {
  WatchlistMemberSchema,
  WatchlistMemberSourceSchema,
  WatchlistSchema,
} from '../entity/watchlist.js';
import { InvariantError } from '../error/index.js';
import { dateInShanghai } from '../trading-calendar.js';

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const TenantExecutionRequestSchema = z.object({
  operationId: z.string().min(1),
  inputHash: HashSchema,
  generation: z.number().int().positive(),
  kind: z.enum(['watchlist-facts', 'watch-alerts']),
  input: z.record(z.string(), z.unknown()),
  createdAt: z.coerce.date(),
});
export type TenantExecutionRequest = z.infer<typeof TenantExecutionRequestSchema>;
export const TenantExecutionLeaseSchema = z.object({
  operationId: z.string().min(1),
  generation: z.number().int().positive(),
  fence: z.number().int().positive(),
  attemptId: z.string().min(1),
  expiresAt: z.coerce.date(),
});
export type TenantExecutionLease = z.infer<typeof TenantExecutionLeaseSchema>;
export const TenantOperationReceiptSchema = z.object({
  operationId: z.string().min(1),
  inputHash: HashSchema,
  resultRef: z.string().min(1),
  resultHash: HashSchema,
  status: z.enum(['succeeded', 'partial']),
  committedAt: z.coerce.date(),
});
export type TenantOperationReceipt = z.infer<typeof TenantOperationReceiptSchema>;
export const TenantOutboxSchema = TenantOperationReceiptSchema.extend({
  eventId: z.string().min(1),
  notificationPolicy: z.enum(['eligible', 'never']),
  notificationPolicyVersion: z.literal(1),
  businessKey: z.string().min(1),
  deliveries: z
    .array(
      z.object({
        businessKey: z.string().min(1),
        resultRef: z.string().min(1),
        notificationPolicy: z.enum(['eligible', 'never']),
      }),
    )
    .max(100)
    .optional(),
  acknowledgedAt: z.coerce.date().optional(),
});
export type TenantOutbox = z.infer<typeof TenantOutboxSchema>;

export const WatchlistImportRowSchema = z.object({
  row: z.number().int().positive(),
  text: z.string(),
  status: z.enum(['ready', 'duplicate', 'unknown', 'ambiguous']),
  candidates: z.array(StockSchema),
  stockId: z.string().optional(),
  duplicateOf: z.number().int().positive().optional(),
});
export type WatchlistImportRow = z.infer<typeof WatchlistImportRowSchema>;
export const WatchlistImportPreviewSchema = z.object({
  id: z.string().min(1),
  watchlistId: z.string().min(1),
  ownerUserId: z.string().min(1),
  inputHash: HashSchema,
  watchlistRevision: HashSchema,
  mappingVersion: HashSchema,
  rows: z.array(WatchlistImportRowSchema).min(1).max(100),
  ignoredColumns: z.array(z.string()),
  createdAt: z.coerce.date(),
});
export type WatchlistImportPreview = z.infer<typeof WatchlistImportPreviewSchema>;
export const WatchlistImportSelectionSchema = z.object({
  row: z.number().int().positive(),
  stockId: z.string().min(1),
});
export type WatchlistImportSelection = z.infer<typeof WatchlistImportSelectionSchema>;
export const WatchlistImportResultSchema = z.object({
  importBatchId: z.string().min(1),
  watchlistId: z.string().min(1),
  stockIds: z.array(z.string()),
  enteredCount: z.number().int().nonnegative(),
  unchangedCount: z.number().int().nonnegative(),
  distinctStockCount: z.number().int().nonnegative(),
  receipt: TenantOperationReceiptSchema,
});
export type WatchlistImportResult = z.infer<typeof WatchlistImportResultSchema>;
export const WatchlistRemovalResultSchema = z.object({
  results: z.array(
    z.object({
      stockId: z.string(),
      archived: z.boolean(),
      remainingSources: z.array(WatchlistMemberSourceSchema),
    }),
  ),
  receipt: TenantOperationReceiptSchema,
});
export type WatchlistRemovalResult = z.infer<typeof WatchlistRemovalResultSchema>;
export const PersonalWatchTriggerSnapshotSchema = WatchTriggerSchema.pick({
  id: true,
  alertPlanId: true,
  poolId: true,
  stockId: true,
  ruleKind: true,
  ruleId: true,
  direction: true,
  triggerType: true,
  reason: true,
  evidence: true,
  quote: true,
  priority: true,
  evalSnapshot: true,
  createdAt: true,
}).refine(
  (trigger) =>
    trigger.direction === 'watch' &&
    (trigger.ruleKind === 'price-level' || trigger.ruleKind === 'price-change'),
  { message: '个人反馈仅允许用户价格观察条件' },
);
export type PersonalWatchTriggerSnapshot = z.infer<typeof PersonalWatchTriggerSnapshotSchema>;
export const freezePersonalWatchTrigger = (
  trigger: WatchTrigger | PersonalWatchTriggerSnapshot,
): PersonalWatchTriggerSnapshot =>
  PersonalWatchTriggerSnapshotSchema.parse({
    ...trigger,
    evalSnapshot: Object.fromEntries(
      Object.entries(trigger.evalSnapshot).filter(
        ([key, value]) =>
          [
            'ruleId',
            'kind',
            'quoteClose',
            'quoteTs',
            'threshold',
            'changePct',
            'pct',
            'side',
            'priceLevel',
            'dataAsOf',
            'observedAt',
            'timestampSource',
          ].includes(key) &&
          (value === null || ['string', 'number', 'boolean'].includes(typeof value)),
      ),
    ),
  });
export const PersonalWatchFeedbackSchema = z.object({
  triggerId: z.string().min(1),
  triggerSnapshot: PersonalWatchTriggerSnapshotSchema,
  revision: z.number().int().positive(),
  rating: z.enum(['handled', 'useful', 'useless', 'ignored']),
  note: z.string().max(2000),
  recordedAt: z.coerce.date(),
  requestId: z.string().min(1),
  inputHash: HashSchema,
});
export type PersonalWatchFeedback = z.infer<typeof PersonalWatchFeedbackSchema>;

export const watchlistRevisionInput = (
  watchlist: Watchlist,
  members: readonly WatchlistMember[],
  sources: readonly WatchlistMemberSource[],
): string =>
  JSON.stringify({
    watchlist,
    members: [...members].sort((a, b) => a.id.localeCompare(b.id)),
    sources: [...sources].sort((a, b) => a.id.localeCompare(b.id)),
  });
export const watchlistRuleRevisionInput = (plans: readonly AlertPlan[]): string =>
  JSON.stringify([...plans].sort((a, b) => a.id.localeCompare(b.id)));

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
  receipt: TenantOperationReceiptSchema,
});
export type PersonalAlertPlanMutation = z.infer<typeof PersonalAlertPlanMutationSchema>;
export const PersonalAlertPlanRemovalSchema = z.object({
  alertPlanId: z.string(),
  receipt: TenantOperationReceiptSchema,
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
export const TenantPersonalAlertResultSchema = z.object({
  evaluation: PersonalAlertEvaluationSchema,
  receipt: TenantOperationReceiptSchema,
  replayed: z.boolean(),
});

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

const csvRows = (content: string): string[][] => {
  const rows: string[][] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < content.length; i += 1) {
    const c = content[i];
    if (c === '"') {
      if (quoted && content[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (quoted || cell.length === 0) quoted = !quoted;
      else throw new InvariantError('CSV 引号位置无效');
    } else if (!quoted && (c === ',' || c === '\n')) {
      cells.push(cell.replace(/\r$/, '').trim());
      cell = '';
      if (c === '\n') {
        rows.push(cells);
        cells = [];
      }
    } else cell += c;
  }
  if (quoted) throw new InvariantError('CSV 引号未闭合');
  cells.push(cell.replace(/\r$/, '').trim());
  if (cells.some((value) => value.length > 0)) rows.push(cells);
  return rows.filter((row) => row.some((value) => value.length > 0));
};

export const parseWatchlistImport = (
  content: string,
  format: 'text' | 'csv',
  catalog: readonly Stock[],
): { rows: WatchlistImportRow[]; ignoredColumns: string[]; normalizedInput: string } => {
  if (new TextEncoder().encode(content).length > 1_048_576)
    throw new InvariantError('自选输入不得超过 1 MiB');
  const clean = content.replace(/^\uFEFF/, '').normalize('NFKC');
  let tokens: string[];
  let ignoredColumns: string[] = [];
  if (format === 'csv') {
    const records = csvRows(clean);
    const header = records[0] ?? [];
    const names = [
      'stockid',
      'code',
      '证券代码',
      '股票代码',
      '代码',
      'name',
      '证券名称',
      '股票名称',
      '名称',
    ];
    const column = names.reduce(
      (found, name) =>
        found >= 0 ? found : header.findIndex((value) => value.toLowerCase() === name),
      -1,
    );
    const data = column < 0 ? records : records.slice(1);
    const index = Math.max(column, 0);
    ignoredColumns = header
      .filter((_, i) => i !== index)
      .map((value, i) => (column < 0 ? `column-${i + 2}` : value));
    tokens = data.map((row) => row[index] ?? '');
  } else
    tokens = clean
      .split(/\r?\n/)
      .map((row) => row.trim())
      .filter(Boolean);
  if (tokens.length === 0 || tokens.length > 100)
    throw new InvariantError('自选输入需为 1 至 100 行');
  const seen = new Map<string, number>();
  const rows = tokens.map((text, index): WatchlistImportRow => {
    const identity = text.trim().toUpperCase();
    const prefix = /^(SH|SZ|BJ)[.:]?(\d{6})$/.exec(identity);
    const normalized = prefix === null ? identity : `${prefix[2]}.${prefix[1]}`;
    const candidates = catalog.filter(
      (stock) =>
        stock.id.toUpperCase() === normalized ||
        stock.code === normalized ||
        stock.name === text.trim(),
    );
    const row = index + 1;
    if (candidates.length === 0) return { row, text, status: 'unknown', candidates };
    if (candidates.length > 1) return { row, text, status: 'ambiguous', candidates };
    const stockId = candidates[0]?.id as string;
    const duplicateOf = seen.get(stockId);
    if (duplicateOf !== undefined)
      return { row, text, status: 'duplicate', candidates, stockId, duplicateOf };
    seen.set(stockId, row);
    return { row, text, status: 'ready', candidates, stockId };
  });
  return { rows, ignoredColumns, normalizedInput: JSON.stringify({ format, tokens }) };
};

export const selectWatchlistImportStocks = (
  preview: WatchlistImportPreview,
  selections: readonly WatchlistImportSelection[],
  excludedRows: readonly number[],
  acknowledgeExtraColumns: boolean,
): string[] => {
  if (preview.ignoredColumns.length > 0 && !acknowledgeExtraColumns)
    throw new InvariantError('请确认额外列仅忽略，不会建立持仓或成交');
  const selected = new Map(selections.map((selection) => [selection.row, selection.stockId]));
  const excluded = new Set(excludedRows);
  if (
    selected.size !== selections.length ||
    excluded.size !== excludedRows.length ||
    selected.size === 0
  )
    throw new InvariantError('选择行需唯一且至少选择一只股票');
  if (selected.size + excluded.size !== preview.rows.length)
    throw new InvariantError('每一行必须明确选择或排除');
  for (const row of preview.rows) {
    const stockId = selected.get(row.row);
    if ((stockId !== undefined) === excluded.has(row.row))
      throw new InvariantError('每一行必须明确选择或排除');
    if (
      stockId !== undefined &&
      (row.status === 'duplicate' || !row.candidates.some((stock) => stock.id === stockId))
    )
      throw new InvariantError('不可选择重复或无法唯一识别的股票');
  }
  const stockIds = [...selected.values()];
  if (new Set(stockIds).size !== stockIds.length)
    throw new InvariantError('选择的规范股票身份不得重复');
  return stockIds;
};

export const buildWatchlistImportMutation = (input: {
  watchlist: Watchlist;
  members: readonly WatchlistMember[];
  sources: readonly WatchlistMemberSource[];
  stockIds: readonly string[];
  ownerUserId: string;
  importBatchId: string;
  maxDistinctStocks: number;
  now: Date;
}): {
  members: WatchlistMember[];
  sources: WatchlistMemberSource[];
  enteredCount: number;
  unchangedCount: number;
  distinctStockCount: number;
} => {
  if (input.watchlist.kind !== 'personal' || !input.watchlist.enabled)
    throw new InvariantError('导入只允许启用的个人自选');
  const currentMemberIds = new Set(
    input.sources.filter((source) => source.status !== 'ended').map((source) => source.memberId),
  );
  const distinct = new Set(
    input.members
      .filter((member) => member.stage !== 'archived' && currentMemberIds.has(member.id))
      .map((member) => member.stockId),
  );
  for (const stockId of input.stockIds) distinct.add(stockId);
  if (distinct.size > input.maxDistinctStocks)
    throw new InvariantError('关注股票数量超过当前套餐上限');
  const members: WatchlistMember[] = [];
  const sources: WatchlistMemberSource[] = [];
  let enteredCount = 0;
  const sourceKey = `import:${input.ownerUserId}`;
  for (const stockId of input.stockIds) {
    const old = input.members.find(
      (member) => member.watchlistId === input.watchlist.id && member.stockId === stockId,
    );
    const member: WatchlistMember = {
      id: old?.id ?? `${input.watchlist.id}:${stockId}`,
      watchlistId: input.watchlist.id,
      stockId,
      stage: old === undefined || old.stage === 'archived' ? 'watching' : old.stage,
      priority: old?.priority ?? 'normal',
      firstAddedAt: old?.firstAddedAt ?? input.now,
      lastActivityAt: input.now,
    };
    members.push(member);
    const current = input.sources.find(
      (source) =>
        source.memberId === member.id &&
        source.sourceKey === sourceKey &&
        source.status !== 'ended',
    );
    if (current !== undefined) continue;
    enteredCount += 1;
    sources.push({
      id: `${input.importBatchId}:${member.id}`,
      memberId: member.id,
      kind: 'import',
      sourceKey,
      ownerUserId: input.ownerUserId,
      importBatchId: input.importBatchId,
      reason: '用户确认的自选导入',
      status: 'active',
      evidence: [],
      validFrom: input.now,
    });
  }
  return {
    members,
    sources,
    enteredCount,
    unchangedCount: input.stockIds.length - enteredCount,
    distinctStockCount: distinct.size,
  };
};

export const buildPersonalMemberRemoval = (input: {
  members: readonly WatchlistMember[];
  sources: readonly WatchlistMemberSource[];
  ownerUserId: string;
  now: Date;
}): {
  members: WatchlistMember[];
  sources: WatchlistMemberSource[];
  results: { stockId: string; archived: boolean; remainingSources: WatchlistMemberSource[] }[];
} => {
  const members: WatchlistMember[] = [];
  const sources: WatchlistMemberSource[] = [];
  const results: {
    stockId: string;
    archived: boolean;
    remainingSources: WatchlistMemberSource[];
  }[] = [];
  for (const member of input.members) {
    const current = input.sources.filter(
      (source) => source.memberId === member.id && source.status !== 'ended',
    );
    const own = current.filter(
      (source) =>
        (source.kind === 'manual' || source.kind === 'import') &&
        (source.ownerUserId === undefined || source.ownerUserId === input.ownerUserId),
    );
    sources.push(
      ...own.map(
        (source): WatchlistMemberSource => ({ ...source, status: 'ended', validUntil: input.now }),
      ),
    );
    const remainingSources = current.filter(
      (source) => !own.some((ended) => ended.id === source.id),
    );
    const archived = remainingSources.length === 0;
    members.push(
      archived
        ? { ...member, stage: 'archived', archivedAt: input.now, lastActivityAt: input.now }
        : { ...member, lastActivityAt: input.now },
    );
    results.push({ stockId: member.stockId, archived, remainingSources });
  }
  return { members, sources, results };
};

export const preparePersonalDeliveryMutation = (input: {
  trigger: WatchTrigger | null;
  plan: AlertPlan | null;
  memberActive: boolean;
  priorTriggers: readonly WatchTrigger[];
  channel: 'email' | 'in-app';
  emailAttempt: number;
  maxDailyNotifications: number;
  now: Date;
}): { eligible: boolean; trigger: WatchTrigger | null } => {
  const { trigger, plan } = input;
  if (trigger === null) return { eligible: false, trigger: null };
  const personal =
    trigger.direction === 'watch' && ['price-level', 'price-change'].includes(trigger.ruleKind);
  if (
    !personal ||
    !input.memberActive ||
    plan?.enabled !== true ||
    plan.updatedAt > trigger.createdAt ||
    !['pending', 'sent', 'failed', 'unverifiable'].includes(trigger.deliveryStatus)
  )
    return { eligible: false, trigger };
  if (input.channel === 'in-app') return { eligible: true, trigger };
  if (input.emailAttempt > 3) return { eligible: false, trigger };
  const previous = trigger.deliveryAttempts ?? 0;
  const extra = Math.max(0, input.emailAttempt - Math.max(1, previous));
  const dayStart = new Date(`${dateInShanghai(input.now)}T00:00:00+08:00`);
  const reserved = input.priorTriggers.filter(
    (item) =>
      item.createdAt >= dayStart &&
      item.direction === 'watch' &&
      ['price-level', 'price-change'].includes(item.ruleKind) &&
      (['pending', 'sent', 'failed', 'fallback-log', 'unverifiable'].includes(
        item.deliveryStatus,
      ) ||
        (item.deliveryAttempts ?? 0) > 0),
  );
  const used = (items: readonly WatchTrigger[]) =>
    items.reduce((sum, item) => sum + Math.max(1, item.deliveryAttempts ?? 0), 0);
  if (
    used(reserved) + extra > input.maxDailyNotifications ||
    used(reserved.filter((item) => item.poolId === plan.id)) + extra > plan.dailyNotificationLimit
  )
    return { eligible: false, trigger };
  return {
    eligible: true,
    trigger: {
      ...trigger,
      deliveryAttempts: Math.max(previous, input.emailAttempt),
      lastDeliveryAttemptAt:
        input.emailAttempt > previous ? input.now : trigger.lastDeliveryAttemptAt,
    },
  };
};

export const syncPersonalDeliveryMutation = (
  trigger: WatchTrigger | null,
  input: Parameters<TenantRepository['syncPersonalDelivery']>[0],
): WatchTrigger | null => {
  if (trigger === null) return null;
  if (input.channel === 'email' && input.attempts < (trigger.deliveryAttempts ?? 0)) return trigger;
  const attempts =
    input.channel === 'email'
      ? Math.max(trigger.deliveryAttempts ?? 0, input.attempts)
      : trigger.deliveryAttempts;
  if (input.channel === 'in-app' && (attempts ?? 0) > 0) return trigger;
  const status =
    input.state === 'accepted'
      ? 'sent'
      : input.state === 'unknown'
        ? 'unverifiable'
        : input.state === 'suppressed'
          ? 'invalidated'
          : input.state === 'failed'
            ? 'failed'
            : 'pending';
  const invalidated = ['invalidated', 'expired'].includes(trigger.deliveryStatus);
  return {
    ...trigger,
    deliveryAttempts: attempts,
    deliveryStatus: invalidated ? trigger.deliveryStatus : status,
    notified: !invalidated && input.state === 'accepted',
    notificationId: input.notificationId,
    deliveryCompletedAt: ['accepted', 'failed', 'suppressed'].includes(input.state)
      ? input.now
      : trigger.deliveryCompletedAt,
  };
};

export interface TenantRepository {
  preparePersonalDelivery(input: {
    triggerId: string;
    channel: 'email' | 'in-app';
    emailAttempt: number;
    maxDailyNotifications: number;
    now: Date;
  }): Promise<{ eligible: boolean; trigger: WatchTrigger | null }>;
  syncPersonalDelivery(input: {
    triggerId: string;
    channel: 'email' | 'in-app';
    attempts: number;
    state: 'pending' | 'sending' | 'accepted' | 'failed' | 'unknown' | 'suppressed';
    notificationId: string;
    now: Date;
  }): Promise<WatchTrigger | null>;
  putExecutionRequest(request: TenantExecutionRequest): Promise<TenantExecutionRequest>;
  getExecutionRequest(operationId: string): Promise<TenantExecutionRequest | null>;
  getReceipt(operationId: string): Promise<TenantOperationReceipt | null>;
  claimExecution(input: {
    operationId: string;
    generation: number;
    attemptId: string;
    now: Date;
    leaseMs: number;
  }): Promise<
    | { kind: 'claimed'; lease: TenantExecutionLease }
    | { kind: 'completed'; receipt: TenantOperationReceipt }
    | { kind: 'busy' }
  >;
  renewExecution(input: {
    operationId: string;
    generation: number;
    fence: number;
    attemptId: string;
    now: Date;
    leaseMs: number;
  }): Promise<boolean>;
  putImportPreview(preview: WatchlistImportPreview): Promise<void>;
  getImportPreview(id: string): Promise<WatchlistImportPreview | null>;
  getWatchlistRevision(watchlistId: string): Promise<string>;
  commitWatchlistImport(input: {
    previewId: string;
    inputHash: string;
    requestId: string;
    ownerUserId: string;
    selections: readonly WatchlistImportSelection[];
    excludedRows: readonly number[];
    acknowledgeExtraColumns: boolean;
    maxDistinctStocks: number;
    now: Date;
  }): Promise<WatchlistImportResult>;
  removePersonalMembers(input: {
    watchlistId: string;
    stockIds: readonly string[];
    ownerUserId: string;
    requestId: string;
    now: Date;
  }): Promise<WatchlistRemovalResult>;
  commitFactsReport(input: {
    operationId: string;
    inputHash: string;
    generation: number;
    fence: number;
    attemptId: string;
    now: Date;
    report: Report;
    notificationPolicy: 'eligible' | 'never';
    businessKey: string;
  }): Promise<{ report: Report; receipt: TenantOperationReceipt; replayed: boolean }>;
  savePersonalAlertPlan(input: {
    plan: PersonalAlertPlan;
    expectedPlanRevision: string | null;
    requestId: string;
    enableConfirmed: boolean;
    maxEnabledRules: number;
    maxDailyNotifications: number;
    minCooldownMinutes: number;
    now: Date;
  }): Promise<PersonalAlertPlanMutation>;
  removePersonalAlertPlan(input: {
    alertPlanId: string;
    expectedPlanRevision: string;
    requestId: string;
    now: Date;
  }): Promise<PersonalAlertPlanRemoval>;
  getPersonalAlertEvaluation(resultRef: string): Promise<PersonalAlertEvaluation | null>;
  commitPersonalAlertEvaluation(input: {
    operationId: string;
    inputHash: string;
    generation: number;
    fence: number;
    attemptId: string;
    now: Date;
    draft?: PersonalAlertEvaluationDraft;
  }): Promise<{
    evaluation: PersonalAlertEvaluation;
    receipt: TenantOperationReceipt;
    replayed: boolean;
  }>;
  listOutbox(limit?: number): Promise<readonly TenantOutbox[]>;
  ackOutbox(eventId: string, now: Date): Promise<void>;
  recordPersonalFeedback(input: {
    triggerId: string;
    expectedRevision: number;
    rating: PersonalWatchFeedback['rating'];
    note: string;
    requestId: string;
    inputHash: string;
    now: Date;
  }): Promise<PersonalWatchFeedback>;
  listPersonalFeedback(triggerId: string): Promise<readonly PersonalWatchFeedback[]>;
  listAllPersonalFeedback(): Promise<readonly PersonalWatchFeedback[]>;
}

export const TenantFactsReportResultSchema = z.object({
  report: ReportSchema,
  receipt: TenantOperationReceiptSchema,
  replayed: z.boolean(),
});
