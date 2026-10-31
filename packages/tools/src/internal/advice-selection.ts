import type { Advice, AdviceQuery, ToolContext } from '@luoome/core';

import { accountAdviceOutcomes, attachAccountAdviceOutcomes } from './account-advice-outcomes.js';

export interface AdviceSelectionOptions {
  readonly includeExpired: boolean;
  readonly limit: number;
}

/**
 * 建议选择的**唯一实现**：`get_advice` 与 `list_advices` 共用。
 *
 * 语义（与 `get_advice` 的既有行为逐条对齐）：
 * - 过期判定用注入时钟 `ctx.clock()`，不用 repository 的真实时钟分支；
 * - **先过滤过期、后 limit 截断**（既有语义，顺序不能反）；
 * - outcome 一律来自 `accountAdviceOutcomes` + `attachAccountAdviceOutcomes`（M3-10 的 origin 口径）。
 */
export const selectAdvices = async (
  ctx: ToolContext,
  accountId: string,
  filter: AdviceQuery,
  options: AdviceSelectionOptions,
): Promise<Advice[]> => {
  const now = ctx.clock();
  const raw = await ctx.repos.advice.query({ ...filter, includeExpired: true });
  const outcomes = await accountAdviceOutcomes(ctx, accountId);
  return attachAccountAdviceOutcomes(raw, outcomes)
    .filter((advice) => options.includeExpired || advice.validUntil.getTime() > now.getTime())
    .slice(0, options.limit);
};
