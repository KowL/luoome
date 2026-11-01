/**
 * 定时派发的**结果分类**（REQ-M4-06 ⑤）。
 *
 * ## 为什么要区分「档位 off」和「非交易日」
 *
 * 两者都是「这次没执行」，但**原因完全不同**：
 * - `tier-off`：用户自己关了自动化 —— 改档位就能跑
 * - `non-trading-day`：今天本来就不开市 —— 改档位也没用，要等下一个交易日
 *
 * 混成一个「没执行」会让排查变猜谜：用户看到「今天没跑」，
 * 不知道是该去开档位，还是该等明天。
 *
 * ## 为什么 `tier-off` 也归入 `skipped` 而不是 `failed`
 *
 * 它不是一个错误——是配置为不跑。`failed` 表示「本该跑但出错了」，
 * 那才会触发告警与重试。
 */
export type DispatchOutcome =
  | { readonly status: 'dispatched' }
  | { readonly status: 'skipped'; readonly reason: DispatchSkipReason };

export type DispatchSkipReason = 'tier-off' | 'non-trading-day';

export const dispatchOutcome = (input: {
  readonly tierAllowsDispatch: boolean;
  readonly isTradingDay: boolean;
}): DispatchOutcome => {
  // 档位优先：用户明确关了自动化，就不该再谈「今天是否交易日」。
  if (!input.tierAllowsDispatch) return { status: 'skipped', reason: 'tier-off' };
  if (!input.isTradingDay) return { status: 'skipped', reason: 'non-trading-day' };
  return { status: 'dispatched' };
};

/** 人话说明：让「没跑」这件事可解释。 */
export const dispatchSkipText = (reason: DispatchSkipReason): string =>
  reason === 'tier-off'
    ? '自动化档位为「关闭」或「仅提醒」，本次不派发；调高档位后即可执行。'
    : '今天不是交易日，本次派发已跳过；下一个交易日会照常执行。';
