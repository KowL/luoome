import type { StockBriefUsage, ToolContext } from '@luoome/core';

import {
  DEFAULT_DAILY_BRIEF_LIMIT,
  DEFAULT_DAILY_LLM_HTTP_LIMIT,
  DEFAULT_DAILY_LLM_TOKEN_LIMIT,
} from './brief-rules.js';

/**
 * 每日 LLM 预算守卫（design.md §10.3 / §10.4）。
 *
 * 预算走双轨：HTTP 次数（防调用放大）+ token（防 reasoning 失控）。
 * 计量来源是 `stock_briefs.llm_*`（`sumUsage(tradingDate)`），因此跨入口
 * （workflow / tool / CLI）共享同一份当日用量；金额只作参考展示。
 */

export interface LlmUsageTotals {
  readonly httpCalls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly reasoningTokens: number;
  readonly costUsd: number;
}

export const emptyLlmUsage = (): LlmUsageTotals => ({
  httpCalls: 0,
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
});

const finiteOrZero = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * 从适配器返回值里取结构化 usage（`LLMGenerateResult.usage`）。
 * 适配器尚未上报 usage 时返回全 0，不阻断计数；HTTP 次数由调用方自行累加。
 */
export const llmUsageFromResult = (result: unknown): Omit<LlmUsageTotals, 'httpCalls'> => {
  if (result === null || typeof result !== 'object') {
    return { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, costUsd: 0 };
  }
  const usage = (result as { usage?: unknown }).usage;
  if (usage === null || typeof usage !== 'object') {
    return { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, costUsd: 0 };
  }
  const record = usage as Record<string, unknown>;
  return {
    promptTokens: finiteOrZero(record.promptTokens),
    completionTokens: finiteOrZero(record.completionTokens),
    reasoningTokens: finiteOrZero(record.reasoningTokens),
    costUsd: finiteOrZero(record.costUsd),
  };
};

export const addLlmUsage = (
  total: LlmUsageTotals,
  delta: Partial<LlmUsageTotals>,
): LlmUsageTotals => ({
  httpCalls: total.httpCalls + finiteOrZero(delta.httpCalls),
  promptTokens: total.promptTokens + finiteOrZero(delta.promptTokens),
  completionTokens: total.completionTokens + finiteOrZero(delta.completionTokens),
  reasoningTokens: total.reasoningTokens + finiteOrZero(delta.reasoningTokens),
  costUsd: total.costUsd + finiteOrZero(delta.costUsd),
});

export interface BriefBudgetLimits {
  /** 单批最多进入 LLM 的票数。 */
  readonly maxBriefs: number;
  /** 当日最多 LLM HTTP 请求次数（每票最多 2 次）。 */
  readonly maxHttpCalls: number;
  /** 当日最多 token 数（prompt + completion + reasoning）。 */
  readonly maxTokens: number;
}

export const DEFAULT_BRIEF_BUDGET_LIMITS: BriefBudgetLimits = {
  maxBriefs: DEFAULT_DAILY_BRIEF_LIMIT,
  maxHttpCalls: DEFAULT_DAILY_LLM_HTTP_LIMIT,
  maxTokens: DEFAULT_DAILY_LLM_TOKEN_LIMIT,
};

export interface BriefBudgetSnapshot {
  readonly date: string;
  /** 当日已有 brief 行数（含规则观察，仅作展示）。 */
  readonly briefs: number;
  readonly httpCalls: number;
  readonly tokens: number;
  readonly costUsd: number;
  readonly limit: BriefBudgetLimits;
}

export const readBriefBudget = async (
  ctx: ToolContext,
  tradingDate: string,
  limits: BriefBudgetLimits = DEFAULT_BRIEF_BUDGET_LIMITS,
): Promise<BriefBudgetSnapshot> => {
  const usage: StockBriefUsage = await ctx.repos.stockBrief.sumUsage(tradingDate);
  return {
    date: tradingDate,
    briefs: usage.briefs,
    httpCalls: usage.httpCalls,
    tokens: usage.promptTokens + usage.completionTokens + usage.reasoningTokens,
    costUsd: usage.costUsd,
    limit: limits,
  };
};

export interface BriefBudgetDecision {
  readonly exhausted: boolean;
  readonly reason?: string;
}

/**
 * 单票 token 预估（design.md §10.4：1 840 prompt + 3 292 completion）。
 * 预算按「将触达」语义提前预留，避免并发下超限。
 */
export const DEFAULT_TICKET_TOKEN_ESTIMATE = 1_840 + 3_292;

/**
 * 单票调用前的预算判定：任一硬限将触达即停止后续 LLM（已生成的 brief 保留）。
 * `plannedBriefs` 是「本批次已进入 LLM 的票数 + 1」。
 */
export const checkBriefBudget = (input: {
  readonly snapshot: BriefBudgetSnapshot;
  readonly plannedBriefs: number;
  readonly plannedHttpCalls?: number;
  readonly plannedTokens?: number;
}): BriefBudgetDecision => {
  const { snapshot } = input;
  const plannedHttpCalls = input.plannedHttpCalls ?? 1;
  const plannedTokens = input.plannedTokens ?? DEFAULT_TICKET_TOKEN_ESTIMATE;
  if (input.plannedBriefs > snapshot.limit.maxBriefs) {
    return {
      exhausted: true,
      reason: `今日 AI 分析票数已达上限 ${snapshot.limit.maxBriefs}，剩余标的按规则观察`,
    };
  }
  if (snapshot.httpCalls + plannedHttpCalls > snapshot.limit.maxHttpCalls) {
    return {
      exhausted: true,
      reason: `今日 LLM 请求次数将超过上限 ${snapshot.limit.maxHttpCalls}（已用 ${snapshot.httpCalls}），剩余标的按规则观察`,
    };
  }
  if (snapshot.tokens + plannedTokens > snapshot.limit.maxTokens) {
    return {
      exhausted: true,
      reason: `今日 LLM token 将超过上限 ${snapshot.limit.maxTokens}（已用 ${snapshot.tokens}），剩余标的按规则观察`,
    };
  }
  return { exhausted: false };
};
