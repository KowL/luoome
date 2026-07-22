import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { type Money, MoneySchema } from '../types/branded.js';

/**
 * 股票池 + 盯盘规则 + 触发（v0.6 起，docs/intraday-watch-design.md）。
 *
 * 设计要点：
 * - 池（StockPool）= 成员来源（PoolSource）+ 规则列表（WatchRule）+ 冷却 + enabled
 * - 触发（WatchTrigger）= 池 + 股票 + 规则 + 方向 + 理由 + 证据 + 行情快照
 * - 评估时机：每条 rule 独立判断，any-rule semantics（任意一条 fire 即触发）
 * - 落库：StockPool / WatchTrigger 都走各自 Repository，规则不变量在此断言
 */

// ---------- 枚举 ----------

/** 池成员来源类型。 */
export type PoolSourceKind = 'holdings' | 'manual' | 'tactic';

/** 触发方向：买入 / 卖出 / 观察。 */
export type WatchDirection = 'buy' | 'sell' | 'watch';

export const WatchDirectionSchema = z.enum(['buy', 'sell', 'watch']);

/** 规则类型。 */
export type WatchRuleKind = 'tactic' | 'cost-threshold' | 'price-change';

export const WatchRuleKindSchema = z.enum(['tactic', 'cost-threshold', 'price-change']);

// ---------- PoolSource（discriminated union on `kind`） ----------

/** 持仓池：显式绑定账户（review fix：消除"默认账户"歧义）。 */
export const HoldingsSourceSchema = z.object({
  kind: z.literal('holdings'),
  accountId: z.string().min(1),
});

/** 手动池：固定股票列表。 */
export const ManualSourceSchema = z.object({
  kind: z.literal('manual'),
  stockIds: z.array(z.string().min(1)).min(1),
});

/** 策略池：成员 = 该战法近 lookbackDays 天命中信号的 distinct stockId。
 *  依赖 tactic_signals 表有数据 → watch 启动时跑 seed 灌库（见 intraday-watch workflow）。 */
export const TacticPoolSourceSchema = z.object({
  kind: z.literal('tactic'),
  tacticId: z.string().min(1),
  lookbackDays: z.number().int().positive().max(365),
  minScore: z.number().min(0).max(100).optional(),
});

export const PoolSourceSchema = z.discriminatedUnion('kind', [
  HoldingsSourceSchema,
  ManualSourceSchema,
  TacticPoolSourceSchema,
]);

export type PoolSource = z.infer<typeof PoolSourceSchema>;
/**
 * pool.source.kind === 'tactic' 时的窄化类型。
 * PoolSource 的判别联合 + z.narrow 派生，避免重复定义。
 */
export type TacticPoolSource = Extract<PoolSource, { kind: 'tactic' }>;
export type HoldingsPoolSource = Extract<PoolSource, { kind: 'holdings' }>;
export type ManualPoolSource = Extract<PoolSource, { kind: 'manual' }>;

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
  source: PoolSourceSchema,
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
 * 池不变量（docs/intraday-watch-design.md §1）：
 * - id slug 合法（schema 已 regex，runtime 兜底长度）
 * - rules ≥ 1（schema 已 min(1)）
 * - source.kind='tactic' 的池，rules 中 tactic 规则的 tacticId 必须与 source.tacticId 一致
 *   （避免「成员来自 A 战法 + 规则评估 B 战法」的混淆）；其它 source 形态不做强制对齐
 * - source.kind='holdings' 的池，rules 中 cost-threshold 必须有 avgCost 才能评估 → 合法
 *   （schema 不强制 source.kind，因为 holdings 池也允许加 price-change / tactic 规则）
 * - updatedAt ≥ createdAt
 */
export const assertStockPoolInvariants = (pool: StockPool): void => {
  if (pool.id.length < 2 || pool.id.length > 64) {
    throw new InvariantError(`pool.id 长度 2-64，实际 ${pool.id.length}`);
  }
  if (pool.rules.length === 0) {
    throw new InvariantError('pool.rules 不能为空');
  }
  // source=tactic 池：rules 里若有 tactic 规则，tacticId 必须与 source.tacticId 一致
  if (pool.source.kind === 'tactic') {
    for (const rule of pool.rules) {
      if (rule.kind === 'tactic' && rule.tacticId !== pool.source.tacticId) {
        throw new InvariantError(
          `source=tactic 的池 (source.tacticId=${pool.source.tacticId}) ` +
            `的 rules 中 tactic 规则 tacticId=${rule.tacticId} 必须一致`,
        );
      }
    }
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
