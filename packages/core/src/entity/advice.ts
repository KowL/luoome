import { z } from 'zod';

import { type Money, MoneySchema } from '../types/branded.js';
import { type TechnicalIndicators, TechnicalIndicatorsSchema } from './indicator-set.js';
import { type Quote, QuoteSchema } from './quote.js';

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

// ---------- 免责声明（MVP-TASK §2.3，恰好 3 条，硬约束） ----------

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

export type TacticSignalDirection = 'bullish' | 'bearish' | 'neutral';

/** 战法信号（ARCHITECTURE §5.1：战法、标的、ts、分数、方向、证据）。 */
export interface TacticSignal {
  readonly tacticId: string;
  readonly tacticName?: string;
  readonly stockId: string;
  readonly ts: Date;
  readonly score: number; // 0-100
  readonly direction: TacticSignalDirection;
  readonly evidence: readonly string[];
}

/** 数据快照：advice 产出瞬间引用的数据，事后可复盘。 */
export interface AdviceDataSnapshot {
  readonly quotes?: Record<string, Quote>;
  readonly indicators?: Record<string, TechnicalIndicators>;
  readonly tacticSignals?: readonly TacticSignal[];
  readonly llmReasoning?: string; // LLM 原始推理（用于审计）
  readonly dataAsOf: Date; // 数据截止时间
}

export interface Advice {
  readonly id: string;
  readonly subjectKind: AdviceSubjectKind;
  readonly subjectId: string; // stockId / accountId / sectorName ...
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
}

/** 建议结果回填（事后验证，ARCHITECTURE §5.2）。 */
export interface AdviceOutcome {
  readonly adviceId: string;
  readonly outcome: 'followed' | 'partially_followed' | 'ignored';
  readonly pnl?: Money; // 实际盈亏
  readonly benchmarkPnl?: Money; // 同期基准盈亏
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

// ---------- Zod schema ----------

export const AdviceReasoningSchema = z.object({
  premise: z.string().min(1),
  evidence: z.array(z.string()),
  counterEvidence: z.array(z.string()),
});

export const TacticSignalDirectionSchema = z.enum(['bullish', 'bearish', 'neutral']);

export const TacticSignalSchema = z.object({
  tacticId: z.string().min(1),
  tacticName: z.string().optional(),
  stockId: z.string().min(1),
  ts: z.coerce.date(),
  score: z.number().min(0).max(100),
  direction: TacticSignalDirectionSchema,
  evidence: z.array(z.string()),
});

export const AdviceDataSnapshotSchema = z.object({
  quotes: z.record(z.string(), QuoteSchema).optional(),
  indicators: z.record(z.string(), TechnicalIndicatorsSchema).optional(),
  tacticSignals: z.array(TacticSignalSchema).optional(),
  llmReasoning: z.string().optional(),
  dataAsOf: z.coerce.date(),
});

export const AdviceSchema = z.object({
  id: z.string().min(1),
  subjectKind: AdviceSubjectKindSchema,
  subjectId: z.string().min(1),
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
});

export const AdviceOutcomeSchema = z.object({
  adviceId: z.string().min(1),
  outcome: z.enum(['followed', 'partially_followed', 'ignored']),
  pnl: MoneySchema.optional(),
  benchmarkPnl: MoneySchema.optional(),
  recordedAt: z.coerce.date(),
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
