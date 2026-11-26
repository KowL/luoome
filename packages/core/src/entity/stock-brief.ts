import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { AdviceDecisionSchema, AdviceHorizonSchema } from './advice.js';

/**
 * 每日个股观察记录（design.md §4.1）。
 *
 * stock_briefs 只保存「结论 + 事实指纹 + 降级原因 + LLM 计量」，证据正文仍由
 * advices / based_on 提供。唯一键 (accountId, tradingDate, stockId, phase) 即幂等键：
 * 同日同阶段重跑只覆盖该行，不新增第二行；结论变化时用 revisedFrom 保留上一行 id。
 */

export const STOCK_BRIEF_PHASES = ['premarket', 'intraday', 'post-market'] as const;
export const StockBriefPhaseSchema = z.enum(STOCK_BRIEF_PHASES);
export type StockBriefPhase = z.infer<typeof StockBriefPhaseSchema>;

export const STOCK_BRIEF_SOURCES = ['scheduled', 'manual', 'chat', 'cli', 'mcp'] as const;
export const StockBriefSourceSchema = z.enum(STOCK_BRIEF_SOURCES);
export type StockBriefSource = z.infer<typeof StockBriefSourceSchema>;

export const STOCK_BRIEF_QUALITIES = ['ai', 'rule-only', 'partial', 'unavailable'] as const;
export const StockBriefQualitySchema = z.enum(STOCK_BRIEF_QUALITIES);
export type StockBriefQuality = z.infer<typeof StockBriefQualitySchema>;

/** 降级维度与 §11 失败降级矩阵一一对应；任何降级都必须写明 dimension + reason。 */
export const STOCK_BRIEF_MISSING_DIMENSIONS = [
  'quote',
  'daily-bars',
  'intraday',
  'news',
  'sector-quote',
  'sector-membership',
  'signals',
  'discussions',
  'account',
  'llm',
  'plugin',
  'budget',
] as const;
export const StockBriefMissingDimensionSchema = z.enum(STOCK_BRIEF_MISSING_DIMENSIONS);
export type StockBriefMissingDimension = z.infer<typeof StockBriefMissingDimensionSchema>;

export const StockBriefMissingSchema = z.object({
  dimension: StockBriefMissingDimensionSchema,
  reason: z.string().trim().min(1),
  source: z.string().trim().min(1).optional(),
  dataAsOf: z.coerce.date().optional(),
});
export type StockBriefMissing = z.infer<typeof StockBriefMissingSchema>;

export const StockBriefSchema = z.object({
  id: z.string().min(1),
  /** Asia/Shanghai 交易日，格式 YYYY-MM-DD。 */
  tradingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  phase: StockBriefPhaseSchema,
  accountId: z.string().min(1),
  stockId: z.string().min(1),
  source: StockBriefSourceSchema,
  decision: AdviceDecisionSchema,
  confidence: z.number().min(0).max(100),
  horizon: AdviceHorizonSchema,
  /** rule-only / unavailable 时为空，不伪造 advice 关联。 */
  adviceId: z.string().min(1).optional(),
  quality: StockBriefQualitySchema,
  /** 事实包稳定指纹；同日 digest 未变即跳过 LLM。 */
  factDigest: z.string().min(1),
  factsAsOf: z.coerce.date(),
  missing: z.array(StockBriefMissingSchema),
  dataSources: z.array(z.string().min(1)),
  /** 同日重算时指向被覆盖行（或上一轮 advice 链）的 id。 */
  revisedFrom: z.string().min(1).optional(),
  /** 当日该票真实 LLM HTTP 请求次数。 */
  llmHttpCalls: z.number().int().nonnegative().default(0),
  llmPromptTokens: z.number().int().nonnegative().default(0),
  llmCompletionTokens: z.number().int().nonnegative().default(0),
  llmReasoningTokens: z.number().int().nonnegative().default(0),
  llmCostUsd: z.number().nonnegative().default(0),
  validUntil: z.coerce.date(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type StockBrief = z.infer<typeof StockBriefSchema>;

export const StockBriefUsageSchema = z.object({
  briefs: z.number().int().nonnegative(),
  httpCalls: z.number().int().nonnegative(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export type StockBriefUsage = z.infer<typeof StockBriefUsageSchema>;

const RULE_ONLY_DECISIONS = new Set(['hold', 'watch', 'avoid']);

/**
 * 不变量（design.md §4.2）：
 * 1. quality='ai' ⇒ adviceId 非空；
 * 2. quality='rule-only' ⇒ decision ∈ {hold,watch,avoid} 且 adviceId 为空；
 * 3. LLM 计量全部非负；
 * 4. 每条 missing 都带 dimension 与 reason。
 */
export const assertStockBriefInvariants = (brief: StockBrief): void => {
  if (brief.quality === 'ai' && brief.adviceId === undefined) {
    throw new InvariantError('ai stock brief requires adviceId');
  }
  if (brief.quality === 'rule-only') {
    if (!RULE_ONLY_DECISIONS.has(brief.decision)) {
      throw new InvariantError('rule-only stock brief decision must be hold, watch or avoid');
    }
    if (brief.adviceId !== undefined) {
      throw new InvariantError('rule-only stock brief must not reference an adviceId');
    }
  }
  for (const [field, value] of [
    ['llmHttpCalls', brief.llmHttpCalls],
    ['llmPromptTokens', brief.llmPromptTokens],
    ['llmCompletionTokens', brief.llmCompletionTokens],
    ['llmReasoningTokens', brief.llmReasoningTokens],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new InvariantError(`${field} must be a non-negative integer`);
    }
  }
  if (!Number.isFinite(brief.llmCostUsd) || brief.llmCostUsd < 0) {
    throw new InvariantError('llmCostUsd must be >= 0');
  }
  for (const item of brief.missing) {
    if (item.dimension.length === 0) {
      throw new InvariantError('missing entry requires dimension');
    }
    if (item.reason.trim().length === 0) {
      throw new InvariantError('missing entry requires reason');
    }
  }
};
