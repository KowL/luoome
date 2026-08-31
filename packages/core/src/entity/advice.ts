import { z } from 'zod';

import { type Money, MoneySchema } from '../types/branded.js';
import { type TechnicalIndicators, TechnicalIndicatorsSchema } from './indicator-set.js';
import { type Quote, QuoteSchema } from './quote.js';
import { ActiveSignalObservationHorizonSchema } from './signal-observation.js';

// ---------- 枚举类型（ARCHITECTURE §5.2） ----------

export type AdviceDecision = 'buy' | 'sell' | 'hold' | 'watch' | 'avoid';
export type AdviceSubjectKind = 'stock' | 'portfolio' | 'market' | 'sector' | 'position';
export type AdviceHorizon = 'intraday' | 'short' | 'medium' | 'long';

export const AdviceDecisionSchema = z.enum(['buy', 'sell', 'hold', 'watch', 'avoid']);
export const AdviceSubjectKindSchema = z.enum([
  'stock',
  'portfolio',
  'market',
  'sector',
  'position',
]);
export const AdviceHorizonSchema = z.enum(['intraday', 'short', 'medium', 'long']);
export const ActiveStrategyRecommendationTriggerSchema = z.union([
  z.literal('run'),
  ActiveSignalObservationHorizonSchema,
]);
export type ActiveStrategyRecommendationTrigger = z.infer<
  typeof ActiveStrategyRecommendationTriggerSchema
>;
/** `t20` 只为读取已经生成的 Advice 证据保留。 */
export const StrategyRecommendationTriggerSchema = z.union([
  ActiveStrategyRecommendationTriggerSchema,
  z.literal('t20'),
]);
export type StrategyRecommendationTrigger = z.infer<typeof StrategyRecommendationTriggerSchema>;

/**
 * Advice 有效期映射（ARCHITECTURE §6.5），单位：交易日。
 * intraday 为 0：由调用方结合 clock 截断到当日 15:00 收盘。
 */
export const adviceExpiryDays: Record<AdviceHorizon, number> = {
  intraday: 0, // 当日 15:00
  short: 3, // +3 个交易日
  medium: 20, // +20 个交易日
  long: 60, // +60 个交易日
};

// ---------- 免责声明（docs/archive/MVP-TASK.md §2.3，恰好 3 条，硬约束） ----------

export const STANDARD_DISCLAIMERS = [
  '本建议由 AI 生成，基于历史数据与技术指标，不构成投资建议。',
  '投资有风险，决策需自行承担。',
  '市场有不可预测性，过往表现不代表未来收益。',
] as const;

// ---------- Advice 结构（ARCHITECTURE §5.2） ----------

export interface AdviceReasoning {
  readonly premise: string; // 核心论点（一句话）
  readonly evidence: readonly string[]; // 支持证据（数据点引用）
  readonly counterEvidence: readonly string[]; // 反证
}

/** 数据快照：advice 产出瞬间引用的数据，事后可复盘。 */
export interface AdviceDataSnapshot {
  readonly quotes?: Record<string, Quote>;
  readonly indicators?: Record<string, TechnicalIndicators>;
  readonly llmReasoning?: string; // 经过 sanitized 的 LLM 推理文本（用于审计与复盘）
  readonly ladder?: AdviceLadderSnapshot;
  readonly strategy?: StrategyAdviceEvidence;
  readonly dataAsOf: Date; // 数据截止时间
}

export interface StrategyAdviceEvidence {
  readonly strategyId: string;
  readonly strategyVersionId: string;
  readonly runId: string;
  readonly stockId: string;
  /** V2 account provenance; absent on legacy Advice and therefore not trusted for V2 cooldown. */
  readonly accountId?: string;
  readonly score?: number;
  readonly rank?: number;
  readonly resultEvidence: readonly string[];
  readonly signalIds: readonly string[];
  readonly observationIds: readonly string[];
  readonly recommendationTrigger: StrategyRecommendationTrigger;
}

/** 市场观点引用的天梯摘要，避免把完整快照复制进 Advice JSON。 */
export interface AdviceLadderSnapshot {
  readonly date: string;
  readonly total: number;
  readonly maxLevel: number;
  readonly source: string;
  readonly levels: readonly { readonly level: number; readonly count: number }[];
  readonly warnings: readonly string[];
}

export const AdviceLadderSnapshotSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  total: z.number().int().nonnegative(),
  maxLevel: z.number().int().nonnegative(),
  source: z.string().min(1),
  levels: z.array(
    z.object({ level: z.number().int().positive(), count: z.number().int().nonnegative() }),
  ),
  warnings: z.array(z.string()),
});

export interface Advice {
  readonly id: string;
  readonly subjectKind: AdviceSubjectKind;
  readonly subjectId: string; // stockId / accountId / sectorName ...
  /** 标的名称（如股票名称），生成时快照保存，避免历史建议回显时依赖外部查询。 */
  readonly stockName?: string;
  readonly decision: AdviceDecision;
  readonly confidence: number; // 0-100
  readonly horizon: AdviceHorizon;
  readonly reasoning: AdviceReasoning;
  readonly risks: readonly string[];
  readonly disclaimers: readonly string[]; // 必填，至少包含 STANDARD_DISCLAIMERS
  readonly sourceTool?: string; // 哪个 tool 产出
  readonly sourceWorkflow?: string; // 哪个 workflow 产出
  readonly basedOn: AdviceDataSnapshot;
  readonly validFrom: Date;
  readonly validUntil: Date; // 过期时间（不再被采纳）
  readonly createdAt: Date;
  /** v0.3 起：可选的回填结果（事后复盘）；不存在 = 待回填。 */
  readonly outcome?: AdviceOutcome;
}

