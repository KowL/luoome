import type { DecisionReviewContent, ToolContext } from '@luoome/core';
import { adviceOutcomeOriginOf } from './advice-outcome-origin.js';

/**
 * 写入前 content 的规范化：`tradeIds` 去重排序 + `adviceFeedback.origin` 按通道重盖。
 *
 * 必须是**唯一**实现。`requestHash` 在写入路径与回执路径各算一次（response-loss 后
 * reconcile 靠它认领已提交的修订），两处只要有一处漏做同一转换，hash 就必然漂移：
 * 回执认不出自己的写入，操作永远停在 `unknown`。把转换抽到这里，是为了让「写入的
 * content」与「核对用的 content」结构上不可能分叉。
 */
export const normalizeDecisionReviewWriteContent = (
  resolved: DecisionReviewContent,
  ctx: ToolContext,
): DecisionReviewContent => ({
  ...resolved,
  tradeIds: [...new Set(resolved.tradeIds)].sort(),
  adviceFeedback:
    resolved.adviceFeedback === null
      ? null
      : { ...resolved.adviceFeedback, origin: adviceOutcomeOriginOf(ctx) },
});
