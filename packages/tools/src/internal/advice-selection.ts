import type { Advice, AdviceQuery, ToolContext } from '@luoome/core';

import {
  accountAdviceOutcomes,
  accountAdviceReviewIds,
  adviceAttribution,
  attachAccountAdviceOutcomes,
  otherAccountAdviceReviewIds,
} from './account-advice-outcomes.js';

export interface AdviceSelectionOptions {
  readonly includeExpired: boolean;
  readonly limit: number;
}

export interface AdviceSelectionResult {
  readonly advices: Advice[];
  /**
   * 过期过滤之后、账户过滤之前，**既不属于本账户、也无法归属到任何账户**的建议条数。
   *
   * 它回答的是「有多少存量建议因为没有任何账户认领而没进这次列表」——缺数据要说清楚，
   * 不许静默丢弃。属于**别的账户**的建议不计入（那是正常的账户过滤，不是缺口）。
   */
  readonly unattributedCount: number;
}

/**
 * 建议选择的**唯一实现**：`get_advice` 与 `list_advices` 共用（含账户归属）。
 *
 * 语义：
 * - 过期判定用注入时钟 `ctx.clock()`，不用 repository 的真实时钟分支；
 * - outcome 一律来自 `accountAdviceOutcomes` + `attachAccountAdviceOutcomes`（M3-10 的 origin 口径）；
 * - **账户归属过滤也在这一层**（`adviceAttribution`），两个工具不再各写一套；
 * - 顺序是「账户过滤 → 过期过滤 → limit 截断」：先截断再过滤会让「前 N 条都不属于本账户」
 *   把结果误压成空，而实际有足够多条属于本账户的建议。
 */
export const selectAdvices = async (
  ctx: ToolContext,
  accountId: string,
  filter: AdviceQuery,
  options: AdviceSelectionOptions,
): Promise<AdviceSelectionResult> => {
  const now = ctx.clock();
  const raw = await ctx.repos.advice.query({ ...filter, includeExpired: true });
  const outcomes = await accountAdviceOutcomes(ctx, accountId);
  const fresh = attachAccountAdviceOutcomes(raw, outcomes).filter(
    (advice) => options.includeExpired || advice.validUntil.getTime() > now.getTime(),
  );
  const accountReviewIds = await accountAdviceReviewIds(ctx, accountId);
  const classified = await Promise.all(
    fresh.map((advice) => adviceAttribution(ctx, accountId, advice, accountReviewIds)),
  );
  // 直接判「谁都不认」的（market/sector 等没有归属信号的 subjectKind）。
  const unscopedIds = new Set<string>(
    fresh.filter((_, index) => classified[index] === 'unscoped').map((advice) => advice.id),
  );
  // 「归属待定」的 stock 建议：可能被**其它账户**的复盘记录认领，才需要枚举其它账户。
  // 常见路径零额外查询。
  const undetermined = fresh.filter((_, index) => classified[index] === 'undetermined');
  if (undetermined.length > 0) {
    const claimedElsewhere = await otherAccountAdviceReviewIds(ctx, accountId);
    for (const advice of undetermined) {
      if (!claimedElsewhere.has(advice.id)) unscopedIds.add(advice.id);
    }
  }
  return {
    advices: fresh
      .filter((_, index) => classified[index] === 'this-account')
      .slice(0, options.limit),
    unattributedCount: unscopedIds.size,
  };
};
