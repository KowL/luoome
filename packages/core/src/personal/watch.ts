import { z } from 'zod';
import { type WatchTrigger, WatchTriggerSchema } from '../entity/watch-trigger.js';
import { HashSchema } from './hash.js';

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

/** 交易计划监控池的 poolId 前缀；构造方与解析方共用这一个常量。 */
export const TRADING_PLAN_WATCH_POOL_PREFIX = 'trading-plan-watch:';

/** 交易计划监控池的 poolId（每个账户一个）：`trading-plan-watch:<accountId>`。 */
export const tradingPlanWatchPoolId = (accountId: string): string =>
  `${TRADING_PLAN_WATCH_POOL_PREFIX}${accountId}`;

const TradingPlanTriggerSourceSchema = z.object({
  planVersionId: z.string().min(1),
  conditionId: z.string().min(1),
  accountFactsDigest: z.string().min(1),
  validUntil: z.coerce.date(),
});

/** 交易计划触发的来源解析；非交易计划触发返回 null。 */
export const tradingPlanTriggerSource = (trigger: WatchTrigger) => {
  const prefix = TRADING_PLAN_WATCH_POOL_PREFIX;
  if (!trigger.poolId.startsWith(prefix)) return null;
  const accountId = trigger.poolId.slice(prefix.length);
  const parsed = TradingPlanTriggerSourceSchema.safeParse(trigger.evalSnapshot);
  if (
    accountId.length === 0 ||
    !parsed.success ||
    trigger.ruleId !== `${parsed.data.planVersionId}:${parsed.data.conditionId}`
  )
    return null;
  return { accountId, ...parsed.data };
};

/**
 * `WatchTrigger.alertPlanId` 的**唯一**语义解析（REQ-M4-01 / task-40）。
 *
 * 这个字段历史上装了两样完全不同的东西，于是每个消费方各自
 * `poolId.startsWith('trading-plan-watch:')` 猜一次，猜错一次就多一个 bug：
 *
 * - watchlist 规则触发的写入方放的是 `AlertPlan.id`（`intraday-watch`）；
 * - 交易计划触发的写入方放的是 poolId `trading-plan-watch:<accountId>`
 *   （`intraday-trading-plan-watch`），它**不是** `AlertPlan.id`。
 *
 * 直接把 `alertPlanId` 丢给 `alertPlan.findById` 的调用方（例如批次 C 的
 * `resolve_watch_notification`），在计划类提醒上**必然** not-found——那是字段语义，
 * 不是数据缺失。
 *
 * 解析顺序是**先看池前缀，再看 `AlertPlan.id`**：池前缀是可判定的，`AlertPlan.id`
 * 可能有任意取值，反过来先查 `AlertPlan` 会把「恰好存在同名 AlertPlan」的池 id 认错。
 */
export type WatchTriggerPlanSource =
  /** watchlist 规则触发：`alertPlanId` 就是 `AlertPlan.id`。 */
  | { readonly kind: 'alert-plan'; readonly alertPlanId: string }
  /**
   * 交易计划监控池触发。`versionId` 是**计划版本**（`<planId>:v<version>`），
   * 只有 `evalSnapshot` 自洽时才给出；给出时它足以还原「提醒发出时的那一版」。
   */
  | {
      readonly kind: 'trading-plan-watch';
      readonly accountId: string;
      readonly versionId?: string;
      readonly conditionId?: string;
    }
  /** 字段缺失，或池 id 前缀已识别但内容不自洽、又不落在任何 `AlertPlan` 上。 */
  | { readonly kind: 'unknown'; readonly raw: string };

export const watchTriggerPlanSource = (trigger: WatchTrigger): WatchTriggerPlanSource => {
  const planTrigger = tradingPlanTriggerSource(trigger);
  if (planTrigger !== null)
    return {
      kind: 'trading-plan-watch',
      accountId: planTrigger.accountId,
      versionId: planTrigger.planVersionId,
      conditionId: planTrigger.conditionId,
    };
  // 前缀对但 evalSnapshot 不自洽（旧行 / 手工构造）：仍然**不是** AlertPlan。
  if (trigger.poolId.startsWith(TRADING_PLAN_WATCH_POOL_PREFIX)) {
    const accountId = trigger.poolId.slice(TRADING_PLAN_WATCH_POOL_PREFIX.length);
    return accountId.length === 0
      ? { kind: 'unknown', raw: trigger.poolId }
      : { kind: 'trading-plan-watch', accountId };
  }
  const alertPlanId = trigger.alertPlanId;
  if (alertPlanId !== undefined && alertPlanId.length > 0)
    return { kind: 'alert-plan', alertPlanId };
  return { kind: 'unknown', raw: trigger.poolId };
};
