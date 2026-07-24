import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { type Money, MoneySchema } from '../types/branded.js';

/**
 * 股票池 + 盯盘规则 + 触发（v0.6 起，docs/intraday-watch-design.md；
 * 分组化改造见 docs/stock-group-design.md §5；
 * 策略预警扩展 docs/ddd/strategy-alert-detailed-design.md §3）。
 *
 * 设计要点：
 * - 池（StockPool）= 成员分组引用（groupId → StockGroup）+ 规则列表（WatchRule）+ 冷却 + enabled
 *   「成员是谁」由 StockGroup 回答（见 entity/stock-group.ts），pool 只管盯盘规则
 * - 触发（WatchTrigger）= 池 + 股票 + 规则 + 方向 + 理由 + 证据 + 行情快照
 * - 评估时机：每条 rule 独立判断，stockPool.logic 决定 ANY（默认）/ ALL
 * - 落库：StockPool / WatchTrigger / WatchRuleState 都走各自 Repository，规则不变量在此断言
 */

// ---------- 枚举 ----------

/** 触发方向：买入 / 卖出 / 观察。 */
export type WatchDirection = 'buy' | 'sell' | 'watch';

export const WatchDirectionSchema = z.enum(['buy', 'sell', 'watch']);

/** 规则类型。Phase 1 新增 price-level；volume-ratio / drawdown-from-high 留 Phase 2。 */
export type WatchRuleKind = 'tactic' | 'cost-threshold' | 'price-change' | 'price-level';

export const WatchRuleKindSchema = z.enum([
  'tactic',
  'cost-threshold',
  'price-change',
  'price-level',
]);

/** 方案级组合逻辑：任一规则命中即触发（默认），或所有规则同时进入 active 才触发。 */
export const PlanLogicSchema = z.enum(['ANY', 'ALL']);
export type PlanLogic = z.infer<typeof PlanLogicSchema>;

/** 规则级触发模式。 */
export const TriggerModeSchema = z.enum(['on-enter', 'repeat', 'daily-first']);
export type TriggerMode = z.infer<typeof TriggerModeSchema>;

/** 告警优先级；方案级 / 规则级可覆盖，按 pool.priority ?? rule.priority ?? 种类推导生效。 */
export const AlertPrioritySchema = z.enum(['urgent', 'important', 'normal']);
export type AlertPriority = z.infer<typeof AlertPrioritySchema>;

/** 触发类型：进入（rising edge）vs 退出（recovered 候选）。 */
export const TriggerTypeSchema = z.enum(['triggered', 'recovered']);
export type TriggerType = z.infer<typeof TriggerTypeSchema>;

/** 单条触发的送达状态（详细语义见 docs/ddd/strategy-alert-detailed-design.md §8）。 */
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

// ---------- WatchRule（discriminated union on `kind`） ----------

const RuleBaseFields = {
  /** 稳定 ruleId，pool 内唯一。缺省时 tool 层创建生成（`r_${crypto.randomUUID().slice(0, 8)}`）。 */
  id: z.string().min(1).optional(),
  /** 规则级优先级，缺省走方案默认 / 种类推导。 */
  priority: AlertPrioritySchema.optional(),
};

/** 战法命中：bullish→buy / bearish→sell / neutral→watch；score ≥ minScore 才触发。 */
export const TacticRuleSchema = z.object({
  ...RuleBaseFields,
  kind: z.literal('tactic'),
  tacticId: z.string().min(1),
  /** 缺省 60，避免裸配置噪声；区间 [0, 100]。 */
  minScore: z.number().min(0).max(100).default(60),
});

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

export const WatchRuleSchema = z.discriminatedUnion('kind', [
  TacticRuleSchema,
  CostThresholdRuleSchema,
  PriceChangeRuleSchema,
  PriceLevelRuleSchema,
]);

export type WatchRule = z.infer<typeof WatchRuleSchema>;
export type TacticRule = z.infer<typeof TacticRuleSchema>;
export type CostThresholdRule = z.infer<typeof CostThresholdRuleSchema>;
export type PriceChangeRule = z.infer<typeof PriceChangeRuleSchema>;
export type PriceLevelRule = z.infer<typeof PriceLevelRuleSchema>;

// ---------- StockPool ----------