/** 建议结果回填（事后验证，ARCHITECTURE §5.2）。 */
export interface AdviceOutcome {
  readonly adviceId: string;
  /** 实际执行关联的交易记录；空数组表示未关联具体成交。 */
  readonly tradeIds: readonly string[];
  readonly outcome: 'followed' | 'partially_followed' | 'ignored';
  readonly pnl?: Money; // 实际盈亏
  readonly benchmarkPnl?: Money; // 同期基准盈亏
  /** 跟单持仓时长（小时）。 */
  readonly holdingHours?: number;
  /** 用户填写的复盘笔记。 */
  readonly notes?: string;
  readonly recordedAt: Date;
}

/** 建议统计（ARCHITECTURE §6.4）。 */
export interface AdviceStats {
  readonly totalAdvices: number;
  readonly avgConfidence: number;
  readonly outcomeRate: {
    readonly followed: number;
    readonly partiallyFollowed: number;
    readonly ignored: number;
  };
  readonly pnlWhenFollowed: Money;
  readonly pnlWhenIgnored: Money;
  readonly hitRate: number; // confidence >= 70 且 followed 且 pnl > 0 的比例
  readonly byDecision: Record<AdviceDecision, AdviceStats>;
}

/** AdviceRepository.query 的过滤条件。 */
export interface AdviceQuery {
  readonly subjectKind?: AdviceSubjectKind;
  readonly subjectId?: string;
  readonly decision?: AdviceDecision;
  readonly sourceTool?: string;
  readonly since?: Date;
  readonly until?: Date;
  /** 默认 false：过期 advice 不主动返回（ARCHITECTURE §6.5）。 */
  readonly includeExpired?: boolean;
  readonly limit?: number;
}

/** AdviceOutcome 的查询条件；subject 条件通过关联 Advice 过滤。 */
export interface AdviceOutcomeQuery {
  readonly adviceId?: string;
  readonly subjectKind?: AdviceSubjectKind;
  readonly subjectId?: string;
  /** 按 outcome.recordedAt 过滤（闭区间）。 */
  readonly since?: Date;
  readonly until?: Date;
  readonly limit?: number;
}

// ---------- Zod schema ----------

export const AdviceReasoningSchema = z.object({
  premise: z.string().min(1),
  evidence: z.array(z.string()),
  counterEvidence: z.array(z.string()),
});

// 存量 basedOn JSON 可能仍含已下线的 tacticSignals key；zod object 默认 strip，
// 读出时静默忽略，不需要保留旧 schema。

export const AdviceDataSnapshotSchema = z.object({
  quotes: z.record(z.string(), QuoteSchema).optional(),
  indicators: z.record(z.string(), TechnicalIndicatorsSchema).optional(),
  llmReasoning: z.string().optional(),
  ladder: AdviceLadderSnapshotSchema.optional(),
  strategy: z
    .object({
      strategyId: z.string().min(1),
      strategyVersionId: z.string().min(1),
      runId: z.string().min(1),
      stockId: z.string().min(1),
      accountId: z.string().min(1).optional(),
      score: z.number().min(0).max(100).optional(),
      rank: z.number().int().positive().optional(),
      resultEvidence: z.array(z.string()),
      signalIds: z.array(z.string()),
      observationIds: z.array(z.string()),
      recommendationTrigger: StrategyRecommendationTriggerSchema,
    })
    .optional(),
  dataAsOf: z.coerce.date(),
});

export const AdviceOutcomeSchema = z.object({
  adviceId: z.string().min(1),
  tradeIds: z.array(z.string().min(1)).default([]),
  outcome: z.enum(['followed', 'partially_followed', 'ignored']),
  pnl: MoneySchema.optional(),
  benchmarkPnl: MoneySchema.optional(),
  holdingHours: z.number().nonnegative().optional(),
  notes: z.string().max(2000).optional(),
  recordedAt: z.coerce.date(),
});

export const AdviceSchema = z.object({
  id: z.string().min(1),
  subjectKind: AdviceSubjectKindSchema,
  subjectId: z.string().min(1),
  stockName: z.string().optional(),
  decision: AdviceDecisionSchema,
  confidence: z.number().min(0).max(100),
  horizon: AdviceHorizonSchema,
  reasoning: AdviceReasoningSchema,
  risks: z.array(z.string()),
  disclaimers: z.array(z.string()).min(1),
  sourceTool: z.string().optional(),
  sourceWorkflow: z.string().optional(),
  basedOn: AdviceDataSnapshotSchema,
  validFrom: z.coerce.date(),
  validUntil: z.coerce.date(),
  createdAt: z.coerce.date(),
  outcome: AdviceOutcomeSchema.optional(),
});

export const AdviceQuerySchema = z.object({
  subjectKind: AdviceSubjectKindSchema.optional(),
  subjectId: z.string().optional(),
  decision: AdviceDecisionSchema.optional(),
  sourceTool: z.string().optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  includeExpired: z.boolean().optional(),
  limit: z.number().int().positive().optional(),
});
