import { z } from 'zod';

/**
 * 建议的**历史标识**（REQ-M5-03 第 1 项）。
 *
 * ## 为什么是三态而不是 `isHistorical: boolean`
 *
 * 布尔分不清两种「不属于当前」：
 * - **`expired`**：`validUntil` 已过——**该忽略**，它对外已失效
 * - **`historical`**：跨日但仍未过期——**可参考，但不得当作今日事实**
 *
 * 这两者的处置完全不同：前者不该被引用，后者可以引用但**必须带上「它不是今天的」这个前提**。
 * 与 M4-05 的 `unavailable` / `partial` 同一条思路：
 * 「不能用了」和「能用但要知道它有前提」是两回事。
 */
export const AdviceHistoryStatusSchema = z.enum(['current', 'historical', 'expired']);
export type AdviceHistoryStatus = z.infer<typeof AdviceHistoryStatusSchema>;

/** 为什么它不是 `current`。**为 `null` 当且仅当状态是 `current`。** */
export const AdviceStaleReasonSchema = z.enum([
  /** `validUntil` 已过。 */
  'valid-until-passed',
  /** 依据的 `dataAsOf` 早于今天——跨日引用。 */
  'data-as-of-before-today',
]);
export type AdviceStaleReason = z.infer<typeof AdviceStaleReasonSchema>;

export interface AdviceHistoryMark {
  readonly historyStatus: AdviceHistoryStatus;
  readonly staleReason: AdviceStaleReason | null;
}

/**
 * 计算历史标识。
 *
 * ## 结构性一致性（有测试钉住）
 *
 * - `historyStatus === 'current'` ⟺ `staleReason === null`
 * - 非 `current` 时**必须**给出原因
 *
 * 这条一致性靠返回类型与下面的分支结构保证：**每个分支只可能产出一组合法搭配**，
 * 不可能出现「标记为历史但说不出为什么」。
 */
export const adviceHistoryMark = (input: {
  readonly validUntil: Date;
  readonly dataAsOf: Date;
  readonly now: Date;
  /** 当日的起点（由调用方按业务时区算好，core 不碰时区）。 */
  readonly todayStart: Date;
}): AdviceHistoryMark => {
  // 过期优先：已失效的建议不该被说成「历史但仍可用」。
  if (input.validUntil.getTime() <= input.now.getTime())
    return { historyStatus: 'expired', staleReason: 'valid-until-passed' };
  if (input.dataAsOf.getTime() < input.todayStart.getTime())
    return { historyStatus: 'historical', staleReason: 'data-as-of-before-today' };
  return { historyStatus: 'current', staleReason: null };
};

/**
 * 「引用历史结论**不得当作当前事实**」的可执行断言。
 *
 * 用途：任何把建议内容带进下游推理/建议的路径，都要先过这一关——
 * 非 `current` 的建议**必须**在输出里带上它的 `staleReason`，
 * 否则下游会把它和今天的判断混为一谈。
 */
export const assertNotPresentedAsCurrent = (mark: AdviceHistoryMark): void => {
  if (mark.historyStatus === 'current') return;
  if (mark.staleReason === null)
    throw new Error('历史建议缺少 staleReason：不允许把历史结论当作当前事实');
};
