import type { Advice, Trade } from '@luoome/core';

/**
 * Trade ↔ Advice 的**双链并认**（唯一实现，task-16）。
 *
 * 两个独立关联路径：
 * - **A `Trade.adviceId`**（单值，`add_trade` 写入）
 * - **B `DecisionReview.content.tradeIds`**（多值，`record_advice_outcome` / `save_decision_review` 写入）
 *
 * 三条不变量：
 * 1. **双链并认**：只认一条会让「显式关联过 Advice 的成交」在另一处变成未归因；
 * 2. **同一成交只记一个 owner**（去重）：两条链都指向同一 advice 时不重复计入，
 *    两条链指向不同 advice 时按确定性规则选唯一 owner（`review.tradeIds` 优先，同级按 adviceId 字典序）；
 * 3. **指向不存在/他账户成交的链接进 `unknowns`**，不静默丢弃。
 *
 * `get_advice_attribution` 与 `get_decision_loop_review` 共用本模块——两个工具对同一批成交
 * 必须给出**同一个**「已归因成交数」。
 */
export interface LinkCandidate {
  readonly trade: Trade;
  readonly relation: 'decision-review.tradeIds' | 'trade.adviceId';
}

/** 双链并认 + 去重；返回按 advice 分组的链接、共享成交与投不进去的 unknown 链接。 */
export const linkTrades = (
  advices: readonly Advice[],
  trades: readonly Trade[],
  reviewTradeIds: ReadonlyMap<string, readonly string[]>,
): {
  readonly byAdvice: ReadonlyMap<string, LinkCandidate[]>;
  readonly shared: ReadonlyMap<string, readonly string[]>;
  readonly unknowns: string[];
} => {
  const adviceIds = new Set(advices.map((advice) => advice.id));
  const tradeById = new Map(trades.map((trade) => [trade.id, trade]));
  const candidates = new Map<string, LinkCandidate[]>();
  const sharedByTrade = new Map<string, string[]>();
  const unknowns: string[] = [];

  const push = (adviceId: string, candidate: LinkCandidate): void => {
    const list = candidates.get(adviceId) ?? [];
    list.push(candidate);
    candidates.set(adviceId, list);
    const claimed = sharedByTrade.get(candidate.trade.id) ?? [];
    if (!claimed.includes(adviceId)) claimed.push(adviceId);
    sharedByTrade.set(candidate.trade.id, claimed);
  };

  // 路径 A：Trade.adviceId（单值）。
  for (const trade of trades) {
    if (trade.adviceId === undefined || !adviceIds.has(trade.adviceId)) continue;
    push(trade.adviceId, { trade, relation: 'trade.adviceId' });
  }
  // 路径 B：DecisionReview.content.tradeIds（多值）。
  for (const [adviceId, tradeIds] of reviewTradeIds) {
    if (!adviceIds.has(adviceId)) continue;
    for (const tradeId of tradeIds) {
      const trade = tradeById.get(tradeId);
      // 链接指向不存在 / 他账户的成交：进 unknowns，不静默丢弃（先例 get_strategy_decision_cycles）。
      if (trade === undefined) {
        unknowns.push(`建议 ${adviceId} 关联的成交 ${tradeId} 不在本账户账本内，已跳过`);
        continue;
      }
      push(adviceId, { trade, relation: 'decision-review.tradeIds' });
    }
  }

  // 唯一 owner：relation 优先级 review.tradeIds > trade.adviceId，同级按 adviceId 字典序。
  const ownerOf = new Map<string, string>();
  for (const [adviceId, list] of candidates)
    for (const candidate of list) {
      const current = ownerOf.get(candidate.trade.id);
      if (current === undefined) {
        ownerOf.set(candidate.trade.id, adviceId);
        continue;
      }
      const better = (a: string, b: string): boolean => a.localeCompare(b) < 0;
      const currentRank = candidates
        .get(current)
        ?.find((item) => item.trade.id === candidate.trade.id)?.relation;
      if (candidate.relation === 'decision-review.tradeIds' && currentRank === 'trade.adviceId') {
        ownerOf.set(candidate.trade.id, adviceId);
        continue;
      }
      if (candidate.relation === currentRank && better(adviceId, current))
        ownerOf.set(candidate.trade.id, adviceId);
    }

  const owned = new Map<string, LinkCandidate[]>();
  for (const [adviceId, list] of candidates) {
    // 同一 advice 内也按成交去重（两条链指向同一 advice 时，成交只记一次）；
    // owner 优先级：review.tradeIds > trade.adviceId，同级保持先到。
    const byTrade = new Map<string, LinkCandidate>();
    for (const candidate of list) {
      if (ownerOf.get(candidate.trade.id) !== adviceId) continue;
      const existing = byTrade.get(candidate.trade.id);
      if (existing === undefined || candidate.relation === 'decision-review.tradeIds')
        byTrade.set(candidate.trade.id, candidate);
    }
    if (byTrade.size > 0) owned.set(adviceId, [...byTrade.values()]);
  }
  return { byAdvice: owned, shared: sharedByTrade, unknowns };
};
