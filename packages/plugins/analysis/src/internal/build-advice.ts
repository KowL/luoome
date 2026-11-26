import {
  AdviceDecisionSchema,
  type AdviceHorizon,
  AdviceHorizonSchema,
  AdviceReasoningSchema,
  adviceExpiryDays,
  type LLMGenerateRequest,
  PluginExecutionDenied,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

export {
  sanitizeAdviceReasoning,
  sanitizeAdviceRisks,
} from '@luoome/toolkit/internal/sanitize-advice.js';

/**
 * analyze_stock / analyze_position 共用的 LLM 输出 schema
 * （ARCHITECTURE §6.3 schema-constrained decoding）。
 */
export const AdviceLLMSchema = z.object({
  decision: AdviceDecisionSchema,
  confidence: z.number().min(0).max(100),
  horizon: AdviceHorizonSchema,
  /** 买点（buy 时建议给出；与 quote.close 同单位）；观望可缺省。 */
  entryPrice: z.number().positive().optional(),
  /** 新计划使用的入场价格下限；与 entryPriceHigh 一起形成区间。 */
  entryPriceLow: z.number().positive().optional(),
  /** 新计划使用的入场价格上限；与 entryPriceLow 一起形成区间。 */
  entryPriceHigh: z.number().positive().optional(),
  /** 按账户总资产计算的目标仓位百分比；缺省时只能形成条件草案。 */
  targetPositionPct: z.number().min(0).max(100).optional(),
  /** 卖点/目标价（buy 时建议给出）；观望可缺省。 */
  targetPrice: z.number().positive().optional(),
  /** 止损价（buy 时建议给出，须低于 entryPrice）；观望可缺省。 */
  stopLoss: z.number().positive().optional(),
  reasoning: AdviceReasoningSchema,
  risks: z.array(z.string()),
});

export type AdviceLLMOutput = z.infer<typeof AdviceLLMSchema>;

/**
 * 七要素的强制项：schema 只能力约束形状，这里约束「结论是否有用」。
 * 返回空数组表示本条判断可以入库。
 */
export type JudgmentLike = {
  decision: 'buy' | 'sell' | 'hold' | 'watch' | 'avoid';
  confidence: number;
  targetPositionPct?: number | undefined;
  entryPriceLow?: number | undefined;
  entryPriceHigh?: number | undefined;
  targetPrice?: number | undefined;
  stopLoss?: number | undefined;
};

export const judgmentViolations = (judgment: JudgmentLike): readonly string[] => {
  const violations: string[] = [];
  if (judgment.decision === 'watch') {
    const missing = [
      judgment.entryPriceLow === undefined ? 'entryPriceLow' : undefined,
      judgment.entryPriceHigh === undefined ? 'entryPriceHigh' : undefined,
      judgment.targetPositionPct === undefined ? 'targetPositionPct' : undefined,
    ].filter((field) => field !== undefined);
    if (missing.length > 0) {
      violations.push(`watch 必须给出入场区间与目标仓位，缺少 ${missing.join('/')}`);
    }
  }
  if (
    judgment.decision === 'buy' &&
    (judgment.stopLoss === undefined || judgment.targetPrice === undefined)
  ) {
    violations.push('buy 必须给出 stopLoss 与 targetPrice');
  }
  const confidenceCap = judgment.confidence < 50 ? 10 : judgment.confidence < 70 ? 20 : 30;
  if (judgment.targetPositionPct !== undefined && judgment.targetPositionPct > confidenceCap) {
    violations.push(
      `confidence=${judgment.confidence} 时 targetPositionPct 不得超过 ${confidenceCap}`,
    );
  }
  return violations;
};

/** 讨论摘录的典型用词；用于判断 buy/sell 是否有非论坛证据。 */
const FORUM_EVIDENCE_PATTERN = /股吧|论坛|讨论|人气榜|人气排名|发帖|帖子|吧友|看多看空/;

export interface ForumEvidenceGuardInput {
  readonly decision: 'buy' | 'sell' | 'hold' | 'watch' | 'avoid';
  readonly evidence: readonly string[];
  readonly discussionsAvailable: boolean;
  /** 当日可用的非论坛事实维度（quote / indicators / news / sectors / ...）。 */
  readonly nonForumSections: readonly string[];
}

/**
 * 论坛证据边界（硬约束）：股吧讨论只能补充，不能单独支撑 buy/sell。
 * - buy/sell 至少要有 1 条不引用论坛的证据；
 * - 当日除讨论外没有任何非论坛事实时，buy/sell 一律无效（只能 watch/avoid）。
 */
export const forumOnlyEvidenceViolations = (input: ForumEvidenceGuardInput): readonly string[] => {
  if (input.decision !== 'buy' && input.decision !== 'sell') return [];
  if (!input.discussionsAvailable) return [];
  const violations: string[] = [];
  if (input.nonForumSections.length === 0) {
    violations.push('当日除股吧讨论外没有可用的非论坛事实，buy/sell 只能降级为 watch/avoid');
    return violations;
  }
  const nonForumEvidence = input.evidence.filter((line) => !FORUM_EVIDENCE_PATTERN.test(line));
  if (nonForumEvidence.length === 0) {
    violations.push(
      'buy/sell 不能只引用股吧讨论作证据：至少一条证据必须来自行情/指标/板块/新闻/策略等非论坛事实',
    );
  }
  return violations;
};

export const assertAdviceAnalysis = (ctx: ToolContext): void => {
  ctx.executionGuard?.();
  if (ctx.executionPolicy === undefined)
    throw new PluginExecutionDenied('plugin:business.analysis');
  ctx.executionPolicy.assertTool('analyze_stock');
};

export const generateAdviceAnalysis = async <T>(
  ctx: ToolContext,
  request: LLMGenerateRequest,
): Promise<T> => {
  assertAdviceAnalysis(ctx);
  let generated: T;
  try {
    generated = await ctx.adapters.llm.generate<T>(request);
  } catch (error) {
    assertAdviceAnalysis(ctx);
    throw error;
  }
  assertAdviceAnalysis(ctx);
  return generated;
};

const DAY_MS = 86_400_000;
/** A 股收盘 15:00 用固定 UTC+8 计算（不依赖宿主机时区，保证测试确定性）。 */
const CN_MARKET_OFFSET_MS = 8 * 3_600_000;

/**
 * 计算 validUntil（ARCHITECTURE §6.5）：
 * - intraday → 当日 15:00（UTC+8）；若当前已过收盘，顺延到下一自然日 15:00，
 *   保证 validUntil > validFrom（advice 不变量第 4 条）；
 * - 其余 horizon → now + adviceExpiryDays[horizon] 个自然日
 *   （v0.1 以自然日近似交易日，与 adapters fixtures 口径一致）。
 */
export const computeValidUntil = (horizon: AdviceHorizon, now: Date): Date => {
  if (horizon !== 'intraday') {
    return new Date(now.getTime() + adviceExpiryDays[horizon] * DAY_MS);
  }
  const cstNow = new Date(now.getTime() + CN_MARKET_OFFSET_MS);
  let cutoffMs =
    Date.UTC(cstNow.getUTCFullYear(), cstNow.getUTCMonth(), cstNow.getUTCDate(), 15, 0, 0, 0) -
    CN_MARKET_OFFSET_MS;
  if (cutoffMs <= now.getTime()) cutoffMs += DAY_MS;
  return new Date(cutoffMs);
};
