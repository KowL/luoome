import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { type Money, MoneySchema } from '../types/branded.js';
import { EventImportanceSchema, StockEventKindSchema } from './stock-event.js';

/**
 * 盯盘触发 + 边沿状态 + AlertPlan 共享的规则 schema
 * （docs/ddd/strategy-watchlist-unification-detailed-design.md §3）。
 *
 * 旧 StockPool 实体已随 strategy-watchlist 迁移下线；本文件保留：
 * - 触发（WatchTrigger）= 方案 + 股票 + 规则 + 方向 + 理由 + 证据 + 行情快照
 * - WatchRuleState 边沿状态机
 * - AlertPlan（entity/alert-plan.ts）复用的规则 schema 与枚举
 */

// ---------- 枚举 ----------

/** 触发方向：买入 / 卖出 / 观察。 */
export type WatchDirection = 'buy' | 'sell' | 'watch';

export const WatchDirectionSchema = z.enum(['buy', 'sell', 'watch']);

/**
 * 规则类型。'tactic' 仅为存量 watch_triggers 行的读兼容保留（旧池规则的
 * rule_kind 落库值），新规则不再产生。
 */
export type WatchRuleKind =
  | 'tactic'
  | 'strategy-signal'
  | 'cost-threshold'
  | 'price-change'
  | 'price-level'
  | 'event-date';

export const WatchRuleKindSchema = z.enum([
  'tactic',
  'strategy-signal',
  'cost-threshold',
  'price-change',
  'price-level',
  'event-date',
]);

/** 方案级组合逻辑：任一规则命中即触发（默认），或所有规则同时进入 active 才触发。 */
export const PlanLogicSchema = z.enum(['ANY', 'ALL']);
export type PlanLogic = z.infer<typeof PlanLogicSchema>;

/** 规则级触发模式。 */
export const TriggerModeSchema = z.enum(['on-enter', 'repeat', 'daily-first']);
export type TriggerMode = z.infer<typeof TriggerModeSchema>;

/** 告警优先级；方案级 / 规则级可覆盖，按 plan.priority ?? rule.priority ?? 种类推导生效。 */
export const AlertPrioritySchema = z.enum(['urgent', 'important', 'normal']);
export type AlertPriority = z.infer<typeof AlertPrioritySchema>;

/** 触发类型：进入（rising edge）vs 退出（recovered 候选）。 */
export const TriggerTypeSchema = z.enum(['triggered', 'recovered']);
export type TriggerType = z.infer<typeof TriggerTypeSchema>;

/** 单条触发的送达状态（详细语义见 docs/ddd/strategy-watchlist-unification-detailed-design.md §8）。 */
export const DeliveryStatusSchema = z.enum([
  'not-requested',
  'suppressed-cooldown',
  'suppressed-daily-limit',
  'pending',
  'sent',
  'failed',
  'fallback-log',
]);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

/** 视为「外部发送被尝试」的状态集合，用于 cooldown / 每日上限计数（failed 计入避免失败重试风暴）。 */
export const ATTEMPTED_DELIVERY_STATUSES = ['sent', 'failed', 'fallback-log'] as const;
export type AttemptedDeliveryStatus = (typeof ATTEMPTED_DELIVERY_STATUSES)[number];

export const TriggerFeedbackSchema = z.enum(['handled', 'useful', 'useless', 'ignored']);
export type TriggerFeedback = z.infer<typeof TriggerFeedbackSchema>;

// ---------- AlertPlan 共享规则 schema ----------

const RuleBaseFields = {
  /** 稳定 ruleId，方案内唯一。缺省时 tool 层创建生成（`r_${crypto.randomUUID().slice(0, 8)}`）。 */
  id: z.string().min(1).optional(),
  /** 规则级优先级，缺省走方案默认 / 种类推导。 */
  priority: AlertPrioritySchema.optional(),
};

/** 持仓成本阈值：现价 vs avgCost 触发止盈 / 止损；pct ∈ (0, 1]（5% → 0.05）。 */
export const CostThresholdRuleSchema = z
  .object({
    ...RuleBaseFields,
    kind: z.literal('cost-threshold'),
    stopLossPct: z.number().positive().max(1).optional(),
    takeProfitPct: z.number().positive().max(1).optional(),
  })
  .refine((r) => r.stopLossPct !== undefined || r.takeProfitPct !== undefined, {
    message: 'cost-threshold 规则必须至少指定 stopLossPct 或 takeProfitPct',
  });

/** 日内涨跌幅：direction=up 时 close ≥ prevClose*(1+pct)；down 类推；any 取双侧绝对值。pct ∈ (0, 1]。 */
export const PriceChangeRuleSchema = z.object({
  ...RuleBaseFields,
  kind: z.literal('price-change'),
  pct: z.number().positive().max(1),
  /** 缺省 'any'，兼容旧配置。 */
  direction: z.enum(['up', 'down', 'any']).default('any'),
});

/** 价格穿越型：above = close ≥ level（上穿），below = close ≤ level（下穿）。永远只走 on-enter 边沿。 */
export const PriceLevelRuleSchema = z.object({
  ...RuleBaseFields,
  kind: z.literal('price-level'),
  /** level 为正数阈值；不像实时金额允许 0（穿越位 = 0 没意义）。 */
  level: z.number().positive(),
  side: z.enum(['above', 'below']),
});

