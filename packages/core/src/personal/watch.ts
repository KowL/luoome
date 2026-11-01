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

// ── 提醒核对的资格状态（外部评审决策 2，task-40 后续） ─────────────────────

/**
 * 「这条历史提醒现在还能不能作为依据」的**四档**结论 + 原因码。
 *
 * ## 为什么是四档而不是三档
 *
 * 旧口径 `requires-recheck` / `changed` / `unavailable` 把**语义不同、修复动作也不同**的情况
 * 压进同一个词里，于是「读不到账户事实」和「账户真的变了」共用 `changed`，
 * 「来源解析不出来」和「缺事实判不了」共用 `unavailable`。用户看到的是同一个词，
 * 要做的却是完全不同的事（去刷新行情 vs 去重新生成计划）。
 *
 * 四档的判据是**「我们能证明什么」**，不是「谁的错」：
 *
 * | state | 能证明什么 | 典型原因 |
 * |---|---|---|
 * | `conditions-unchecked` | **资格门槛全部通过**，只差用当前行情重新核验触发条件 | `ready` |
 * | `ineligible` | 已证实**不具备资格**（过期 / 账户变化 / 门槛未过 / 未到生效时间） | `expired`、`account-changed`、`draft`、`scheduled`、`inactive`、`no-conditions`、`constraints-failed`、`alert-plan-ineligible` |
 * | `facts-unavailable` | 缺事实，**只证明「无法判断」**，不能推出账户变了 | `monitoring.status === 'unavailable'` |
 * | `source-unavailable` | 对应**来源无法解析**（计划版本找不到、字段对不上、提醒没有计划来源） | `plan-version-not-found` 等 |
 *
 * ## 三条不可违反的纪律
 *
 * 1. **已证实的不可用（过期 / 账户变化 / 约束不通过）归 `ineligible`，且必须给具体原因**——
 *    不能被缺数状态掩盖。既过期又缺事实时报 `expired`，不报 `facts-unavailable`。
 * 2. **判定对象是「提醒引用的那一版」**（`sourcePlan`），不能因为出现新草稿就否定原生效版。
 * 3. 资格规则复用 `tradingPlanMonitoring` / `isWatchAlertDeliveryEligible`，
 *    **映射只在本文件实现一次**，不要在 surface 各写一遍。
 */
export const WATCH_NOTIFICATION_STATES = [
  'conditions-unchecked',
  'ineligible',
  'facts-unavailable',
  'source-unavailable',
] as const;
export const WatchNotificationStateSchema = z.enum(WATCH_NOTIFICATION_STATES);
export type WatchNotificationState = z.infer<typeof WatchNotificationStateSchema>;

/**
 * `ineligible` / `facts-unavailable` / `source-unavailable` 的具体原因。
 * 保留原因是为了让「四档」不重新长出「压成同一个词」的老问题。
 */
export const WATCH_NOTIFICATION_REASONS = [
  /** 计划已过期（status=expired 或超过 validUntil）。 */
  'expired',
  /** 可靠指纹差异：持仓或现金变了，计划前提失效。 */
  'account-changed',
  /** 历史版本不再参与监控（被后续版本替代 / revoked）。 */
  'inactive',
  /** 计划约束未通过。 */
  'constraints-failed',
  /** 草案尚未通过生效门槛；重新检查行情不会使它自动获得资格。 */
  'draft',
  /** `validFrom` 未到；不证明后台任务已经排期。 */
  'scheduled',
  /** 计划没有可检查的盘中条件。 */
  'no-conditions',
  /** 账户事实读不到或状态非 complete：只能判「无法判断」。 */
  'facts-unavailable',
  /** 告警计划停用 / 规则已改 / 成员退出 / 观察列表停用。 */
  'alert-plan-ineligible',
  /** 提醒引用的计划版本已不可解析（被 remove 或与账户/股票对不上）。 */
  'plan-version-not-found',
  /** 这条提醒没有任何可解析的计划来源。 */
  'trigger-without-plan-source',
] as const;
export const WatchNotificationReasonSchema = z.enum(WATCH_NOTIFICATION_REASONS);
export type WatchNotificationReason = z.infer<typeof WatchNotificationReasonSchema>;

/** 一次核对的完整结论；`reason` 只在需要解释时出现（`conditions-unchecked` 不带）。 */
export const WatchNotificationVerdictSchema = z
  .object({
    state: WatchNotificationStateSchema,
    reason: WatchNotificationReasonSchema.optional(),
  })
  .strict()
  .superRefine((verdict, ctx) => {
    // `conditions-unchecked` 表示「已通过全部门槛」，带原因会把「合格」重新说成「有毛病」。
    if (verdict.state === 'conditions-unchecked' && verdict.reason !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'conditions-unchecked 不带原因码',
      });
    if (verdict.state !== 'conditions-unchecked' && verdict.reason === undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: `${verdict.state} 必须给出具体原因`,
      });
  });
export type WatchNotificationVerdict = z.infer<typeof WatchNotificationVerdictSchema>;

/**
 * `tradingPlanMonitoring().status` → 四档 + 原因。**唯一映射实现。**
 *
 * 注意顺序纪律：`expired` / `account-changed` / `constraints-failed` 是**已证实**的，
 * 一律 `ineligible`；只有 `unavailable` 才是「缺事实」。把前者塞进 `facts-unavailable`
 * 会让「计划早就过期了」被说成「暂时读不到数据」，用户会一直等下去。
 */
export const watchNotificationVerdictFromMonitoring = (monitoring: {
  readonly status: string;
  readonly reason?: string;
}): WatchNotificationVerdict => {
  switch (monitoring.status) {
    case 'ready':
      return { state: 'conditions-unchecked' };
    case 'expired':
      return { state: 'ineligible', reason: 'expired' };
    case 'account-changed':
      return { state: 'ineligible', reason: 'account-changed' };
    case 'inactive':
      return { state: 'ineligible', reason: 'inactive' };
    case 'no-conditions':
      return { state: 'ineligible', reason: 'no-conditions' };
    case 'draft':
      return { state: 'ineligible', reason: 'draft' };
    case 'scheduled':
      return { state: 'ineligible', reason: 'scheduled' };
    case 'unavailable':
      // `tradingPlanMonitoring` 用 `unavailable` 同时表达「账户事实读不到」和
      // 「计划约束未通过」——前者是缺事实，后者是**已证实**不合格，必须分开。
      return monitoring.reason === '计划约束未通过'
        ? { state: 'ineligible', reason: 'constraints-failed' }
        : { state: 'facts-unavailable', reason: 'facts-unavailable' };
    default:
      // 未知 monitoring 状态：不能当成合格，也不能编一个具体原因。
      return { state: 'facts-unavailable', reason: 'facts-unavailable' };
  }
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
