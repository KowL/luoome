import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { type Money, MoneySchema } from '../types/branded.js';

/**
 * 股票池 + 盯盘规则 + 触发（v0.6 起，docs/intraday-watch-design.md；
 * 分组化改造见 docs/stock-group-design.md §5）。
 *
 * 设计要点：
 * - 池（StockPool）= 成员分组引用（groupId → StockGroup）+ 规则列表（WatchRule）+ 冷却 + enabled
 *   「成员是谁」由 StockGroup 回答（见 entity/stock-group.ts），pool 只管盯盘规则
 * - 触发（WatchTrigger）= 池 + 股票 + 规则 + 方向 + 理由 + 证据 + 行情快照
 * - 评估时机：每条 rule 独立判断，any-rule semantics（任意一条 fire 即触发）
 * - 落库：StockPool / WatchTrigger 都走各自 Repository，规则不变量在此断言
 */

// ---------- 枚举 ----------

/** 触发方向：买入 / 卖出 / 观察。 */
export type WatchDirection = 'buy' | 'sell' | 'watch';

export const WatchDirectionSchema = z.enum(['buy', 'sell', 'watch']);

/** 规则类型。 */
export type WatchRuleKind = 'tactic' | 'cost-threshold' | 'price-change';

export const WatchRuleKindSchema = z.enum(['tactic', 'cost-threshold', 'price-change']);

// ---------- WatchRule（discriminated union on `kind`） ----------

/** 战法命中：bullish→buy / bearish→sell / neutral→watch；score ≥ minScore 才触发。 */
export const TacticRuleSchema = z.object({
  kind: z.literal('tactic'),
  tacticId: z.string().min(1),
  /** 缺省 60，避免裸配置噪声；区间 [0, 100]。 */
  minScore: z.number().min(0).max(100).default(60),
});

/** 持仓成本阈值：现价 vs avgCost 触发止盈 / 止损；pct ∈ (0, 1]（5% → 0.05）。 */
export const CostThresholdRuleSchema = z
  .object({
    kind: z.literal('cost-threshold'),
    stopLossPct: z.number().positive().max(1).optional(),
    takeProfitPct: z.number().positive().max(1).optional(),
  })
  .refine((r) => r.stopLossPct !== undefined || r.takeProfitPct !== undefined, {
    message: 'cost-threshold 规则必须至少指定 stopLossPct 或 takeProfitPct',
  });

/** 日内涨跌幅：| (close − prevClose) / prevClose | ≥ pct；pct ∈ (0, 1]。 */
export const PriceChangeRuleSchema = z.object({
  kind: z.literal('price-change'),
  pct: z.number().positive().max(1),
});

export const WatchRuleSchema = z.discriminatedUnion('kind', [
  TacticRuleSchema,
  CostThresholdRuleSchema,
  PriceChangeRuleSchema,
]);

export type WatchRule = z.infer<typeof WatchRuleSchema>;
export type TacticRule = z.infer<typeof TacticRuleSchema>;
export type CostThresholdRule = z.infer<typeof CostThresholdRuleSchema>;
export type PriceChangeRule = z.infer<typeof PriceChangeRuleSchema>;

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
  /** 同 (poolId, stockId, ruleKind) 通知冷却分钟数；区间 [1, 1440]。 */
  cooldownMinutes: z.number().int().min(1).max(1440).default(30),
  enabled: z.boolean().default(true),
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
  direction: WatchDirectionSchema,
  reason: z.string().min(1).max(500),
  evidence: z.array(z.string().min(1)).min(1).max(16),
  /** 触发时的实时行情快照（review fix：触发持久化保留 quote 便于复盘）。 */
  quote: z.object({
    close: MoneySchema,
    ts: z.coerce.date(),
  }),
  /** 本次是否真的推送通知；false = 被 cooldown 抑制（仍落库，方便复盘）。 */
  notified: z.boolean(),
  createdAt: z.coerce.date(),
});

export type WatchTrigger = z.infer<typeof WatchTriggerSchema>;
// Money re-export for callers that want the branded type without touching branded.ts.
export type { Money };

// ---------- 不变量 ----------

/**
 * 池不变量（docs/intraday-watch-design.md §1 + stock-group-design.md §5）：
 * - id slug 合法（schema 已 regex，runtime 兜底长度）
 * - rules ≥ 1（schema 已 min(1)）
 * - updatedAt ≥ createdAt
 *
 * 【跨实体不变量 · 不在此断言】pool 引用的分组 resolver=formula 时，rules 中 tactic 规则的
 * tacticId 必须与 resolver.tacticId 一致（原「source=tactic 池」口径的分组化演化，
 * 避免「成员来自 A 战法 + 规则评估 B 战法」的混淆）。
 * entity 层拿不到 repo，无法把 groupId 解析成分组 → 该校验放 tool 层
 * （create_stock_pool / update_stock_pool，stock-group 阶段 B 落地）；
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
    throw new InvariantError('pool.updatedAt < pool.createdAt');
  }
};

/** 触发不变量：quote.close > 0；evidence 非空（schema 已约束，runtime 兜底）。 */
export const assertWatchTriggerInvariants = (t: WatchTrigger): void => {
  if (!(t.quote.close > 0)) {
    throw new InvariantError(`watch trigger quote.close 必须 > 0，实际 ${t.quote.close}`);
  }
  if (t.evidence.length === 0) {
    throw new InvariantError('watch trigger evidence 不能为空');
  }
};