/**
 * 事件日期型（ruo 能力迁移 §3.5）：每日 workflow（evaluate-event-rules）求值，intraday-watch 跳过。
 * direction 固定 'watch'，priority 由事件 importance 映射（求值时覆盖）。
 */
export const EventDateRuleSchema = z.object({
  ...RuleBaseFields,
  kind: z.literal('event-date'),
  /** 关注的事件类型；缺省 = 全部。 */
  eventKinds: z.array(StockEventKindSchema).optional(),
  /** 最低重要性；缺省 normal（全部）。 */
  minImportance: EventImportanceSchema.default('normal'),
  /** 默认提醒窗口（天）；事件级 remindBeforeDays 非空时被覆盖。 */
  daysBefore: z.array(z.number().int().min(0).max(90)).max(8).default([7, 3, 1]),
});

export type CostThresholdRule = z.infer<typeof CostThresholdRuleSchema>;
export type PriceChangeRule = z.infer<typeof PriceChangeRuleSchema>;
export type PriceLevelRule = z.infer<typeof PriceLevelRuleSchema>;
export type EventDateRule = z.infer<typeof EventDateRuleSchema>;

// ---------- WatchTrigger ----------

export const WatchTriggerSchema = z.object({
  id: z.string().min(1),
  alertPlanId: z.string().min(1).optional(),
  poolId: z.string().min(1),
  stockId: z.string().min(1),
  ruleKind: WatchRuleKindSchema,
  /** 规则实例 id（与 alert_plan.rules[].id 对齐）；ALL 组合触发固定为 'composite'。 */
  ruleId: z.string().min(1),
  /** event-date 触发关联的公司事件 id（非 event-date 触发为空）。 */
  eventId: z.string().optional(),
  direction: WatchDirectionSchema,
  /** 触发的具体类型（进入 / 恢复），默认 'triggered'。 */
  triggerType: TriggerTypeSchema.default('triggered'),
  reason: z.string().min(1).max(500),
  evidence: z.array(z.string().min(1)).min(1).max(16),
  /**
   * 触发时的实时行情快照（review fix：触发持久化保留 quote 便于复盘）。
   * event-date 触发无实时行情，quote 可空。
   */
  quote: z
    .object({
      close: MoneySchema,
      ts: z.coerce.date(),
    })
    .optional(),
  /** 落库时的生效优先级，不再反推。 */
  priority: AlertPrioritySchema,
  /** 单条送达状态机落值。 */
  deliveryStatus: DeliveryStatusSchema,
  /** 关联的 Notification 记录（发送成功 / 失败后回写）。 */
  notificationId: z.string().optional(),
  /** 求值快照：输入值 / 阈值 / 窗口 / 数据时间；至少包含 ruleId / kind / quoteClose / quoteTs / threshold。 */
  evalSnapshot: z.record(z.string(), z.unknown()),
  notified: z.boolean(),
  /** 用户反馈（handled / useful / useless / ignored），由 set_watch_trigger_feedback 写入。 */
  feedback: TriggerFeedbackSchema.optional(),
  feedbackAt: z.coerce.date().optional(),
  createdAt: z.coerce.date(),
});

export type WatchTrigger = z.infer<typeof WatchTriggerSchema>;

// ---------- WatchRuleState（边沿状态机） ----------

/**
 * 边沿状态（docs/ddd/strategy-watchlist-unification-detailed-design.md §3.5 / §5）：
 * - 每个 (poolId, stockId, ruleId) 一行
 * - 仅 active: boolean 参与求值判定；firstTriggeredAt / lastEvaluatedAt 用于观察与恢复文案
 * - virtual ruleId `'composite'` 用于 ALL 组合方案
 * - 不替代 watch_triggers 历史
 */
export const WatchRuleStateSchema = z.object({
  alertPlanId: z.string().min(1).optional(),
  poolId: z.string().min(1),
  stockId: z.string().min(1),
  ruleId: z.string().min(1),
  active: z.boolean(),
  firstTriggeredAt: z.coerce.date().optional(),
  lastEvaluatedAt: z.coerce.date(),
  /** 最近一次求值量（如 changePct / pnlPct），仅展示用。 */
  lastValue: z.number().optional(),
  lastRecoveredAt: z.coerce.date().optional(),
});

export type WatchRuleState = z.infer<typeof WatchRuleStateSchema>;

// ---------- 不变量 ----------

/**
 * 触发不变量：quote.close > 0；evidence 非空（schema 已约束，runtime 兜底）；evalSnapshot 非空。
 *
 * notified 字段保留兼容：新写入由 workflow 派生（deliveryStatus ∈ ATTEMPTED 为 true）。
 */
export const assertWatchTriggerInvariants = (t: WatchTrigger): void => {
  if (t.quote !== undefined && !(t.quote.close > 0)) {
    throw new InvariantError(`watch trigger quote.close 必须 > 0，实际 ${t.quote.close}`);
  }
  if (t.evidence.length === 0) {
    throw new InvariantError('watch trigger evidence 不能为空');
  }
  // evalSnapshot 是评估细节包，要求至少含 ruleId 一项，put 在 workflow 端保证；runtime 不重复断言。
};

// Money re-export for callers that want the branded type without touching branded.ts.
export type { Money };