export const StockPoolSchema = z.object({
  /** slug，kebab-case（与战法 id 规则一致）。 */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, {
    message: 'pool.id 必须小写 kebab-case，长度 2-64',
  }),
  name: z.string().min(1).max(64),
  description: z.string().max(500).optional(),
  /**
   * 成员分组引用（stock_groups.id）。
   * 不做 min(1)：旧库（分组化迁移前）的行 groupId 为空串占位，读出 / 序列化不 crash；
   * 新写入由 tool 层校验分组存在（create_stock_pool / update_stock_pool）。
   */
  groupId: z.string(),
  rules: z.array(WatchRuleSchema).min(1),
  /** 同 (poolId, stockId, ruleId) 通知冷却分钟数；区间 [1, 1440]。 */
  cooldownMinutes: z.number().int().min(1).max(1440).default(30),
  enabled: z.boolean().default(true),
  /** 方案级组合逻辑（默认 ANY）。 */
  logic: PlanLogicSchema.default('ANY'),
  /** 方案级触发模式（默认 on-enter）；price-level 永远走 on-enter，忽略此设置。 */
  triggerMode: TriggerModeSchema.default('on-enter'),
  /** 方案级默认优先级；规则级 priority 缺省时回退到此。 */
  priority: AlertPrioritySchema.optional(),
  /** 单方案每日触发上限（仅 ATTEMPTED 状态计数），默认 20。 */
  dailyNotificationLimit: z.number().int().min(1).max(500).default(20),
  /** true 时规则退出 active 也会产生 recovered 候选（默认 false）。 */
  notifyOnRecovery: z.boolean().default(false),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type StockPool = z.infer<typeof StockPoolSchema>;

// ---------- WatchTrigger ----------

export const WatchTriggerSchema = z.object({
  id: z.string().min(1),
  poolId: z.string().min(1),
  stockId: z.string().min(1),
  ruleKind: WatchRuleKindSchema,
  /** 规则实例 id（与 stock_pool.rules[].id 对齐）；ALL 组合触发固定为 'composite'。 */
  ruleId: z.string().min(1),
  direction: WatchDirectionSchema,
  /** 触发的具体类型（进入 / 恢复），默认 'triggered'。 */
  triggerType: TriggerTypeSchema.default('triggered'),
  reason: z.string().min(1).max(500),
  evidence: z.array(z.string().min(1)).min(1).max(16),
  /** 触发时的实时行情快照（review fix：触发持久化保留 quote 便于复盘）。 */
  quote: z.object({
    close: MoneySchema,
    ts: z.coerce.date(),
  }),
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
 * 边沿状态（docs/ddd/strategy-alert-detailed-design.md §3.5 / §5）：
 * - 每个 (poolId, stockId, ruleId) 一行
 * - 仅 active: boolean 参与求值判定；firstTriggeredAt / lastEvaluatedAt 用于观察与恢复文案
 * - virtual ruleId `'composite'` 用于 ALL 组合方案
 * - 不替代 watch_triggers 历史
 */
export const WatchRuleStateSchema = z.object({
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

// ---------- 优先级推导 ----------

/**
 * 优先级生效顺序：rule.priority ?? pool.priority ?? 种类推导（docs/.../§3.3）。
 *
 * | 规则 | 推导优先级 |
 * |---|---|
 * | cost-threshold 止损侧 | urgent |
 * | cost-threshold 止盈侧 | important |
 * | price-level | important |
 * | tactic（minScore ≥ 70） | important |
 * | price-change / tactic（minScore < 70） / recovered | normal |
 */
export const deriveRulePriority = (
  rule: WatchRule,
  poolPriority?: AlertPriority,
): AlertPriority => {
  if (rule.priority !== undefined) return rule.priority;
  if (poolPriority !== undefined) return poolPriority;
  return derivePriorityByKind(rule);
};

const derivePriorityByKind = (rule: WatchRule): AlertPriority => {
  switch (rule.kind) {
    case 'cost-threshold':
      if (rule.stopLossPct !== undefined) return 'urgent';
      return 'important';
    case 'price-level':
      return 'important';
    case 'tactic':
      return rule.minScore >= 70 ? 'important' : 'normal';
    case 'price-change':
      return 'normal';
  }
};

// ---------- 不变量 ----------

/**
 * 池不变量（docs/intraday-watch-design.md §1 + stock-group-design.md §5 + strategy-alert §3）：
 * - id slug 合法（schema 已 regex，runtime 兜底长度）
 * - rules ≥ 1（schema 已 min(1)）
 * - updatedAt ≥ createdAt
 * - rules[].id 在 pool 内唯一（缺省 id 也视为合法的「未生成」状态，不参与唯一性校验）
 *
 * 分组选股战法与 tactic 触发战法刻意解耦：成员可由战法 A 产出，再由战法 B 监控。
 * assertStockPoolInvariants 只断言 pool 自身可校验的不变量。
 */
export const assertStockPoolInvariants = (pool: StockPool): void => {
  if (pool.id.length < 2 || pool.id.length > 64) {
    throw new InvariantError(`pool.id 长度 2-64，实际 ${pool.id.length}`);
  }
  if (pool.rules.length === 0) {
    throw new InvariantError('pool.rules 不能为空');
  }
  if (pool.updatedAt.getTime() < pool.createdAt.getTime()) {
    throw new InvariantError(`pool.updatedAt < pool.createdAt`);
  }
  const seenIds = new Set<string>();
  for (const r of pool.rules) {
    if (r.id === undefined) continue;
    if (seenIds.has(r.id)) {
      throw new InvariantError(`pool.rules[].id 重复：${r.id}`);
    }
    seenIds.add(r.id);
  }
};

/**
 * 触发不变量：quote.close > 0；evidence 非空（schema 已约束，runtime 兜底）；evalSnapshot 非空。
 *
 * notified 字段保留兼容：新写入由 workflow 派生（deliveryStatus ∈ ATTEMPTED 为 true）。
 */
export const assertWatchTriggerInvariants = (t: WatchTrigger): void => {
  if (!(t.quote.close > 0)) {
    throw new InvariantError(`watch trigger quote.close 必须 > 0，实际 ${t.quote.close}`);
  }
  if (t.evidence.length === 0) {
    throw new InvariantError('watch trigger evidence 不能为空');
  }
  // evalSnapshot 是评估细节包，要求至少含 ruleId 一项，put 在 workflow 端保证；runtime 不重复断言。
};

// Money re-export for callers that want the branded type without touching branded.ts.
export type { Money };
