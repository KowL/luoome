import {
  AdviceDecisionSchema,
  type AdviceHorizon,
  AdviceHorizonSchema,
  AdviceReasoningSchema,
  adviceExpiryDays,
} from '@luoome/core';
import { z } from 'zod';

/**
 * analyze_stock / analyze_position 共用的 LLM 输出 schema
 * （ARCHITECTURE §6.3 schema-constrained decoding）。
 */
export const AdviceLLMSchema = z.object({
  decision: AdviceDecisionSchema,
  confidence: z.number().min(0).max(100),
  horizon: AdviceHorizonSchema,
  reasoning: AdviceReasoningSchema,
  risks: z.array(z.string()),
});

export type AdviceLLMOutput = z.infer<typeof AdviceLLMSchema>;

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

/**
 * core 的 LLMAdapterLike 投影不含 raw 字段（adapters 的 LLMGenerateResult 才有）；
 * 这里运行时提取：有则进 basedOn.llmReasoning 供审计，无则缺省。
 */
export const extractLlmRaw = (value: unknown): string | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = (value as { raw?: unknown }).raw;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
};
